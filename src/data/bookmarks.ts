/**
 * 书签的 D1 读写
 *
 * 与 `library.ts`（书架 + 阅读进度）分开成两个文件，但共用同一套隔离方式：
 * 每条查询都必须带 `owner`（来自已校验的身份，见 lib/identity.ts）。
 * 书签比进度「重」一些 —— 一条进度只记当前位置，书签是长期积累的个人数据，
 * 所以位置信息记得更细（页 + 百分比 + 正文摘录），删改也各自独立。
 *
 * 这里不做「同一位置只能有一条书签」的去重。理由与 Legado 一致：
 * 书签的语义是「我在这里留了个标记」，重复标记是用户的选择；
 * 真正需要判断「这一页有没有书签」的是前端（它手里已经有整本书的书签列表），
 * 在服务端用浮点位置去比对既不可靠，也会让「同一页留两处备注」这种用法没法表达。
 */

import type { PlatformDb } from '../platform/types'
import { DataError, bookKey } from './types'

/** 章节名上限。目录名一般是几十个字，超过这个量级的多半是源把整段正文塞进来了 */
const MAX_CHAPTER_NAME = 200
const MAX_URL = 2048
/** 摘录与备注都只用于展示，长度上限取得比正文小得多 */
const MAX_EXCERPT = 120
const MAX_NOTE = 500

export interface Bookmark {
    id: string
    bookKey: string
    sourceId: string
    bookUrl: string
    chapterUrl: string
    chapterName: string
    chapterIndex: number
    pageIndex: number
    /** 滚动阅读时的位置，0～1；翻页模式恒为 0 */
    percent: number
    excerpt: string
    note: string
    createdAt: number
    updatedAt: number
}

interface BookmarkRow {
    id: string
    book_key: string
    source_id: string
    book_url: string
    chapter_url: string
    chapter_name: string
    chapter_index: number
    page_index: number
    percent: number
    excerpt: string
    note: string
    created_at: number
    updated_at: number
}

