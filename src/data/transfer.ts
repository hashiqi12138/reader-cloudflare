/**
 * 书架、阅读进度、书签与笔记的**导出 / 导入**
 *
 * 这四样是用户自己攒下来的东西，而它们只存在这个部署的 D1 里 ——
 * 换一个部署、或者把数据搬到另一个账号，之前**没有任何办法**。
 *
 * 两条贯穿的原则：
 *
 * 1. **导出文件里不带 owner**。它是「备份」，不是「某人的数据」：导入到谁名下由会话
 *    决定，文件本身可以留档、可以给另一个账号用。
 * 2. **导入只增不改，而且进度按「谁更新」取**。导入最常见的两个场景是「同一份文件导
 *    两次」（重试 / 两台机器各导一次）与「把旧设备的备份导进新设备」。前者必须幂等，
 *    后者绝不能把新设备上更新的阅读位置倒回旧的那一章 —— 而「只增不改」在进度上
 *    恰恰不够用：进度是**一条**、需要更新，所以它的冲突规则单独写成「更新者胜」。
 *
 * 纯函数（`buildBackup` / `parseBackup`）与 D1 操作分开：格式与校验的规则值得单测
 * （`test/transfer.test.ts`），而合并只在真库上验（`smoke` 第 7c 段）。
 */

import type { PlatformDb } from '../platform/types'
import { DataError } from './types'
import type { AccountUser } from './accounts'
import { ownerForUser } from './accounts'

/** 文件头标识。导入时先认它，免得把一份书源合集当成备份导进来 */
export const BACKUP_KIND = 'reader-cloudflare-backup'

/**
 * 文件版本
 *
 * v2 加了 `notes` 这一份。**这里必须跳版本号，而不是「兼容地多加一个可选数组」**：
 * 旧部署的导入代码不认 `notes`，一份带笔记的备份导进去会被**静默丢掉全部笔记**，
 * 而界面上显示的是「导入成功」—— 那正是这套格式最不该有的失败方式。
 * 版本一跳，旧部署会明确回「这份备份来自更新的版本（v2）」，用户至少知道该升级。
 *
 * 反方向没问题：新代码读 v1 文件时 `notes` 缺失就是空数组，照常导入。
 */
export const BACKUP_VERSION = 2

/** 单类记录上限。真实用户量级是几百本书、几千条书签，这里留足余量当护栏 */
const MAX_SHELF_RECORDS = 5000
const MAX_PROGRESS_RECORDS = 5000
const MAX_BOOKMARK_RECORDS = 20000
/**
 * 笔记的条数上限比书签低一个量级，理由只有一条：**它比书签重得多**。
 * 一条书签约 300 字节（位置 + 一小段摘录），一条笔记是一段话，按 1 KB 估。
 * 两万条笔记那就是 20 MB，早就越过 `index.ts` 的 8 MB 请求体上限 ——
 * 而「能导出、导不回来」是这套格式最不该有的毛病。
 *
 * 5000 条（约 5 MB）是个折中：正常使用绝对够（一天写一条也够写十几年），
 * 而书签与笔记**同时**堆到上限时总体积仍会超过 8 MB —— 那一次导入会回
 * 413 并说清是体积超了，而不是悄悄少写几条。
 */
const MAX_NOTE_RECORDS = 5000

/**
 * 字段长度上限。**与写入那几条路保持一致**（library.ts / bookmarks.ts / notes.ts）：
 * 备份文件是外部输入，比写入路径更需要对长度设防
 */
const MAX_URL = 2048
const MAX_NAME = 200
const MAX_CHAPTER_NAME = 200
const MAX_EXCERPT = 120
const MAX_NOTE = 500
const MAX_NOTE_EXCERPT = 200
const MAX_NOTE_TEXT = 5000
const MAX_BOOK_KEY = MAX_URL * 2 + 1

export interface BackupShelfRecord {
    sourceId: string
    bookUrl: string
    name: string
    author: string
    coverUrl: string
    createdAt: number
    updatedAt: number
}

export interface BackupProgressRecord {
    sourceId: string
    bookUrl: string
    chapterUrl: string
    chapterName: string
    chapterIndex: number
    pageIndex: number
    updatedAt: number
}

