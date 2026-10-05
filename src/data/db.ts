/**
 * 书源的 D1 读写
 *
 * 这一层只做两件事：把行读成书源对象，把导入的 JSON 安全地写进去。
 * 它不认识「内置书源」也不做 HTTP，策略都在 `sources.ts` 与路由层。
 *
 * 导入是**不可信输入**：书源文件来自社区，可能是坏的、超大、或根本不是书源。
 * 所以这里逐条校验并**逐条报告拒绝原因**，而不是整体成功或整体失败 ——
 * 一份 500 条的书源里坏了两条，用户需要知道是哪两条、为什么。
 */

import type { BookSource } from '../engine/types'
import { dumpJar, parseJar } from '../lib/cookies'
import type { PlatformDb, PlatformStatement } from '../platform/types'
import { BUILTIN_ID_PREFIX, DataError, userIdForUrl, type RegisteredSource } from './types'

/** 单次导入的条数上限。D1 免费版每日写 10 万行，一次塞几十万条会直接把额度打满 */
const MAX_SOURCES_PER_IMPORT = 1000

/** 单条书源 JSON 的大小上限。真实书源是几 KB，超过这个量级基本可以断定不是书源 */
const MAX_PAYLOAD_BYTES = 256 * 1024

const MAX_NAME_LENGTH = 200
const MAX_URL_LENGTH = 512

/**
 * `/api/sources` 的缓存版本号（存在通用键值表 `settings` 里）
 *
 * 任何会改变该接口输出的写入都要 +1 —— 见 `sourcesRevStatement` 与那四处调用点。
 */
const SOURCES_REV_KEY = 'sources_rev'

interface SourceRow {
    id: string
    name: string
    url: string
    group_name: string
    enabled: number
    sort_order: number
    payload: string
    /** 书源变量（Legado 的 `BookSource.variable`），起点是空串，由书源自己填 */
    variable: string
    /** cookie 罐的 JSON（主机名 → cookie 串），只有 enabledCookieJar 的源才写 */
    cookies: string
    /** 登录头（一段 JSON：`{"Cookie":"…"}`）；空串表示没登录 */
    login_header: string
    /** 登录信息（一段自由文本，源自己 JSON.parse 后按键取） */
    login_info: string
}

/**
 * 行 → 书源对象
 *
 * 除了把列盖到 payload 上，还**装上 cookie 罐与它的落库路径** ——
 * 罐子必须在「取网层 / 沙箱 / 落库」三处是同一个对象，而这三处都从书源对象上取，
 * 所以装配点只能是这里（唯一知道 db 与行内容的地方）。
 *
 * 只有 `enabledCookieJar === true` 才建：816 条源里 359 条作者明确关掉了，
 * 给关掉的源也建罐子，等于把它们的 `cookie.*` 从「只活本次求值」悄悄改成跨请求。
 */
function rowToSource(row: SourceRow, db: PlatformDb): RegisteredSource {
    let parsed: BookSource
    try {
        parsed = JSON.parse(row.payload) as BookSource
    } catch {
        // 不静默跳过：少了这一条会让用户以为书源丢了，而原因其实在库里
        throw new DataError(
            `书源 ${row.id} 的存储内容不是合法 JSON，无法解析`,
            500,
            'corrupt_source',
        )
    }
    if (parsed === null || typeof parsed !== 'object') {
        throw new DataError(`书源 ${row.id} 的存储内容不是对象`, 500, 'corrupt_source')
    }
    const source: RegisteredSource = {
        ...parsed,
        // 身份与本地状态以列为准，payload 只是规则快照
        id: row.id,
        builtin: false,
        bookSourceName: row.name,
        bookSourceGroup: row.group_name === '' ? undefined : row.group_name,
        enabled: row.enabled === 1,
        sortOrder: row.sort_order,
        // 书源变量也以列为准：它是**运行期会被书源自己改**的东西，
        // payload 里那一份是导入时的快照（816 条源里没有一条自带 variable）
        variable: row.variable ?? '',
    }
    if (source.enabledCookieJar === true) {
        const jar = parseJar(row.cookies)
        source.cookieJar = jar
        source.persistCookies = () => saveSourceCookies(db, row.id, dumpJar(jar))
    }
    /**
     * 登录态：两列读进来，并装上落库路径
     *
     * 与 cookie 罐不同，这里**不按开关过滤**：`putLoginHeader` / `putLoginInfo` 是书源
     * 自己调的方法（没有对应的书源字段可判），而登录态本来就是「用户主动做了一次登录」的结果 ——
     * 没登录过时两列都是空串，落库路径也就永远不会被调用。
     */
    source.loginHeader = row.login_header ?? ''
    source.loginInfo = row.login_info ?? ''
    /**
     * 落库前先把新值写回内存里这一份 —— 与 `persistSourceVariable` 同一个道理：
     * **同一次请求里**同一个书源会被求值很多次（登录脚本写完，后面几步立刻要读、要用），
     * 只写库不写内存的话，那几步看到的还是旧值。
     */
    source.persistLogin = (patch: { header?: string; info?: string }) => {
        if (patch.header !== undefined) source.loginHeader = patch.header
        if (patch.info !== undefined) source.loginInfo = patch.info
        return saveSourceLogin(db, row.id, {
            header: source.loginHeader ?? '',
            info: source.loginInfo ?? '',
        })
    }
    return source
}

