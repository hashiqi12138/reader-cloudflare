/*
 * 自建入口：把项目跑在一台普通的 Node 上
 *
 * 为什么要有它
 * ------------
 * 部署在 Workers 免费计划上时，**每个请求的 CPU 有个很低的上限**，重一点的规则
 * （比如一次求值要解析上百次 HTML 的那种目录规则）会被平台直接掐成 503
 * （见 TODO.md 第 1 条）。项目从第五十五轮起就把「跑在哪」收敛成了一层接口
 * （`src/platform/`），这个文件就是那层接口的**第二份实现**，也是那条出路的落点：
 *
 *     node --experimental-strip-types src/server/node.ts   # 开发
 *     npm run build:node && node dist-node/server.mjs      # 打完包再跑
 *
 * 这里只做**三件事**，业务一行都不碰：
 *
 *   1. 建库、跑迁移（`migrations/*.sql`，用一个自己的 `_migrations` 表记住跑过哪些）
 *   2. 把 Node 的 `http` 请求翻译成 Web `Request`，把 `Response` 写回去
 *   3. 补上 Cloudflare 那边由配置给的**路由策略**：`/api/*` 与 `/fixture/*` 进应用，
 *      其余当静态资源发；找不到文件就回退 `index.html`（单页应用）
 *
 * 与 Workers 的唯一行为差异是 `waitUntil`：那边是「响应之后接着跑」，这边做成了
 * **发响应之前等它落地** —— 本机跑没有那个「请求结束就掐掉 Promise」的问题，
 * 而等它落地让「存了缓存」这件事对紧接着的下一个请求是确定的（冒烟的媒体缓存那几条
 * 正是这么断言的）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { handleRequest } from '../index'
import { nodeEnv, type NodeAppEnv } from '../platform/node'

/** 进应用（而不是当静态资源）的路径前缀 —— 与 wrangler.jsonc 的 `run_worker_first` 保持一致 */
const WORKER_PREFIXES = ['/api/', '/fixture/']
/** SQLite 文件 */
const DB_PATH = process.env.DB_PATH ?? 'data/reader.sqlite'
/** 监听端口 */
const PORT = Number(process.env.PORT ?? 8787)

/**
 * 找一个「跑得起来」的目录
 *
 * 同一个入口有两种跑法 —— 打包后（`dist-node/server.mjs`，旁边放着 `migrations/`、`public/`）
 * 与从仓库根直接跑 —— 两者的相对位置不同，所以按候选顺序找**存在的那一个**，
 * 而不是把路径写死（写死的话换一种跑法就会在启动那一刻报「目录不存在」）。
 */
function dirOf(name: string, fromEnv: string | undefined): string {
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [
        fromEnv,
        join(here, name),
        join(here, '..', name),
        join(here, '..', '..', name),
        join(process.cwd(), name),
    ].filter((one): one is string => typeof one === 'string' && one !== '')
    for (const one of candidates) if (existsSync(one)) return one
    throw new Error(`找不到 ${name} 目录（候选：${candidates.join(' | ')}）`)
}

/**
 * 跑迁移
 *
 * 用一个自己的表记「跑过哪些」，因为 D1 那套迁移记录只存在于 Cloudflare 侧。
 * 每个文件包在一个事务里：`migrations/*.sql` 里有 `ALTER TABLE` 与 `INSERT` 混着的，
 * 中途失败留下半截 schema 比直接报错更难收拾。
 */
async function migrate(env: NodeAppEnv, dir: string): Promise<void> {
    env.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)')
    const done = new Set<string>()
    const rows = await env.DB.prepare('SELECT name FROM _migrations').all<{ name: string }>()
    for (const row of rows.results ?? []) done.add(String(row.name))

    const files = readdirSync(dir)
        .filter((one) => one.endsWith('.sql'))
        .sort()
    let applied = 0
    for (const file of files) {
        if (done.has(file)) continue
        env.exec('BEGIN')
        try {
            env.exec(readFileSync(join(dir, file), 'utf8'))
            env.DB.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
                .bind(file, Date.now())
                .run()
            env.exec('COMMIT')
            applied += 1
        } catch (err) {
            env.exec('ROLLBACK')
            throw new Error(
                `迁移 ${file} 失败：${err instanceof Error ? err.message : String(err)}`,
            )
        }
    }
    console.log(`迁移：${files.length} 个文件，本次新跑 ${applied} 个`)
}