export interface BackupBookmarkRecord {
    id: string
    sourceId: string
    bookUrl: string
    chapterUrl: string
    chapterName: string
    chapterIndex: number
    pageIndex: number
    percent: number
    excerpt: string
    note: string
    createdAt: number
    updatedAt: number
}

export interface BackupNoteRecord {
    id: string
    sourceId: string
    bookUrl: string
    chapterName: string
    chapterIndex: number
    pageIndex: number
    percent: number
    excerpt: string
    text: string
    createdAt: number
    updatedAt: number
}

export interface BackupFile {
    kind: string
    version: number
    exportedAt: number
    counts: { shelf: number; progress: number; bookmarks: number; notes: number }
    shelf: BackupShelfRecord[]
    progress: BackupProgressRecord[]
    bookmarks: BackupBookmarkRecord[]
    notes: BackupNoteRecord[]
}

/**
 * 进度的原始行
 *
 * `reading_progress` 表**没有** `source_id` / `book_url` 两列 —— 它们只存在于
 * `book_key` 里（`书源 id + 换行 + 书籍地址`，见 `types.ts` 的 `bookKey`）。
 * 导出时按这个格式拆回来，文件里仍然给出可读的两个字段。
 */
interface ProgressRow {
    book_key: string
    chapter_url: string
    chapter_name: string
    chapter_index: number
    page_index: number
    updated_at: number
}

/** 把 `book_key` 拆回 (书源 id, 书籍地址) */
function splitBookKey(key: string): { sourceId: string; bookUrl: string } {
    const at = key.indexOf('\n')
    if (at < 0) return { sourceId: key, bookUrl: '' }
    return { sourceId: key.slice(0, at), bookUrl: key.slice(at + 1) }
}

// ---------------------------------------------------------------- 导出

/** 组装备份文件。给定四份记录与时间戳，就是一份完整的文件（无副作用） */
export function buildBackup(
    data: {
        shelf: BackupShelfRecord[]
        progress: BackupProgressRecord[]
        bookmarks: BackupBookmarkRecord[]
        notes: BackupNoteRecord[]
    },
    exportedAt = Date.now(),
): BackupFile {
    return {
        kind: BACKUP_KIND,
        version: BACKUP_VERSION,
        exportedAt,
        counts: {
            shelf: data.shelf.length,
            progress: data.progress.length,
            bookmarks: data.bookmarks.length,
            notes: data.notes.length,
        },
        shelf: data.shelf,
        progress: data.progress,
        bookmarks: data.bookmarks,
        notes: data.notes,
    }
}

/**
 * 导出当前账号的四份数据
 *
 * 直接读表、不复用展示层的查询：文件格式与界面要展示的字段**不是一回事**
 * （比如书架列表要 join 出「最近读到第几章」，而备份只需要原始行）。
 */