const SELECT_COLUMNS =
    'id, name, url, group_name, enabled, sort_order, payload, variable, cookies, login_header, login_info'

/** 全部用户书源，按展示顺序 */
export async function listUserSources(db: PlatformDb): Promise<RegisteredSource[]> {
    const { results } = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM sources ORDER BY sort_order, name`)
        .all<SourceRow>()
    return (results ?? []).map((row) => rowToSource(row, db))
}

/**
 * 列表页要的书源摘要
 *
 * 与 `listUserSources` 的差别是**不取 `payload`、也不 `JSON.parse`**：
 * `hasSearch / hasExplore / hasLogin` 三个判据本来要从每条的规则里读
 * （816 条就是 816 次 parse，`/api/sources` 那 27ms 的 CPU 主要花在这里），
 * 现在交给 SQLite 的 `json_extract` 在 **D1 侧**算完再回来 —— D1 的查询 CPU
 * 不计入 Worker 那 10ms 预算，Worker 侧只剩「把行读出来并序列化」。
 *
 * `json_valid` 那几处不是多余的：`json_extract` 遇到坏 JSON 会**抛错**，
 * 一条坏数据就能让整个列表 500，而它本来只是「这一条的标记算不出来」。
 */
export interface SourceSummary {
    id: string
    name: string
    group: string
    type: number
    enabled: boolean
    hasSearch: boolean
    hasExplore: boolean
    hasLogin: boolean
    loggedIn: boolean
}

interface SourceSummaryRow {
    id: string
    name: string
    group_name: string
    enabled: number
    type: number
    has_search: number
    has_explore: number
    has_login: number
    logged_in: number
}

export async function listSourceSummaries(db: PlatformDb): Promise<SourceSummary[]> {
    const { results } = await db
        .prepare(
            `SELECT
                 id,
                 name,
                 group_name,
                 enabled,
                 COALESCE(json_extract(payload, '$.bookSourceType'), 0) AS type,
                 CASE WHEN json_valid(payload)
                           AND COALESCE(json_extract(payload, '$.searchUrl'), '') <> ''
                           AND COALESCE(json_extract(payload, '$.ruleSearch.bookList'), '') <> ''
                      THEN 1 ELSE 0 END AS has_search,
                 CASE WHEN json_valid(payload)
                           AND COALESCE(json_extract(payload, '$.exploreUrl'), '') <> ''
                           AND COALESCE(json_extract(payload, '$.ruleExplore.bookList'), '') <> ''
                      THEN 1 ELSE 0 END AS has_explore,
                 CASE WHEN json_valid(payload)
                           AND COALESCE(TRIM(json_extract(payload, '$.loginUrl')), '') <> ''
                      THEN 1 ELSE 0 END AS has_login,
                 CASE WHEN COALESCE(login_header, '') <> '' OR COALESCE(login_info, '') <> ''
                      THEN 1 ELSE 0 END AS logged_in
             FROM sources
             ORDER BY sort_order, name`,
        )
        .all<SourceSummaryRow>()
    return (results ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        group: row.group_name ?? '',
        type: row.type ?? 0,
        enabled: row.enabled === 1,
        hasSearch: row.has_search === 1,
        hasExplore: row.has_explore === 1,
        hasLogin: row.has_login === 1,
        loggedIn: row.logged_in === 1,
    }))
}

/**
 * 让 `/api/sources` 的 ETag 换一代
 *
 * 返回一条**待提交的语句**而不是立刻执行：它要跟着数据改动进同一个 `batch`。
 * 分开写会留下「数据已改、版本号未变」的窗口，那期间浏览器拿到的 304 是过期的。
 * 自增放在 SQL 里做（而不是读出来 +1 再写回），并发写才不会互相覆盖。
 */
function sourcesRevStatement(db: PlatformDb): PlatformStatement {
    return db
        .prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)
             ON CONFLICT(key) DO UPDATE SET
                 value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT),
                 updated_at = excluded.updated_at`,
        )
        .bind(SOURCES_REV_KEY, Date.now())
}