/** Node 的 `IncomingMessage` → Web `Request` */
async function toWebRequest(req: IncomingMessage, origin: string): Promise<Request> {
    const url = new URL(req.url ?? '/', origin)
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value)
        else if (Array.isArray(value)) for (const one of value) headers.append(key, one)
    }
    const method = req.method ?? 'GET'
    if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers })
    // 请求体一次性读进来（本项目的接口都是小 JSON / 表单，不是大文件上传）
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    return new Request(url, { method, headers, body: body.length > 0 ? body : undefined })
}

/** Web `Response` → 写回 Node 的响应 */
async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
    const headers: Record<string, string | string[]> = {}
    response.headers.forEach((value, key) => {
        // `set-cookie` 在 Fetch 里是多个值，得单独收集（普通遍历会把它拼成一条）
        if (key === 'set-cookie') {
            const all = response.headers.getSetCookie?.() ?? [value]
            headers['set-cookie'] = all
            return
        }
        headers[key] = value
    })
    res.writeHead(response.status, headers)
    if (response.body === null) {
        res.end()
        return
    }
    const buf = Buffer.from(await response.arrayBuffer())
    res.end(buf)
}

/**
 * 版本号
 *
 * 优先 `ENGINE_VERSION` 环境变量；没给就从 `package.json` 里读 —— 界面「关于」页与
 * `/api/version` 都拿它当版本号，而冒烟会断言「更新记录里最新一条与版本号一致」，
 * 随手写一个假版本号（比如 `0.0.0-node`）在那条断言上会红。
 */
function versionOf(): string {
    if (process.env.ENGINE_VERSION) return process.env.ENGINE_VERSION
    const here = dirname(fileURLToPath(import.meta.url))
    for (const one of [
        join(here, 'package.json'),
        join(here, '..', 'package.json'),
        'package.json',
    ]) {
        try {
            // 去掉 BOM：本仓库的 package.json 带 BOM，直接 JSON.parse 会抛错
            const text = readFileSync(one, 'utf8').replace(/^\uFEFF/, '')
            const parsed = JSON.parse(text) as { version?: string }
            if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
        } catch {
            /* 找不到就试下一个 */
        }
    }
    return '0.0.0-node'
}

async function main(): Promise<void> {
    mkdirSync(dirname(DB_PATH), { recursive: true })
    const publicRoot = dirOf('public', process.env.PUBLIC_ROOT)
    const env = nodeEnv({ dbPath: DB_PATH, publicRoot, engineVersion: versionOf() })
    await migrate(env, dirOf('migrations', process.env.MIGRATIONS_DIR))

    const server = createServer((req, res) => {
        void (async () => {
            /**
             * `waitUntil` 的替身：把 Promise 收起来，**发响应之前**一起等掉。
             * 于是「响应已经回来了、缓存还没写完」这种时序在本机不存在（见文件头）。
             */
            const pending: Promise<unknown>[] = []
            const ctx = {
                waitUntil: (promise: Promise<unknown>) => {
                    pending.push(Promise.resolve(promise).catch(() => undefined))
                },
                passThroughOnException: () => undefined,
            }
            const origin = `http://${req.headers.host ?? `127.0.0.1:${PORT}`}`
            try {
                const request = await toWebRequest(req, origin)
                const path = new URL(request.url).pathname
                const isWorkerPath = WORKER_PREFIXES.some((prefix) => path.startsWith(prefix))
                let response: Response
                if (isWorkerPath) {
                    response = await handleRequest(request, env, ctx)
                } else {
                    response = await env.ASSETS.fetch(request)
                    // 找不到就回退 index.html —— 与 wrangler.jsonc 的
                    // `not_found_handling: single-page-application` 同一条策略
                    if (response.status === 404) {
                        response = await env.ASSETS.fetch(
                            new Request(new URL('/index.html', origin)),
                        )
                    }
                }
                await Promise.all(pending)
                await writeWebResponse(res, response)
            } catch (err) {
                await Promise.all(pending)
                const message = err instanceof Error ? err.message : String(err)
                console.error('请求失败：', message)
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: message }))
            }
        })()
    })

    server.listen(PORT, () => {
        console.log(`reader-cloudflare 自建模式：http://127.0.0.1:${PORT}`)
        console.log(
            `  数据库 ${DB_PATH} · 静态资源 ${publicRoot} · 版本 ${env.ENGINE_VERSION ?? '?'}`,
        )
        console.log(
            `  内置测试站点 ${env.ENABLE_FIXTURE === 'true' ? '开' : '关'}（ENABLE_FIXTURE 控制）`,
        )
    })

    const shutdown = () => {
        server.close()
        env.close()
        process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}

await main()