export async function exportBackup(
    db: PlatformDb,
    user: Pick<AccountUser, 'id'>,
): Promise<BackupFile> {
    const owner = ownerForUser(user)

    const [shelfRows, progressRows, bookmarkRows, noteRows] = await Promise.all([
        db
            .prepare(
                `SELECT source_id, book_url, name, author, cover_url, created_at, updated_at
                   FROM shelf WHERE owner = ? ORDER BY created_at`,
            )
            .bind(owner)
            .all<Record<string, unknown>>(),
        db
            .prepare(
                `SELECT book_key, chapter_url, chapter_name, chapter_index, page_index, updated_at
                   FROM reading_progress WHERE owner = ? ORDER BY updated_at`,
            )
            .bind(owner)
            .all<ProgressRow>(),
        db
            .prepare(
                `SELECT id, source_id, book_url, chapter_url, chapter_name, chapter_index,
                        page_index, percent, excerpt, note, created_at, updated_at
                   FROM bookmarks WHERE owner = ? ORDER BY created_at`,
            )
            .bind(owner)
            .all<Record<string, unknown>>(),
        db
            .prepare(
                `SELECT id, source_id, book_url, chapter_name, chapter_index,
                        page_index, percent, excerpt, text, created_at, updated_at
                   FROM notes WHERE owner = ? ORDER BY created_at`,
            )
            .bind(owner)
            .all<Record<string, unknown>>(),
    ])

    return buildBackup({
        shelf: (shelfRows.results ?? []).map((row) => ({
            sourceId: String(row.source_id ?? ''),
            bookUrl: String(row.book_url ?? ''),
            name: String(row.name ?? ''),
            author: String(row.author ?? ''),
            coverUrl: String(row.cover_url ?? ''),
            createdAt: Number(row.created_at ?? 0),
            updatedAt: Number(row.updated_at ?? 0),
        })),
        progress: (progressRows.results ?? []).map((row) => ({
            ...splitBookKey(String(row.book_key ?? '')),
            chapterUrl: String(row.chapter_url ?? ''),
            chapterName: String(row.chapter_name ?? ''),
            chapterIndex: Number(row.chapter_index ?? 0),
            pageIndex: Number(row.page_index ?? 0),
            updatedAt: Number(row.updated_at ?? 0),
        })),
        bookmarks: (bookmarkRows.results ?? []).map((row) => ({
            id: String(row.id ?? ''),
            sourceId: String(row.source_id ?? ''),
            bookUrl: String(row.book_url ?? ''),
            chapterUrl: String(row.chapter_url ?? ''),
            chapterName: String(row.chapter_name ?? ''),
            chapterIndex: Number(row.chapter_index ?? 0),
            pageIndex: Number(row.page_index ?? 0),
            percent: Number(row.percent ?? 0),
            excerpt: String(row.excerpt ?? ''),
            note: String(row.note ?? ''),
            createdAt: Number(row.created_at ?? 0),
            updatedAt: Number(row.updated_at ?? 0),
        })),
        notes: (noteRows.results ?? []).map((row) => ({
            id: String(row.id ?? ''),
            sourceId: String(row.source_id ?? ''),
            bookUrl: String(row.book_url ?? ''),
            chapterName: String(row.chapter_name ?? ''),
            chapterIndex: Number(row.chapter_index ?? 0),
            pageIndex: Number(row.page_index ?? 0),
            percent: Number(row.percent ?? 0),
            excerpt: String(row.excerpt ?? ''),
            text: String(row.text ?? ''),
            createdAt: Number(row.created_at ?? 0),
            updatedAt: Number(row.updated_at ?? 0),
        })),
    })
}

// ---------------------------------------------------------------- 导入：解析与校验

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

/** 逐个字段取值的错误都带上「第几条、哪个字段」，不然一份坏文件只知道『导入失败』 */
function fail(index: number, field: string): never {
    throw new DataError(`备份文件第 ${index + 1} 条记录的 ${field} 不合法`, 400, 'invalid_backup')
}

function text(value: unknown, field: string, index: number, max: number, required = false): string {
    if (value === undefined || value === null) {
        if (required) fail(index, field)
        return ''
    }
    if (typeof value !== 'string') fail(index, field)
    const trimmed = value.trim()
    if (required && trimmed === '') fail(index, field)
    if (trimmed.length > max) fail(index, field)
    return trimmed
}

function count(value: unknown, field: string, index: number): number {
    if (value === undefined || value === null) return 0
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) fail(index, field)
    return Math.floor(n)
}

function ratio(value: unknown, field: string, index: number): number {
    if (value === undefined || value === null) return 0
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0 || n > 1) fail(index, field)
    return n
}

/** 时间戳：缺失时给 0，由导入处补成「现在」；给了必须是正数 */
function timestamp(value: unknown, field: string, index: number): number {
    if (value === undefined || value === null) return 0
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) fail(index, field)
    return Math.floor(n)
}

function records(raw: unknown, field: string): unknown[] {
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw)) {
        throw new DataError(`备份文件里的 ${field} 必须是数组`, 400, 'invalid_backup')
    }
    return raw
}

function requireWithin(list: unknown[], max: number, field: string): void {
    if (list.length > max) {
        throw new DataError(
            `备份文件里的 ${field} 有 ${list.length} 条，超过上限 ${max} 条`,
            400,
            'backup_too_large',
        )
    }
}

/**
 * 解析并校验一份备份文件
 *
 * 刻意**不宽容**：字段类型不对、时间戳是负数、进度百分比超出 0～1 都直接报错并指出
 * 是第几条。放宽的话，坏数据会被写进库里，而它看起来和正常数据没有区别 ——
 * 那是「静默错数据」，比导入失败难查得多。
 */
