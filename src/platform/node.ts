/*
 * Node 侧的绑定：把一台普通机器上的东西变成 `AppEnv`
 *
 * 与 `platform/cloudflare.ts` 是同一个位置的两份实现 —— 业务代码只认
 * `platform/types.ts` 里那几个接口，所以这里**只实现那四样**：
 *
 *   1. `PlatformDb`    → Node 22 内置的 `node:sqlite`（不需要任何原生依赖）
 *   2. `PlatformAssets`→ 直接读 `public/` 目录
 *   3. `PlatformCache` → 一张内存表（够本机自用；边缘那份见 cloudflare 适配器）
 *   4. `ENGINE_VERSION` / `ENABLE_FIXTURE` → 从环境变量读
 *
 * 存在的意义不只是「能跑在别处」：**Workers 免费计划那个 CPU 上限（见 TODO.md 第 1 条）
 * 会把重一点的目录规则掐成 503**，而自建这一条路没有那个上限 —— 这是「换宿主」
 * 那条出路的落点，也是它第一次被真的验证过（`npm run start:node` + 冒烟指过来）。
 *
 * 与 D1 的三处差异都在这一层抹平（业务代码一行都不用改）：
 *
 *   - **`.bind()` 的布尔**：SQLite 没有布尔类型，`node:sqlite` 遇到 `true/false` 直接抛错，
 *     所以统一折成 `1/0`（`undefined` 折成 `null`）
 *   - **`batch()`**：D1 是「一批走一次往返、包在一个事务里」，这里用
 *     `BEGIN` / `COMMIT` / `ROLLBACK` 做出同样的语义 —— 不包事务的话，
 *     「批量导入书源」中途失败会留下半批数据
 *   - **`meta`**：D1 给 `changes` 与 `last_row_id`，这里由 `run()` 的
 *     `changes` / `lastInsertRowid` 顶上
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
    AppEnv,
    PlatformAssets,
    PlatformCache,
    PlatformDb,
    PlatformResult,
    PlatformStatement,
} from './types'

/** 把 JS 值折成 SQLite 认的东西（见文件头三条差异里的第一条） */
function toSqlite(value: unknown): unknown {
    if (value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    return value
}

/**
 * 一条语句
 *
 * `bind()` 返回**新的一份**（与 D1 一致）：同一个 `prepare` 出来的语句会被反复 bind
 * 出多份、并行跑，共享一份可变参数会在 `batch` 里串味。
 */
class NodeStatement implements PlatformStatement {
    constructor(
        private readonly db: DatabaseSync,
        private readonly sql: string,
        private readonly params: unknown[] = [],
    ) {}

    bind(...values: unknown[]): PlatformStatement {
        return new NodeStatement(this.db, this.sql, values.map(toSqlite))
    }

    private prepared() {
        return this.db.prepare(this.sql)
    }

    /**
     * 跑一次，把「查出来的行」与「改了几行」都带上
     *
     * D1 那边 `all()` / `batch()` 的返回是**统一的**：查询给 `results`、写语句给
     * `meta.changes`。而 `node:sqlite` 是两套 API（`all()` 只给行、`run()` 只给改动数），
     * 所以这里按语句种类分派 —— **不能一律走 `all()`**：那会让写语句的
     * `meta.changes` 恒为 0，而 `setSourceEnabled` 正是拿它判「这条源在不在」的
     * （批量启用 / 改密码踢会话都会因此报「找不到书源」/ `revoked=0`，但数据其实改了）。
     *
     * `returning` 那种写法按查询处理：它的行才是调用方要的。
     */
    private execute<T>(): PlatformResult<T> {
        const text = this.sql.trim().toLowerCase()
        const isQuery = /^(?:select|with|pragma|explain)\b/.test(text) || text.includes('returning')
        if (isQuery) {
            return {
                results: this.prepared().all(...(this.params as never[])) as T[],
                success: true,
                meta: { changes: 0, last_row_id: 0 },
            }
        }
        const r = this.prepared().run(...(this.params as never[]))
        return {
            success: true,
            meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
        }
    }

    async first<T = unknown>(colName?: string): Promise<T | null> {
        const row = this.prepared().get(...(this.params as never[])) as
            Record<string, unknown> | undefined
        if (row === undefined) return null
        // D1 的 `first(colName)`：取第一行里那一列的值
        return (colName === undefined ? row : (row[colName] ?? null)) as T
    }

    async run<T = unknown>(): Promise<PlatformResult<T>> {
        const r = this.prepared().run(...(this.params as never[]))
        return {
            success: true,
            meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
        }
    }

    async all<T = unknown>(): Promise<PlatformResult<T>> {
        return this.execute<T>()
    }
}

/** `node:sqlite` 版的 `PlatformDb` */
class NodeDb implements PlatformDb {
    constructor(private readonly db: DatabaseSync) {}

    prepare(query: string): PlatformStatement {
        return new NodeStatement(this.db, query)
    }

    async batch<T = unknown>(statements: PlatformStatement[]): Promise<PlatformResult<T>[]> {
        // 与 D1 一样「要么全成、要么全不成」
        this.db.exec('BEGIN')
        try {
            const out: PlatformResult<T>[] = []
            for (const one of statements) out.push(await one.all<T>())
            this.db.exec('COMMIT')
            return out
        } catch (err) {
            this.db.exec('ROLLBACK')
            throw err
        }
    }

    /** 跑一段**迁移脚本**（`migrations/*.sql` 是一条语句以上的一整段，不是单条 SQL） */
    exec(sql: string): void {
        this.db.exec(sql)
    }

    close(): void {
        this.db.close()
    }
}

/** 扩展名 → content-type。只列前端真的会用到的那些 */
const CONTENT_TYPES: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    webmanifest: 'application/manifest+json; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    txt: 'text/plain; charset=utf-8',
    woff2: 'font/woff2',
}