/** 当前版本号；从没写过时是 `'0'`（与第一次 bump 之后的 `'1'` 区分得开） */
export async function readSourcesRev(db: PlatformDb): Promise<string> {
    const row = await db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .bind(SOURCES_REV_KEY)
        .first<{ value: string }>()
    return row?.value ?? '0'
}

/** 单个用户书源；不存在返回 undefined（与「读取出错」区分开） */
export async function getUserSource(
    db: PlatformDb,
    id: string,
): Promise<RegisteredSource | undefined> {
    const row = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM sources WHERE id = ?`)
        .bind(id)
        .first<SourceRow>()
    return row ? rowToSource(row, db) : undefined
}

/**
 * 启用书源里、按「健康度」排好序的一页
 *
 * 搜索用这个，而不是把全部书源都读出来：
 * - `LIMIT/OFFSET` 让每个请求**只解析这一页**的规则（594 条全读出来是 4.5 MB JSON，
 *   单是解析这一步就可能吃掉免费计划那 10 ms 的 CPU 预算）
 * - 排序把「连续失败 5 次以上」的源放到最后 —— 额度先花在还活着的源上，
 *   但它们**不会被永久跳过**（网络抖一下不该让一个源永远出局）
 *
 * 排序里 `(last_ok_at = 0)` 这一项是**正信号**，别删：光按 `fail_streak` 排的话，
 * 线上 816 个源里有 810 个是「从没搜过」（两个计数都是 0），排序就退化成了导入顺序 ——
 * 用户点「继续加载」只是在同一个角落里按源名往下翻，好的源（真的搜到过书的那几个）
 * 混在中间，翻很久也碰不到。把「搜到过书的」提到没试过的前面，第一页就有结果。
 * 组内再按最近成功倒序：刚验证过还能用的排最前。
 */
export async function listUserSourcePage(
    db: PlatformDb,
    offset: number,
    limit: number,
): Promise<RegisteredSource[]> {
    const { results } = await db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM sources
             WHERE enabled = 1
             ORDER BY (fail_streak >= 5), (last_ok_at = 0), fail_streak, last_ok_at DESC, sort_order, name
             LIMIT ? OFFSET ?`,
        )
        .bind(limit, offset)
        .all<SourceRow>()
    return (results ?? []).map((row) => rowToSource(row, db))
}

