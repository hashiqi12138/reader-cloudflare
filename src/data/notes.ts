/**
 * 笔记的 D1 读写
 *
 * 与书签分成两张表（理由见迁移 `0010` 的注释），但**隔离方式与位置模型完全一样**：
 * 每条查询都带 `owner`，位置三件套（章节 + 页 + 百分比）两种阅读模式各用一半，
 * 按 `book_key` 取一本书的全部笔记。所以这个文件的形状是照着 `bookmarks.ts` 来的 ——
 * 一处刻意的不一样是：**正文必填，且上限大得多**。
 *
 * 三条刻意的选择：
 *
 * 1. **正文必填**（`requireText`），空正文直接 400。书签可以只有一个位置，
 *    笔记不行：没有正文的笔记在列表里就是一行空白，还会占掉导出与备份里的位置。
 *    这不是「用户没写全」，是「这条记录没有意义」。
 * 2. **正文上限 5000 字**（书签备注是 500）。笔记是「写一段话」，书签备注是
 *    「标注一下」，两者按不同量级设限；再长就该去写文档了。
 * 3. **同一处可以写多条**，不做位置去重。想法会变，同一段写两条是正常用法 ——
 *    与书签「重复标记是用户的选择」同一个理由。
 */

import { DataError, bookKey } from './types'

/** 章节名上限。目录名一般是几十个字，超过这个量级的多半是源把整段正文塞进来了 */
const MAX_CHAPTER_NAME = 200
const MAX_URL = 2048
/** 摘录只用于在列表里交代「这条笔记记的是哪一段」，比书签的 120 宽一些 */
const MAX_EXCERPT = 200
/** 笔记正文上限。见文件头第 2 条 */
export const MAX_NOTE_TEXT = 5000

export interface Note {
    id: string
    bookKey: string
    sourceId: string
    bookUrl: string
    chapterName: string
    chapterIndex: number
    /** 翻页模式停在第几页（从 0 数） */
    pageIndex: number
    /** 滚动阅读时的位置，0～1；翻页模式恒为 0 */
    percent: number
    /** 写这条笔记时看的那段正文，只用于展示 */
    excerpt: string
    text: string
    createdAt: number
    updatedAt: number
}

interface NoteRow {
    id: string
    book_key: string
    source_id: string
    book_url: string
    chapter_name: string
    chapter_index: number
    page_index: number
    percent: number
    excerpt: string
    text: string
    created_at: number
    updated_at: number
}