function contentTypeOf(relative: string): string {
    const ext = relative.split('.').pop()?.toLowerCase() ?? ''
    return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/** `public/` 目录里的静态资源 */
class NodeAssets implements PlatformAssets {
    constructor(private readonly root: string) {}

    async fetch(request: Request): Promise<Response> {
        const pathname = decodeURIComponent(new URL(request.url).pathname)
        const relative = pathname.replace(/^\/+/, '')
        // 不让 `..` 爬出资源目录
        if (relative.split('/').includes('..')) return new Response('Not Found', { status: 404 })
        const body = await readFileOrNull(join(this.root, relative))
        // 找不到文件时**不**在这里回退到 index.html：那是「单页应用」这条路由策略，
        // 属于服务器（见 `src/server/node.ts`）—— 资源层只管把文件发出去
        if (body === null) return new Response('Not Found', { status: 404 })
        return new Response(body, {
            headers: { 'content-type': contentTypeOf(relative), 'cache-control': 'no-cache' },
        })
    }
}

async function readFileOrNull(path: string): Promise<ArrayBuffer | null> {
    try {
        const buf = await readFile(path)
        // 复制成一段独立的 ArrayBuffer：`Buffer` 背后是一个共享的池子，
        // 直接传 `buf.buffer` 会把池子里别人的字节一起发出去
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    } catch {
        return null
    }
}

/** 缓存里的一条：存**字节**，不是存一个 `Response` */
interface CachedEntry {
    body: ArrayBuffer
    status: number
    headers: [string, string][]
}

/**
 * 内存里的那一层缓存
 *
 * 与 Workers 的 `caches.default` 不是一回事（那个按机房、容量有上限），但**接口语义**一样：
 * `put` 把响应体收完存下来，`match` 每次都拿回一份**新的、可读的**响应。
 *
 * **存字节而不是存 `Response`**：Cache API 的 `put` 本身就是把 body 读干净存进去，
 * `match` 出来的是另一份。早先这里图省事存 `response.clone()`，等于把一根**活的流**
 * 留在表里，第二次 `match` 再 `clone()` 就会去克隆一根已经被读过的分支，运行时直接抛
 * `Response.clone: Body has already been consumed.` —— 表现是「第一趟取图正常，
 * 之后同一张图一律 500」。收成字节与平台侧行为一致，也就没有这类分支语义要维护。
 */
class NodeCache implements PlatformCache {
    private readonly store = new Map<string, CachedEntry>()
    private bytes = 0

    async match(request: Request): Promise<Response | undefined> {
        const entry = this.store.get(request.url)
        if (!entry) return undefined
        // 每次都给一份新的：`Response` 的 body 只能读一次，交出去的不能是同一根
        return new Response(entry.body, {
            status: entry.status,
            headers: new Headers(entry.headers),
        })
    }

    async put(request: Request, response: Response): Promise<void> {
        const body = await response.arrayBuffer()
        // 同一个键再存就先把旧的减掉，否则记账会越飘越远
        const old = this.store.get(request.url)
        if (old) this.bytes -= old.body.byteLength
        this.store.set(request.url, {
            body,
            status: response.status,
            headers: [...response.headers],
        })
        this.bytes += body.byteLength
        this.evict()
    }

    /**
     * 内存不能无上限地吃
     *
     * Workers 那侧由平台管配额，自建这侧得自己管 —— 这个进程是长驻的，
     * 一张图 3 MB、跑上一周就是几十 GB。超了就按**插入顺序**丢最老的
     * （`Map` 保持插入序，够用了：没有「刚存进去就被丢掉」的情形，因为单张图远小于上限）。
     */
    private evict(): void {
        while (this.bytes > NODE_CACHE_MAX_BYTES && this.store.size > 0) {
            const oldest = this.store.keys().next()
            if (oldest.done) break
            const gone = this.store.get(oldest.value)
            this.store.delete(oldest.value)
            this.bytes -= gone?.body.byteLength ?? 0
        }
    }
}

/** 内存缓存的总上限。单张图有 3 MB 的上限（见 `lib/mediaCache.ts`），这里给足几百张 */
const NODE_CACHE_MAX_BYTES = 64 * 1024 * 1024

/** 起一个 Node 侧环境的选项 */
export interface NodeEnvOptions {
    /** SQLite 文件路径（默认 `data/reader.sqlite`） */
    dbPath?: string
    /** 静态资源根目录（默认 `public`） */
    publicRoot?: string
    /** 版本号，默认取 `ENGINE_VERSION` 环境变量 */
    engineVersion?: string
    /** 内置测试站点开关，默认取 `ENABLE_FIXTURE` 环境变量 */
    enableFixture?: boolean
}

/** Node 侧的环境：除了 `AppEnv` 那几样，另给两个服务器要用的把手（迁移与关库） */
export interface NodeAppEnv extends AppEnv {
    /** 迁移用：一整段 SQL（`migrations/*.sql`） */
    exec(sql: string): void
    close(): void
}

export function nodeEnv(options: NodeEnvOptions = {}): NodeAppEnv {
    const db = new NodeDb(new DatabaseSync(options.dbPath ?? 'data/reader.sqlite'))
    // WAL：自建这台机器上读写并发好一些
    db.exec('PRAGMA journal_mode = WAL')
    const enableFixture = options.enableFixture ?? process.env.ENABLE_FIXTURE === 'true'
    return {
        DB: db,
        ASSETS: new NodeAssets(options.publicRoot ?? 'public'),
        CACHE: new NodeCache(),
        ENGINE_VERSION: options.engineVersion ?? process.env.ENGINE_VERSION ?? '0.0.0-node',
        ENABLE_FIXTURE: enableFixture ? 'true' : 'false',
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
    }
}