export function parseBackup(raw: unknown): BackupFile {
    if (!isPlainObject(raw)) {
        throw new DataError('备份文件必须是一个 JSON 对象', 400, 'invalid_backup')
    }
    if (raw.kind !== BACKUP_KIND) {
        throw new DataError('这不是本应用的备份文件（缺少 kind 标识）', 400, 'invalid_backup_kind')
    }
    const version = Number(raw.version)
    if (!Number.isFinite(version) || version < 1) {
        throw new DataError('备份文件缺少版本号', 400, 'invalid_backup')
    }
    if (version > BACKUP_VERSION) {
        throw new DataError(
            `这份备份来自更新的版本（v${version}），当前只认到 v${BACKUP_VERSION}`,
            400,
            'backup_version_too_new',
        )
    }

    const shelfRaw = records(raw.shelf, 'shelf')
    const progressRaw = records(raw.progress, 'progress')
    const bookmarksRaw = records(raw.bookmarks, 'bookmarks')
    // v1 的文件没有 notes —— 缺失就是空数组，不是错误（见 BACKUP_VERSION 的说明）
    const notesRaw = records(raw.notes, 'notes')
    requireWithin(shelfRaw, MAX_SHELF_RECORDS, '书架记录')
    requireWithin(progressRaw, MAX_PROGRESS_RECORDS, '进度记录')
    requireWithin(bookmarksRaw, MAX_BOOKMARK_RECORDS, '书签记录')
    requireWithin(notesRaw, MAX_NOTE_RECORDS, '笔记记录')

    const shelf = shelfRaw.map((item, index) => {
        if (!isPlainObject(item)) fail(index, '记录本身')
        return {
            sourceId: text(item.sourceId, 'sourceId', index, MAX_URL, true),
            bookUrl: text(item.bookUrl, 'bookUrl', index, MAX_URL, true),
            name: text(item.name, 'name', index, MAX_NAME, true),
            author: text(item.author, 'author', index, MAX_NAME),
            coverUrl: text(item.coverUrl, 'coverUrl', index, MAX_URL),
            createdAt: timestamp(item.createdAt, 'createdAt', index),
            updatedAt: timestamp(item.updatedAt, 'updatedAt', index),
        }
    })

    const progress = progressRaw.map((item, index) => {
        if (!isPlainObject(item)) fail(index, '记录本身')
        return {
            sourceId: text(item.sourceId, 'sourceId', index, MAX_URL, true),
            bookUrl: text(item.bookUrl, 'bookUrl', index, MAX_URL, true),
            chapterUrl: text(item.chapterUrl, 'chapterUrl', index, MAX_URL, true),
            chapterName: text(item.chapterName, 'chapterName', index, MAX_CHAPTER_NAME),
            chapterIndex: count(item.chapterIndex, 'chapterIndex', index),
            pageIndex: count(item.pageIndex, 'pageIndex', index),
            updatedAt: timestamp(item.updatedAt, 'updatedAt', index),
        }
    })

    const bookmarks = bookmarksRaw.map((item, index) => {
        if (!isPlainObject(item)) fail(index, '记录本身')
        return {
            id: text(item.id, 'id', index, 128, true),
            sourceId: text(item.sourceId, 'sourceId', index, MAX_URL, true),
            bookUrl: text(item.bookUrl, 'bookUrl', index, MAX_URL, true),
            chapterUrl: text(item.chapterUrl, 'chapterUrl', index, MAX_URL, true),
            chapterName: text(item.chapterName, 'chapterName', index, MAX_CHAPTER_NAME),
            chapterIndex: count(item.chapterIndex, 'chapterIndex', index),
            pageIndex: count(item.pageIndex, 'pageIndex', index),
            percent: ratio(item.percent, 'percent', index),
            excerpt: text(item.excerpt, 'excerpt', index, MAX_EXCERPT),
            note: text(item.note, 'note', index, MAX_NOTE),
            createdAt: timestamp(item.createdAt, 'createdAt', index),
            updatedAt: timestamp(item.updatedAt, 'updatedAt', index),
        }
    })

    const notes = notesRaw.map((item, index) => {
        if (!isPlainObject(item)) fail(index, '记录本身')
        return {
            id: text(item.id, 'id', index, 128, true),
            sourceId: text(item.sourceId, 'sourceId', index, MAX_URL, true),
            bookUrl: text(item.bookUrl, 'bookUrl', index, MAX_URL, true),
            chapterName: text(item.chapterName, 'chapterName', index, MAX_CHAPTER_NAME),
            chapterIndex: count(item.chapterIndex, 'chapterIndex', index),
            pageIndex: count(item.pageIndex, 'pageIndex', index),
            percent: ratio(item.percent, 'percent', index),
            excerpt: text(item.excerpt, 'excerpt', index, MAX_NOTE_EXCERPT),
            // 正文必填，与 notes.ts 一致：没有正文的笔记在列表里就是一行空白
            text: text(item.text, 'text', index, MAX_NOTE_TEXT, true),
            createdAt: timestamp(item.createdAt, 'createdAt', index),
            updatedAt: timestamp(item.updatedAt, 'updatedAt', index),
        }
    })

    return {
        kind: BACKUP_KIND,
        version,
        exportedAt: timestamp(raw.exportedAt, 'exportedAt', 0),
        counts: {
            shelf: shelf.length,
            progress: progress.length,
            bookmarks: bookmarks.length,
            notes: notes.length,
        },
        shelf,
        progress,
        bookmarks,
        notes,
    }
}