/** 按 id 批量取用户书源（只读点到的这几条，不碰整张表） */
export async function listUserSourcesByIds(
    db: PlatformDb,
    ids: string[],
): Promise<RegisteredSource[]> {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const { results } = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM sources WHERE id IN (${placeholders})`)
        .bind(...ids)
        .all<SourceRow>()
    return (results ?? []).map((row) => rowToSource(row, db))
}

/** 启用的用户书源总数（分页要让界面知道「还有多少个没搜」） */
export async function countEnabledSources(db: PlatformDb): Promise<number> {
    const row = await db
        .prepare('SELECT COUNT(*) AS n FROM sources WHERE enabled = 1')
        .first<{ n: number }>()
    return row?.n ?? 0
}

/**
 * 一轮搜索之后回写书源健康度
 *
 * 三态而不是两态，因为「没报错但没搜到」**不该算失败** —— 那通常只是关键词
 * 不匹配，把它记成失败会让好源被一路排到最后：
 * - `ok`（搜到了书）：记下时间、连续失败清零
 * - `fail`（报错/超时/被掐）：连续失败 +1
 * - `idle`（没报错也没结果）：什么都不动
 *
 * 只写这几个源，一条 `batch` 就够（D1 一次往返）。
 */
export type SourceOutcome = 'ok' | 'fail' | 'idle'

export async function recordSourceHealth(
    db: PlatformDb,
    outcomes: { id: string; outcome: SourceOutcome }[],
): Promise<void> {
    const now = Date.now()
    const stmts = outcomes
        .filter((item) => item.outcome !== 'idle' && !item.id.startsWith(BUILTIN_ID_PREFIX))
        .map((item) =>
            item.outcome === 'ok'
                ? db
                      .prepare('UPDATE sources SET last_ok_at = ?, fail_streak = 0 WHERE id = ?')
                      .bind(now, item.id)
                : db
                      .prepare('UPDATE sources SET fail_streak = fail_streak + 1 WHERE id = ?')
                      .bind(item.id),
        )
    if (stmts.length === 0) return
    await db.batch(stmts)
}

export async function countUserSources(db: PlatformDb): Promise<number> {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM sources').first<{ n: number }>()
    return row?.n ?? 0
}

/**
 * 写回书源变量（`source.setVariable(整串)`）
 *
 * 与 `recordSourceHealth` 一样只动一列，但**不批处理**：书源变量是书源自己的状态，
 * 一次请求里通常只改一次，而调用方（`index.ts` 的 `evalContext`）需要**等它写完**
 * ——Worker 的响应一旦返回，还在飞的 promise 会被直接掐掉，那时用户看到的是
 * 「设置成功了」，下次进来却发现没生效。
 *
 * 内置书源不落库（它们是代码的一部分），由调用方过滤，这里不重复判断。
 */
export async function saveSourceVariable(db: PlatformDb, id: string, value: string): Promise<void> {
    await db
        .prepare('UPDATE sources SET variable = ?, updated_at = ? WHERE id = ?')
        .bind(value, Date.now(), id)
        .run()
}

/**
 * 写回 cookie 罐（`sources.cookies`）
 *
 * 与 `saveSourceVariable` 同一条路数、同样的理由：请求一返回，还在飞的 promise 会被掐掉。
 * 区别在**调用时机** —— 这个是「罐子真的变了」才调（取网层收完 `Set-Cookie`、
 * 或沙箱里的 `cookie.setCookie` 之后），所以一次请求通常只写一次，甚至一次都不写。
 */
export async function saveSourceCookies(db: PlatformDb, id: string, value: string): Promise<void> {
    await db
        .prepare('UPDATE sources SET cookies = ?, updated_at = ? WHERE id = ?')
        .bind(value, Date.now(), id)
        .run()
}

/**
 * 写回登录态（`sources.login_header` / `login_info`）
 *
 * 两列一起写：它们是一起产生、一起失效的（登录成功时两样都有），分两次 UPDATE
 * 只会多一次往返。与另外两处落库同理，调用方要 `await` —— 请求一返回，
 * 还在飞的 promise 会被掐掉，那时用户看到的是「登录成功了」，下次进来却发现没生效。
 */
export async function saveSourceLogin(
    db: PlatformDb,
    id: string,
    value: { header: string; info: string },
): Promise<void> {
    await db.batch([
        db
            .prepare(
                'UPDATE sources SET login_header = ?, login_info = ?, updated_at = ? WHERE id = ?',
            )
            .bind(value.header, value.info, Date.now(), id),
        sourcesRevStatement(db),
    ])
}

export interface RejectedSource {
    name: string
    reason: string
}

export interface ImportReport {
    /** 新插入的条数 */
    imported: number
    /** 已存在、只刷新了规则的条数 */
    updated: number
    /** 被拒绝的条目及原因 */
    rejected: RejectedSource[]
}

/**
 * 校验一条待导入的书源。返回规范化后的结果，或一条拒绝原因。
 *
 * 这里**只校验导入所必需的字段**（名字、地址）以及大小上限。
 * 规则写错与否是运行期的事，导入期就判「规则是否有效」需要把每条规则都跑一遍，
 * 代价高且误报多 —— 宁可先收下，让它在搜索时按书源粒度报错。
 *
 * 导出是为了能直接做单元测试：这是「不可信输入」的边界，边界上的判断值得逐条钉住。
 */
export function validateImportedSource(
    raw: unknown,
    index: number,
):
    | { ok: true; source: BookSource; name: string; url: string }
    | { ok: false; rejected: RejectedSource } {
    const label = (name: string): string => (name === '' ? `第 ${index + 1} 条` : name)

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, rejected: { name: `第 ${index + 1} 条`, reason: '不是对象' } }
    }

    const candidate = raw as Record<string, unknown>
    const name = typeof candidate.bookSourceName === 'string' ? candidate.bookSourceName.trim() : ''
    const url = typeof candidate.bookSourceUrl === 'string' ? candidate.bookSourceUrl.trim() : ''

    if (name === '') {
        return { ok: false, rejected: { name: label(name), reason: '缺少 bookSourceName' } }
    }
    if (url === '') {
        return { ok: false, rejected: { name: label(name), reason: '缺少 bookSourceUrl' } }
    }
    if (name.length > MAX_NAME_LENGTH) {
        return {
            ok: false,
            rejected: {
                name: name.slice(0, 40),
                reason: `bookSourceName 超过 ${MAX_NAME_LENGTH} 字符`,
            },
        }
    }
    if (url.length > MAX_URL_LENGTH) {
        return {
            ok: false,
            rejected: { name, reason: `bookSourceUrl 超过 ${MAX_URL_LENGTH} 字符` },
        }
    }

    let parsedUrl: URL
    try {
        parsedUrl = new URL(url)
    } catch {
        return { ok: false, rejected: { name, reason: `bookSourceUrl 不是合法地址：${url}` } }
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return {
            ok: false,
            rejected: {
                name,
                reason: `bookSourceUrl 只支持 http/https，实际是 ${parsedUrl.protocol}`,
            },
        }
    }

    const bytes = new TextEncoder().encode(JSON.stringify(candidate)).length
    if (bytes > MAX_PAYLOAD_BYTES) {
        return {
            ok: false,
            rejected: {
                name,
                reason: `单条书源 ${Math.round(bytes / 1024)} KB，超过上限 ${MAX_PAYLOAD_BYTES / 1024} KB`,
            },
        }
    }

    return { ok: true, source: raw as BookSource, name, url }
}

/** 从导入内容里取出书源数组，兼容裸数组与 `{ "sources": [...] }` */
export function parseImportPayload(text: string): unknown[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (err) {
        throw new DataError(
            `导入内容不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
            400,
            'invalid_json',
        )
    }

    const list = Array.isArray(parsed)
        ? parsed
        : parsed !== null &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as { sources?: unknown }).sources)
          ? (parsed as { sources: unknown[] }).sources
          : null

    if (list === null) {
        throw new DataError(
            '导入内容必须是书源数组，或形如 {"sources":[...]} 的对象',
            400,
            'invalid_shape',
        )
    }
    return list
}

