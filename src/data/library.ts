/**
 * 书架与阅读进度的 D1 读写
 *
 * 与 `db.ts`（书源）分开：书源是「配置」，书架是「用户数据」，
 * 前者导入后基本不动，后者每次翻页都可能写一次。混在一起会让书源那张表
 * 跟着阅读行为频繁更新，也让「书源同步」这种将来的功能不好切。
 */

import { DataError, bookKey } from './types'

const MAX_NAME_LENGTH = 200
const MAX_URL_LENGTH = 2048

export interface ShelfEntry {
    bookKey: string
    sourceId: string
    bookUrl: string
    name: string
    author: string
    coverUrl: string
    createdAt: number
    updatedAt: number
    /** 最近阅读的章节，没读过则为 null */
    chapterName: string | null
    chapterIndex: number | null
    /** 阅读进度最后的更新时间，用来区分「加进书架但没读」和「读过」 */
    readAt: number | null
}

export interface Progress {
    bookKey: string
    chapterUrl: string
    chapterName: string
    chapterIndex: number
    updatedAt: number
}

interface ShelfRow {
    book_key: string
    source_id: string
    book_url: string
    name: string
    author: string
    cover_url: string
    created_at: number
    updated_at: number
    chapter_name: string | null
    chapter_index: number | null
    read_at: number | null
}

function rowToEntry(row: ShelfRow): ShelfEntry {
    return {
        bookKey: row.book_key,
        sourceId: row.source_id,
        bookUrl: row.book_url,
        name: row.name,
        author: row.author,
        coverUrl: row.cover_url,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        chapterName: row.chapter_name,
        chapterIndex: row.chapter_index,
        readAt: row.read_at,
    }
}

/**
 * 书架列表，最近读的在前，没读过的按加入时间排。
 *
 * 用 LEFT JOIN 一次取回进度，而不是先查书架再逐条查进度 ——
 * 后者在几十上百本时就是几十上百次查询，D1 按行计费，这个代价是白付的。
 */
export async function listShelf(db: D1Database): Promise<ShelfEntry[]> {
    const { results } = await db
        .prepare(
            `SELECT s.book_key, s.source_id, s.book_url, s.name, s.author, s.cover_url,
                    s.created_at, s.updated_at,
                    p.chapter_name, p.chapter_index, p.updated_at AS read_at
               FROM shelf s
               LEFT JOIN reading_progress p ON p.book_key = s.book_key
              ORDER BY COALESCE(p.updated_at, s.created_at) DESC`,
        )
        .all<ShelfRow>()
    return (results ?? []).map(rowToEntry)
}

export async function getShelfEntry(db: D1Database, key: string): Promise<ShelfEntry | undefined> {
    const row = await db
        .prepare(
            `SELECT s.book_key, s.source_id, s.book_url, s.name, s.author, s.cover_url,
                    s.created_at, s.updated_at,
                    p.chapter_name, p.chapter_index, p.updated_at AS read_at
               FROM shelf s
               LEFT JOIN reading_progress p ON p.book_key = s.book_key
              WHERE s.book_key = ?`,
        )
        .bind(key)
        .first<ShelfRow>()
    return row ? rowToEntry(row) : undefined
}

export interface AddToShelfInput {
    sourceId: string
    bookUrl: string
    name: string
    author?: string
    coverUrl?: string
}

function requireShortString(value: unknown, field: string, max: number): string {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') throw new DataError(`缺少 ${field}`, 400, 'invalid_shelf_input')
    if (text.length > max) {
        throw new DataError(`${field} 超过 ${max} 字符`, 400, 'invalid_shelf_input')
    }
    return text
}

