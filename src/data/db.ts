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
import { BUILTIN_ID_PREFIX, DataError, userIdForUrl, type RegisteredSource } from './types'

/** 单次导入的条数上限。D1 免费版每日写 10 万行，一次塞几十万条会直接把额度打满 */
const MAX_SOURCES_PER_IMPORT = 1000

/** 单条书源 JSON 的大小上限。真实书源是几 KB，超过这个量级基本可以断定不是书源 */
const MAX_PAYLOAD_BYTES = 256 * 1024

const MAX_NAME_LENGTH = 200
const MAX_URL_LENGTH = 512

interface SourceRow {
    id: string
    name: string
    url: string
    group_name: string
    enabled: number
    sort_order: number
    payload: string
}

function rowToSource(row: SourceRow): RegisteredSource {
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
    return {
        ...parsed,
        // 身份与本地状态以列为准，payload 只是规则快照
        id: row.id,
        builtin: false,
        bookSourceName: row.name,
        bookSourceGroup: row.group_name === '' ? undefined : row.group_name,
        enabled: row.enabled === 1,
        sortOrder: row.sort_order,
    }
}

const SELECT_COLUMNS = 'id, name, url, group_name, enabled, sort_order, payload'

/** 全部用户书源，按展示顺序 */
export async function listUserSources(db: D1Database): Promise<RegisteredSource[]> {
    const { results } = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM sources ORDER BY sort_order, name`)
        .all<SourceRow>()
    return (results ?? []).map(rowToSource)
}

/** 单个用户书源；不存在返回 undefined（与「读取出错」区分开） */
export async function getUserSource(
    db: D1Database,
    id: string,
): Promise<RegisteredSource | undefined> {
    const row = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM sources WHERE id = ?`)
        .bind(id)
        .first<SourceRow>()
    return row ? rowToSource(row) : undefined
}

/**
 * 启用书源里、按「健康度」排好序的一页
 *
 * 搜索用这个，而不是把全部书源都读出来：
 * - `LIMIT/OFFSET` 让每个请求**只解析这一页**的规则（594 条全读出来是 4.5 MB JSON，
 *   单是解析这一步就可能吃掉免费计划那 10 ms 的 CPU 预算）
 * - 排序把「连续失败 5 次以上」的源放到最后 —— 额度先花在还活着的源上，
 *   但它们**不会被永久跳过**（网络抖一下不该让一个源永远出局）
 */
export async function listUserSourcePage(
    db: D1Database,
    offset: number,
    limit: number,
): Promise<RegisteredSource[]> {
    const { results } = await db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM sources
             WHERE enabled = 1
             ORDER BY (fail_streak >= 5), fail_streak, sort_order, name
             LIMIT ? OFFSET ?`,
        )
        .bind(limit, offset)
        .all<SourceRow>()
    return (results ?? []).map(rowToSource)
}

/** 按 id 批量取用户书源（只读点到的这几条，不碰整张表） */
export async function listUserSourcesByIds(
    db: D1Database,
    ids: string[],
): Promise<RegisteredSource[]> {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const { results } = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM sources WHERE id IN (${placeholders})`)
        .bind(...ids)
        .all<SourceRow>()
    return (results ?? []).map(rowToSource)
}

/** 启用的用户书源总数（分页要让界面知道「还有多少个没搜」） */
export async function countEnabledSources(db: D1Database): Promise<number> {
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
    db: D1Database,
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

export async function countUserSources(db: D1Database): Promise<number> {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM sources').first<{ n: number }>()
    return row?.n ?? 0
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
export async function importSources(db: D1Database, text: string): Promise<ImportReport> {
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
    const statements: D1PreparedStatement[] = []
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

    if (statements.length > 0) await db.batch(statements)

    return { imported, updated, rejected }
}

/** 停用 / 启用。内置源由代码管理，不能在这里改 */
export async function setSourceEnabled(
    db: D1Database,
    id: string,
    enabled: boolean,
): Promise<void> {
    assertUserSource(id)
    const result = await db
        .prepare('UPDATE sources SET enabled = ?, updated_at = ? WHERE id = ?')
        .bind(enabled ? 1 : 0, Date.now(), id)
        .run()
    if (result.meta.changes === 0) {
        throw new DataError(`找不到书源：${id}`, 404, 'source_not_found')
    }
}

export async function deleteUserSource(db: D1Database, id: string): Promise<void> {
    assertUserSource(id)
    const result = await db.prepare('DELETE FROM sources WHERE id = ?').bind(id).run()
    if (result.meta.changes === 0) {
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