// ---------------------------------------------------------------- 导入：合并

export interface ImportReport {
    /** 新加进书架的书 */
    shelf: number
    /** 写入的阅读位置（新增或按「更新者胜」覆盖） */
    progress: number
    /** 本地那份更新，保留本地 */
    progressKept: number
    /** 新加的书签 */
    bookmarks: number
    /** 已经在库里、跳过的书签（同一份文件导两次时就是这些） */
    bookmarksKept: number
    /** 新加的笔记 */
    notes: number
    /** 已经在库里、跳过的笔记 */
    notesKept: number
}

/** `book_key` 与 library.ts / bookmarks.ts 用同一形态：书源 id + 换行 + 书籍地址 */
const keyOf = (sourceId: string, bookUrl: string): string => `${sourceId}\n${bookUrl}`

/**
 * 把一份备份合并进当前账号
 *
 * 三条冲突规则，各不一样，都是刻意选的：
 *
 * - **书架：已有的不动。** 备份里的书名/封面可能是旧的，而本地那份是你现在看着的。
 *   导入是「把缺的补上」，不是「用备份覆盖现在」。
 * - **进度：更新者胜。** 进度必须能更新，否则「把旧备份导进新设备」会把读到的新章节
 *   倒回去。比 `updated_at`，新的那份留下。
 * - **书签：按 id 去重。** 同一份文件导两次不该变成两倍书签；而书签的 id 是随机串，
 *   同一份文件里的 id 是稳定的，所以按 id 判重正好。
 * - **笔记：与书签同一条规则（按 id 去重）。** 「我写的一段话」是内容，不是位置，
 *   导入时用另一份覆盖本机那一份没有道理 —— 谁也不会希望导个备份把自己的笔记改掉。
 */