function rowToNote(row: NoteRow): Note {
    return {
        id: row.id,
        bookKey: row.book_key,
        sourceId: row.source_id,
        bookUrl: row.book_url,
        chapterName: row.chapter_name,
        chapterIndex: row.chapter_index,
        pageIndex: row.page_index,
        percent: row.percent,
        excerpt: row.excerpt,
        text: row.text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

const SELECT_COLUMNS = `id, book_key, source_id, book_url, chapter_name,
                        chapter_index, page_index, percent, excerpt, text,
                        created_at, updated_at`

export interface NoteInput {
    sourceId?: unknown
    bookUrl?: unknown
    chapterName?: unknown
    chapterIndex?: unknown
    pageIndex?: unknown
    percent?: unknown
    excerpt?: unknown
    text?: unknown
}

export interface NormalizedNoteInput {
    sourceId: string
    bookUrl: string
    chapterName: string
    chapterIndex: number
    pageIndex: number
    percent: number
    excerpt: string
    text: string
}

function requireText(value: unknown, field: string, max: number): string {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') throw new DataError(`缺少 ${field}`, 400, 'invalid_note_input')
    if (text.length > max) {
        throw new DataError(`${field} 超过 ${max} 字符`, 400, 'invalid_note_input')
    }
    return text
}

/** 可选文本：超长就截断而不是报错 —— 摘录来自正文，长度不是用户能控制的 */
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
 * 把一次「写笔记」的输入收敛成入库形状
 *
 * 导出是为了能直接做单元测试：这是不可信输入进入库之前的最后一道关口，
 * 而它全部是纯计算 —— 不需要 D1 就能把边界钉住（空正文、超长、类型不对）。
 */
export function normalizeNoteInput(input: NoteInput): NormalizedNoteInput {
    return {
        sourceId: requireText(input.sourceId, 'sourceId', MAX_URL),
        bookUrl: requireText(input.bookUrl, 'bookUrl', MAX_URL),
        chapterName: optionalText(input.chapterName, MAX_CHAPTER_NAME),
        chapterIndex: optionalCount(input.chapterIndex),
        pageIndex: optionalCount(input.pageIndex),
        percent: optionalRatio(input.percent),
        excerpt: optionalText(input.excerpt, MAX_EXCERPT),
        text: requireText(input.text, 'text', MAX_NOTE_TEXT),
    }
}

/** 改正文时也走同一套校验：空正文不是「清空」，是这条笔记不该存在 */
export function normalizeNoteText(value: unknown): string {
    return requireText(value, 'text', MAX_NOTE_TEXT)
}

/** 一本书的全部笔记，按章节顺序、再按页顺序（与阅读顺序一致） */
export async function listNotes(db: D1Database, owner: string, key: string): Promise<Note[]> {
    const { results } = await db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM notes
              WHERE owner = ? AND book_key = ?
              ORDER BY chapter_index, page_index, created_at`,
        )
        .bind(owner, key)
        .all<NoteRow>()
    return (results ?? []).map(rowToNote)
}

export async function getNote(
    db: D1Database,
    owner: string,
    id: string,
): Promise<Note | undefined> {
    const row = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM notes WHERE owner = ? AND id = ?`)
        .bind(owner, id)
        .first<NoteRow>()
    return row ? rowToNote(row) : undefined
}

export async function addNote(db: D1Database, owner: string, input: NoteInput): Promise<Note> {
    const data = normalizeNoteInput(input)
    const id = crypto.randomUUID()
    const now = Date.now()

    await db
        .prepare(
            `INSERT INTO notes
                 (id, owner, book_key, source_id, book_url, chapter_name,
                  chapter_index, page_index, percent, excerpt, text, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
            id,
            owner,
            bookKey(data.sourceId, data.bookUrl),
            data.sourceId,
            data.bookUrl,
            data.chapterName,
            data.chapterIndex,
            data.pageIndex,
            data.percent,
            data.excerpt,
            data.text,
            now,
            now,
        )
        .run()

    const created = await getNote(db, owner, id)
    // 写进去了却读不出来 = 存储层出了问题，不能当成「写好了」返回
    if (!created) throw new DataError('写入笔记后读不回这条记录', 500, 'note_write_failed')
    return created
}

/** 只改正文。位置与摘录是写这条笔记那一刻的事实，改它们等于换一处笔记 */
export async function updateNoteText(
    db: D1Database,
    owner: string,
    id: string,
    text: unknown,
): Promise<Note> {
    const existing = await getNote(db, owner, id)
    if (!existing) throw new DataError(`找不到笔记：${id}`, 404, 'note_not_found')

    await db
        .prepare('UPDATE notes SET text = ?, updated_at = ? WHERE owner = ? AND id = ?')
        .bind(normalizeNoteText(text), Date.now(), owner, id)
        .run()

    const updated = await getNote(db, owner, id)
    if (!updated) throw new DataError('更新笔记后读不回这条记录', 500, 'note_write_failed')
    return updated
}

/** 删除。按 owner 过滤，因此别人的笔记在这里一律是「找不到」 */
export async function removeNote(db: D1Database, owner: string, id: string): Promise<Note> {
    const existing = await getNote(db, owner, id)
    if (!existing) throw new DataError(`找不到笔记：${id}`, 404, 'note_not_found')

    await db.prepare('DELETE FROM notes WHERE owner = ? AND id = ?').bind(owner, id).run()
    return existing
}