/**
 * 导入书源
 *
 * 同名（同 bookSourceUrl）视为「刷新规则」：只覆盖 payload，
 * 保留用户本地的名字、分组与启用状态 —— 重新导入一次不该把停用过的书源又叫醒。
 */
export async function importSources(db: PlatformDb, text: string): Promise<ImportReport> {
    const list = parseImportPayload(text)
    if (list.length === 0) {
        throw new DataError('导入内容里没有任何书源', 400, 'empty_import')
    }
    if (list.length > MAX_SOURCES_PER_IMPORT) {
        throw new DataError(
            `一次最多导入 ${MAX_SOURCES_PER_IMPORT} 条，本次 ${list.length} 条`,
            413,
            'too_many_sources',
        )
    }

    const existingRows = await db.prepare('SELECT id FROM sources').all<{ id: string }>()
    const existing = new Set((existingRows.results ?? []).map((r) => r.id))

    const rejected: RejectedSource[] = []
    const statements: PlatformStatement[] = []
    const now = Date.now()
    let imported = 0
    let updated = 0
    const seenInBatch = new Set<string>()

    list.forEach((raw, index) => {
        const result = validateImportedSource(raw, index)
        if (!result.ok) {
            rejected.push(result.rejected)
            return
        }

        const id = userIdForUrl(result.url)
        if (seenInBatch.has(id)) {
            rejected.push({ name: result.name, reason: '同一批导入里地址重复，已跳过后出现的' })
            return
        }
        seenInBatch.add(id)

        const isNew = !existing.has(id)
        if (isNew) imported += 1
        else updated += 1

        statements.push(
            db
                .prepare(
                    `INSERT INTO sources
                         (id, name, url, group_name, enabled, builtin, sort_order, payload, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET
                         payload = excluded.payload,
                         updated_at = excluded.updated_at`,
                )
                .bind(
                    id,
                    result.name,
                    result.url,
                    typeof result.source.bookSourceGroup === 'string'
                        ? result.source.bookSourceGroup
                        : '',
                    result.source.enabled === false ? 0 : 1,
                    index,
                    JSON.stringify(result.source),
                    now,
                    now,
                ),
        )
    })

    // 版本号跟数据改动同一次 batch 提交：分开写会留下「数据已改、ETag 还没变」的窗口
    if (statements.length > 0) await db.batch([...statements, sourcesRevStatement(db)])

    return { imported, updated, rejected }
}