export async function importBackup(
    db: PlatformDb,
    user: Pick<AccountUser, 'id'>,
    raw: unknown,
): Promise<ImportReport> {
    const backup = parseBackup(raw)
    const owner = ownerForUser(user)
    const now = Date.now()

    // D1 单条语句最多 100 个绑定参数，按每行的列数算出每条语句能塞几行
    const shelfChunk = Math.max(1, Math.floor(100 / 9))
    const progressChunk = Math.max(1, Math.floor(100 / 7))
    const bookmarkChunk = Math.max(1, Math.floor(100 / 14))
    const noteChunk = Math.max(1, Math.floor(100 / 13))

    let shelfAdded = 0
    for (let i = 0; i < backup.shelf.length; i += shelfChunk) {
        const chunk = backup.shelf.slice(i, i + shelfChunk)
        const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
        const statement = db.prepare(
            `INSERT INTO shelf (owner, book_key, source_id, book_url, name, author, cover_url, created_at, updated_at)
             VALUES ${values}
             ON CONFLICT(owner, book_key) DO NOTHING`,
        )
        const bound = chunk.flatMap((record) => [
            owner,
            keyOf(record.sourceId, record.bookUrl).slice(0, MAX_BOOK_KEY),
            record.sourceId,
            record.bookUrl,
            record.name,
            record.author,
            record.coverUrl,
            record.createdAt > 0 ? record.createdAt : now,
            record.updatedAt > 0 ? record.updatedAt : now,
        ])
        const result = await statement.bind(...bound).run()
        shelfAdded += Number(result.meta?.changes ?? 0)
    }

    let progressWritten = 0
    for (let i = 0; i < backup.progress.length; i += progressChunk) {
        const chunk = backup.progress.slice(i, i + progressChunk)
        // `reading_progress` 只有 book_key，没有 source_id / book_url（见表结构）
        const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')
        const statement = db.prepare(
            `INSERT INTO reading_progress
                 (owner, book_key, chapter_url, chapter_name, chapter_index, page_index, updated_at)
             VALUES ${values}
             ON CONFLICT(owner, book_key) DO UPDATE SET
                 chapter_url = excluded.chapter_url,
                 chapter_name = excluded.chapter_name,
                 chapter_index = excluded.chapter_index,
                 page_index = excluded.page_index,
                 updated_at = excluded.updated_at
             WHERE excluded.updated_at > reading_progress.updated_at`,
        )
        const bound = chunk.flatMap((record) => [
            owner,
            keyOf(record.sourceId, record.bookUrl).slice(0, MAX_BOOK_KEY),
            record.chapterUrl,
            record.chapterName,
            record.chapterIndex,
            record.pageIndex,
            record.updatedAt > 0 ? record.updatedAt : now,
        ])
        const result = await statement.bind(...bound).run()
        progressWritten += Number(result.meta?.changes ?? 0)
    }

    let bookmarksAdded = 0
    for (let i = 0; i < backup.bookmarks.length; i += bookmarkChunk) {
        const chunk = backup.bookmarks.slice(i, i + bookmarkChunk)
        const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
        const statement = db.prepare(
            `INSERT INTO bookmarks
                 (owner, id, book_key, source_id, book_url, chapter_url, chapter_name,
                  chapter_index, page_index, percent, excerpt, note, created_at, updated_at)
             VALUES ${values}
             ON CONFLICT(owner, id) DO NOTHING`,
        )
        const bound = chunk.flatMap((record) => [
            owner,
            record.id,
            keyOf(record.sourceId, record.bookUrl).slice(0, MAX_BOOK_KEY),
            record.sourceId,
            record.bookUrl,
            record.chapterUrl,
            record.chapterName,
            record.chapterIndex,
            record.pageIndex,
            record.percent,
            record.excerpt,
            record.note,
            record.createdAt > 0 ? record.createdAt : now,
            record.updatedAt > 0 ? record.updatedAt : now,
        ])
        const result = await statement.bind(...bound).run()
        bookmarksAdded += Number(result.meta?.changes ?? 0)
    }

    let notesAdded = 0
    for (let i = 0; i < backup.notes.length; i += noteChunk) {
        const chunk = backup.notes.slice(i, i + noteChunk)
        const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
        const statement = db.prepare(
            `INSERT INTO notes
                 (owner, id, book_key, source_id, book_url, chapter_name,
                  chapter_index, page_index, percent, excerpt, text, created_at, updated_at)
             VALUES ${values}
             ON CONFLICT(owner, id) DO NOTHING`,
        )
        const bound = chunk.flatMap((record) => [
            owner,
            record.id,
            keyOf(record.sourceId, record.bookUrl).slice(0, MAX_BOOK_KEY),
            record.sourceId,
            record.bookUrl,
            record.chapterName,
            record.chapterIndex,
            record.pageIndex,
            record.percent,
            record.excerpt,
            record.text,
            record.createdAt > 0 ? record.createdAt : now,
            record.updatedAt > 0 ? record.updatedAt : now,
        ])
        const result = await statement.bind(...bound).run()
        notesAdded += Number(result.meta?.changes ?? 0)
    }

    return {
        shelf: shelfAdded,
        progress: progressWritten,
        progressKept: backup.progress.length - progressWritten,
        bookmarks: bookmarksAdded,
        bookmarksKept: backup.bookmarks.length - bookmarksAdded,
        notes: notesAdded,
        notesKept: backup.notes.length - notesAdded,
    }
}