function rowToBookmark(row: BookmarkRow): Bookmark {
    return {
        id: row.id,
        bookKey: row.book_key,
        sourceId: row.source_id,
        bookUrl: row.book_url,
        chapterUrl: row.chapter_url,
        chapterName: row.chapter_name,
        chapterIndex: row.chapter_index,
        pageIndex: row.page_index,
        percent: row.percent,
        excerpt: row.excerpt,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

const SELECT_COLUMNS = `id, book_key, source_id, book_url, chapter_url, chapter_name,
                        chapter_index, page_index, percent, excerpt, note,
                        created_at, updated_at`

export interface BookmarkInput {
    sourceId?: unknown
    bookUrl?: unknown
    chapterUrl?: unknown
    chapterName?: unknown
    chapterIndex?: unknown
    pageIndex?: unknown
    percent?: unknown
    excerpt?: unknown
    note?: unknown
}

export interface NormalizedBookmarkInput {
    sourceId: string
    bookUrl: string
    chapterUrl: string
    chapterName: string
    chapterIndex: number
    pageIndex: number
    percent: number
    excerpt: string
    note: string
}

function requireText(value: unknown, field: string, max: number): string {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') throw new DataError(`缺少 ${field}`, 400, 'invalid_bookmark_input')
    if (text.length > max) {
        throw new DataError(`${field} 超过 ${max} 字符`, 400, 'invalid_bookmark_input')
    }
    return text
}

/** 可选文本：超长就截断而不是报错 —— 摘录与备注来自正文，长度不是用户能控制的 */
function optionalText(value: unknown, max: number): string {
    const text = typeof value === 'string' ? value.trim() : ''
    return text.length > max ? text.slice(0, max) : text
}

function optionalCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function optionalRatio(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0
    return Math.min(1, Math.max(0, value))
}

/**
 * 把一次「加书签」的输入收敛成入库形状。
 *
 * 导出是为了能直接做单元测试：这是不可信输入进入库之前的最后一道关口，
 * 而它全部是纯计算 —— 不需要 D1 就能把边界钉住（越界、超长、类型不对）。
 */
export function normalizeBookmarkInput(input: BookmarkInput): NormalizedBookmarkInput {
    return {
        sourceId: requireText(input.sourceId, 'sourceId', MAX_URL),
        bookUrl: requireText(input.bookUrl, 'bookUrl', MAX_URL),
        chapterUrl: requireText(input.chapterUrl, 'chapterUrl', MAX_URL),
        chapterName: optionalText(input.chapterName, MAX_CHAPTER_NAME),
        chapterIndex: optionalCount(input.chapterIndex),
        pageIndex: optionalCount(input.pageIndex),
        percent: optionalRatio(input.percent),
        excerpt: optionalText(input.excerpt, MAX_EXCERPT),
        note: optionalText(input.note, MAX_NOTE),
    }
}

/** 一本书的全部书签，按章节顺序、再按页顺序 */
export async function listBookmarks(
    db: PlatformDb,
    owner: string,
    key: string,
): Promise<Bookmark[]> {
    const { results } = await db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM bookmarks
              WHERE owner = ? AND book_key = ?
              ORDER BY chapter_index, page_index, created_at`,
        )
        .bind(owner, key)
        .all<BookmarkRow>()
    return (results ?? []).map(rowToBookmark)
}

export async function getBookmark(
    db: PlatformDb,
    owner: string,
    id: string,
): Promise<Bookmark | undefined> {
    const row = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM bookmarks WHERE owner = ? AND id = ?`)
        .bind(owner, id)
        .first<BookmarkRow>()
    return row ? rowToBookmark(row) : undefined
}

export async function addBookmark(
    db: PlatformDb,
    owner: string,
    input: BookmarkInput,
): Promise<Bookmark> {
    const data = normalizeBookmarkInput(input)
    const key = bookKey(data.sourceId, data.bookUrl)
    const id = crypto.randomUUID()
    const now = Date.now()

    await db
        .prepare(
            `INSERT INTO bookmarks
                 (id, owner, book_key, source_id, book_url, chapter_url, chapter_name,
                  chapter_index, page_index, percent, excerpt, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
            id,
            owner,
            key,
            data.sourceId,
            data.bookUrl,
            data.chapterUrl,
            data.chapterName,
            data.chapterIndex,
            data.pageIndex,
            data.percent,
            data.excerpt,
            data.note,
            now,
            now,
        )
        .run()

    const created = await getBookmark(db, owner, id)
    // 写进去了却读不出来 = 存储层出了问题，不能当成「加好了」返回
    if (!created) throw new DataError('写入书签后读不回这条记录', 500, 'bookmark_write_failed')
    return created
}

/** 只改备注。位置是加书签那一刻的事实，改位置等于换一处书签 */
export async function updateBookmarkNote(
    db: PlatformDb,
    owner: string,
    id: string,
    note: unknown,
): Promise<Bookmark> {
    const existing = await getBookmark(db, owner, id)
    if (!existing) throw new DataError(`找不到书签：${id}`, 404, 'bookmark_not_found')

    await db
        .prepare('UPDATE bookmarks SET note = ?, updated_at = ? WHERE owner = ? AND id = ?')
        .bind(optionalText(note, MAX_NOTE), Date.now(), owner, id)
        .run()

    const updated = await getBookmark(db, owner, id)
    if (!updated) throw new DataError('更新书签后读不回这条记录', 500, 'bookmark_write_failed')
    return updated
}

/** 删除。按 owner 过滤，因此别人的书签在这里一律是「找不到」 */
export async function removeBookmark(db: PlatformDb, owner: string, id: string): Promise<Bookmark> {
    const existing = await getBookmark(db, owner, id)
    if (!existing) throw new DataError(`找不到书签：${id}`, 404, 'bookmark_not_found')

    await db.prepare('DELETE FROM bookmarks WHERE owner = ? AND id = ?').bind(owner, id).run()
    return existing
}