/** 加入书架。同一本书重复加入等于更新，不会变成两条 */
export async function addToShelf(
    db: D1Database,
    input: AddToShelfInput,
): Promise<{ entry: ShelfEntry; created: boolean }> {
    const sourceId = requireShortString(input.sourceId, 'sourceId', MAX_URL_LENGTH)
    const bookUrl = requireShortString(input.bookUrl, 'bookUrl', MAX_URL_LENGTH)
    const name = requireShortString(input.name, 'name', MAX_NAME_LENGTH)
    const author = typeof input.author === 'string' ? input.author.trim() : ''
    const coverUrl = typeof input.coverUrl === 'string' ? input.coverUrl.trim() : ''

    const key = bookKey(sourceId, bookUrl)
    const existing = await getShelfEntry(db, key)
    const now = Date.now()

    await db
        .prepare(
            `INSERT INTO shelf (book_key, source_id, book_url, name, author, cover_url, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(book_key) DO UPDATE SET
                 name = excluded.name,
                 author = excluded.author,
                 cover_url = excluded.cover_url,
                 updated_at = excluded.updated_at`,
        )
        .bind(key, sourceId, bookUrl, name, author, coverUrl, now, now)
        .run()

    const entry = await getShelfEntry(db, key)
    if (!entry) {
        // 写进去了却读不出来，说明存储层出了问题，不能当成「加好了」返回
        throw new DataError('加入书架后读不回这条记录', 500, 'shelf_write_failed')
    }
    return { entry, created: existing === undefined }
}

export async function removeFromShelf(db: D1Database, key: string): Promise<ShelfEntry> {
    const existing = await getShelfEntry(db, key)
    if (!existing) throw new DataError(`书架里没有这本书：${key}`, 404, 'shelf_entry_not_found')

    await db.batch([
        db.prepare('DELETE FROM shelf WHERE book_key = ?').bind(key),
        // 进度跟着一起清：留着它会让「重新加回书架」时冒出一个莫名其妙的阅读位置
        db.prepare('DELETE FROM reading_progress WHERE book_key = ?').bind(key),
    ])
    return existing
}

export async function getProgress(db: D1Database, key: string): Promise<Progress | undefined> {
    const row = await db
        .prepare(
            `SELECT book_key, chapter_url, chapter_name, chapter_index, updated_at
               FROM reading_progress WHERE book_key = ?`,
        )
        .bind(key)
        .first<{
            book_key: string
            chapter_url: string
            chapter_name: string
            chapter_index: number
            updated_at: number
        }>()
    if (!row) return undefined
    return {
        bookKey: row.book_key,
        chapterUrl: row.chapter_url,
        chapterName: row.chapter_name,
        chapterIndex: row.chapter_index,
        updatedAt: row.updated_at,
    }
}

export interface SaveProgressInput {
    sourceId: string
    bookUrl: string
    chapterUrl: string
    chapterName?: string
    chapterIndex?: number
}

/**
 * 记录阅读位置。**只写不进书架**：不在书架的书也应该能记住读到哪，
 * 否则「搜到一本书、读了两章、再搜回来」就得从头翻。
 */
export async function saveProgress(db: D1Database, input: SaveProgressInput): Promise<Progress> {
    const sourceId = requireShortString(input.sourceId, 'sourceId', MAX_URL_LENGTH)
    const bookUrl = requireShortString(input.bookUrl, 'bookUrl', MAX_URL_LENGTH)
    const chapterUrl = requireShortString(input.chapterUrl, 'chapterUrl', MAX_URL_LENGTH)
    const chapterName = typeof input.chapterName === 'string' ? input.chapterName.trim() : ''
    const chapterIndex =
        typeof input.chapterIndex === 'number' && Number.isFinite(input.chapterIndex)
            ? Math.max(0, Math.trunc(input.chapterIndex))
            : 0

    const key = bookKey(sourceId, bookUrl)
    const now = Date.now()

    await db
        .prepare(
            `INSERT INTO reading_progress (book_key, chapter_url, chapter_name, chapter_index, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(book_key) DO UPDATE SET
                 chapter_url = excluded.chapter_url,
                 chapter_name = excluded.chapter_name,
                 chapter_index = excluded.chapter_index,
                 updated_at = excluded.updated_at`,
        )
        .bind(key, chapterUrl, chapterName, chapterIndex, now)
        .run()

    // 在书架里的书，阅读位置变化也应该把它顶到书架最前面
    await db.prepare('UPDATE shelf SET updated_at = ? WHERE book_key = ?').bind(now, key).run()

    const saved = await getProgress(db, key)
    if (!saved) throw new DataError('写入阅读进度后读不回来', 500, 'progress_write_failed')
    return saved
}