/** 停用 / 启用。内置源由代码管理，不能在这里改 */
export async function setSourceEnabled(
    db: PlatformDb,
    id: string,
    enabled: boolean,
): Promise<void> {
    assertUserSource(id)
    const [result] = await db.batch([
        db
            .prepare('UPDATE sources SET enabled = ?, updated_at = ? WHERE id = ?')
            .bind(enabled ? 1 : 0, Date.now(), id),
        sourcesRevStatement(db),
    ])
    if ((result?.meta.changes ?? 0) === 0) {
        throw new DataError(`找不到书源：${id}`, 404, 'source_not_found')
    }
}

/**
 * 一次批量改启用状态最多带几个 id
 *
 * D1 对**单条语句的绑定参数**有个数上限（100），而这条 SQL 除了 id 还要绑
 * `enabled` 与 `updated_at`，所以留出余量。语料里最大的分组是 242 条 ——
 * 分成三批发，而不是让整整一批回一个参数超限的错。
 */
const SOURCE_ID_BATCH = 90

/**
 * 批量启用 / 停用
 *
 * 为什么要有它：「按分组停用」是真实需求 —— 816 条书源里挑几条启用，
 * 总得有个一次勾掉一整组的办法，一条一条点不是个事（真的点起来是几百次请求）。
 *
 * 两个细节：
 *
 * 1. **内置源先剔掉**，而不是碰上了就整批报错。`assertUserSource` 会抛，
 *    而一条只读的 id 足以把同批里另外 89 条一起拖下水 —— 这里改「过滤」。
 *    剔完一条不剩时返回 0，语义是「这批里没有可改的」，不是出错。
 * 2. 每批都带上版本号自增，与 `setSourceEnabled` 一样：数据改了而 ETag 没变，
 *    浏览器会抱着 304 里那份旧列表不放。
 *
 * 返回值是**实际改动的行数**给调用方回显（它可能小于 id 个数：不存在的 id 不算）。
 */
export async function setSourcesEnabled(
    db: PlatformDb,
    ids: string[],
    enabled: boolean,
): Promise<number> {
    const usable = [
        ...new Set(
            (Array.isArray(ids) ? ids : []).filter(
                (id) => typeof id === 'string' && id !== '' && !id.startsWith(BUILTIN_ID_PREFIX),
            ),
        ),
    ]
    if (usable.length === 0) return 0

    const now = Date.now()
    let changed = 0
    for (let start = 0; start < usable.length; start += SOURCE_ID_BATCH) {
        const slice = usable.slice(start, start + SOURCE_ID_BATCH)
        const holes = slice.map(() => '?').join(', ')
        const [result] = await db.batch([
            db
                .prepare(`UPDATE sources SET enabled = ?, updated_at = ? WHERE id IN (${holes})`)
                .bind(enabled ? 1 : 0, now, ...slice),
            sourcesRevStatement(db),
        ])
        changed += result?.meta.changes ?? 0
    }
    return changed
}

/** 删除一个用户书源。内置源由代码管理，不能在这里删 */
export async function deleteUserSource(db: PlatformDb, id: string): Promise<void> {
    assertUserSource(id)
    const [result] = await db.batch([
        db.prepare('DELETE FROM sources WHERE id = ?').bind(id),
        sourcesRevStatement(db),
    ])
    if ((result?.meta.changes ?? 0) === 0) {
        throw new DataError(`找不到书源：${id}`, 404, 'source_not_found')
    }
}

function assertUserSource(id: string): void {
    if (id.startsWith(BUILTIN_ID_PREFIX)) {
        throw new DataError(`${id} 是内置书源，不能修改或删除`, 400, 'builtin_readonly')
    }
    if (!id.startsWith('user:')) {
        throw new DataError(`书源 id 格式不对：${id}`, 400, 'invalid_source_id')
    }
}
