/**
 * 书签导出成**能读的清单**（Markdown / CSV）
 *
 * 与「导出备份」是两件事，值得说清楚：
 *
 *   - 备份是**整份数据的搬运**（JSON，书架 + 进度 + 书签），存在的意义是「能导回来」
 *   - 这里要的是**拿去用**的东西：把摘录与备注排成一份能贴进笔记软件、或能在表格里
 *     排序筛选的清单。所以输出的是**文本**，列顺序与时间格式都为人读服务，
 *     **不打算能导回来** —— 要往返请用备份
 *
 * 三个刻意的选择：
 *
 * 1. **时间统一按 UTC+8 渲染**，并在表头写明。导出的文件会离开这台机器，
 *    写「本地时间」而不写是哪里的本地时间，到了别处就是无源之水。
 *    +8 与 `java.timeFormat` 的默认偏移一致，不是随手挑的。
 * 2. **CSV 带 UTF-8 BOM，且行尾用 CRLF**。不带 BOM 的 CSV 在 Windows 的 Excel 里
 *    直接把中文显示成乱码 —— 而「导出成 CSV」这件事十有八九就是给 Excel 看的。
 *    转义按 RFC 4180：字段里有 `,` / `"` / 换行就整体加引号，内部引号翻倍。
 * 3. **Markdown 表格里的换行要变成 `<br>`**。摘录常常是跨行的，直接塞进去会把一行
 *    拆成两行、整张表错位；`|` 也必须转义，否则列数会变。
 *
 * 纯函数都在这个文件里（`renderMarkdown` / `renderCsv` / 文件名与响应头），
 * 所以能在 Node 里逐条单测；只有 `loadBookmarkRows` 碰 D1，交给冒烟验。
 */

import type { PlatformDb } from '../platform/types'

import type { AccountUser } from './accounts'
import { ownerForUser } from './accounts'

/** 清单里的一行：一条书签 + 它所属书的书名/作者 */
export interface BookmarkListRow {
    bookName: string
    bookAuthor: string
    chapterName: string
    chapterIndex: number
    pageIndex: number
    percent: number
    excerpt: string
    note: string
    createdAt: number
}

export type BookmarkListFormat = 'md' | 'csv'

/** 导出时的时区偏移（小时）。+8 与 `java.timeFormat` 的默认一致 */
const TIME_OFFSET_HOURS = 8

function pad(n: number): string {
    return String(n).padStart(2, '0')
}

/** 时间戳 → `yyyy-MM-dd HH:mm`（UTC+8） */
export function formatStamp(ms: number): string {
    const shifted = new Date(Number.isFinite(ms) ? ms + TIME_OFFSET_HOURS * 3600_000 : 0)
    return (
        `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
        ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
    )
}

/** 时间戳 → `yyyyMMdd`（UTC+8），文件名用 */
export function formatStampCompact(ms: number): string {
    const shifted = new Date(Number.isFinite(ms) ? ms + TIME_OFFSET_HOURS * 3600_000 : 0)
    return `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`
}

/**
 * 书签在这一章里的位置
 *
 * 翻页模式停在 `pageIndex`（**从 0 数**，界面上显示的也是 `pageIndex + 1`），
 * 滚动模式没有页的概念、用 `percent`（0~1 的比例）。只存一个的话另一种模式跳回来会偏，
 * 所以两个都存；这里是「有百分比就写百分比，否则写页码」。
 */
export function formatPosition(row: Pick<BookmarkListRow, 'pageIndex' | 'percent'>): string {
    const percent = Number(row.percent ?? 0)
    if (Number.isFinite(percent) && percent > 0) return `${(percent * 100).toFixed(1)}%`
    return `第 ${Math.max(1, Math.round(Number(row.pageIndex ?? 0)) + 1)} 页`
}

/** 章节名：没写就退回「第 N 章」（`chapterIndex` 同样从 0 数） */
export function formatChapter(row: Pick<BookmarkListRow, 'chapterName' | 'chapterIndex'>): string {
    const name = String(row.chapterName ?? '').trim()
    if (name !== '') return name
    return `第 ${Math.max(1, Math.round(Number(row.chapterIndex ?? 0)) + 1)} 章`
}

/**
 * Markdown 表格单元格
 *
 * `|` 要转义（否则列数变了），换行要变 `<br>`（否则一行被拆成两行、整表错位），
 * 反斜杠也要转义 —— 不然后面那个 `\|` 会被当成「真的竖线」。
 */
export function escapeMarkdownCell(text: string): string {
    return String(text ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\r\n|\r|\n/g, '<br>')
        .trim()
}

/** CSV 单元格，按 RFC 4180：有 `,` / `"` / 换行就加引号并把内部引号翻倍 */
export function csvCell(text: string): string {
    const value = String(text ?? '')
    if (!/[",\r\n]/.test(value)) return value
    return `"${value.replace(/"/g, '""')}"`
}

/** 一本书的小节标题（Markdown 用） */
function bookHeading(row: BookmarkListRow): string {
    const author = String(row.bookAuthor ?? '').trim()
    return author === '' ? row.bookName : `${row.bookName}（${author}）`
}

/**
 * 渲染 Markdown 清单
 *
 * 按书分节：清单通常是「这本书里我标了什么」的视角，全部混在一起读起来会很乱。
 * 书内的顺序交给调用方（`loadBookmarkRows` 已按章节与页排好）。
 */
export function renderMarkdown(rows: BookmarkListRow[], generatedAt: number): string {
    const books: string[] = []
    const grouped = new Map<string, BookmarkListRow[]>()
    for (const row of rows) {
        const key = bookHeading(row)
        if (!grouped.has(key)) {
            grouped.set(key, [])
            books.push(key)
        }
        grouped.get(key)!.push(row)
    }

    const out: string[] = []
    out.push('# 书签清单')
    out.push('')
    out.push(`- 导出时间：${formatStamp(generatedAt)}（UTC+8）`)
    out.push(`- 共 ${rows.length} 条，来自 ${books.length} 本书`)
    if (rows.length === 0) {
        out.push('')
        out.push('（还没有书签）')
        return `${out.join('\n')}\n`
    }

    for (const book of books) {
        const items = grouped.get(book)!
        out.push('')
        out.push(`## ${book}`)
        out.push('')
        out.push('| 章节 | 位置 | 摘录 | 备注 | 添加时间 |')
        out.push('| --- | --- | --- | --- | --- |')
        for (const row of items) {
            out.push(
                `| ${escapeMarkdownCell(formatChapter(row))} | ${escapeMarkdownCell(formatPosition(row))} | ` +
                    `${escapeMarkdownCell(row.excerpt)} | ${escapeMarkdownCell(row.note)} | ` +
                    `${formatStamp(row.createdAt)} |`,
            )
        }
    }
    out.push('')
    return out.join('\n')
}

/** CSV 的列顺序（也是 Markdown 之外的「能进表格」的那份） */
const CSV_HEADERS = ['书名', '作者', '章节', '位置', '摘录', '备注', '添加时间'] as const

/** 渲染 CSV 清单：BOM + CRLF 行尾，为的是 Excel 双击能直接读 */
export function renderCsv(rows: BookmarkListRow[]): string {
    const lines: string[] = [CSV_HEADERS.join(',')]
    for (const row of rows) {
        lines.push(
            [
                csvCell(row.bookName),
                csvCell(row.bookAuthor),
                csvCell(formatChapter(row)),
                csvCell(formatPosition(row)),
                csvCell(row.excerpt),
                csvCell(row.note),
                formatStamp(row.createdAt),
            ].join(','),
        )
    }
    // BOM：没有它，Windows 的 Excel 会把中文读成乱码
    return `\uFEFF${lines.join('\r\n')}\r\n`
}

/**
 * 文件名
 *
 * 单本书时带上书名（「书签-测试小说·甲-20261003.md」），全部时不带 ——
 * 导出一本书和一整份清单，从文件名就该能分出来。
 * 书名的非法字符（路径分隔符、控制字符、Windows 的保留字符）与超长都要处理：
 * 这个名字会进 `Content-Disposition`，脏字符会把响应头弄坏。
 */
export function bookmarkFileName(
    rows: BookmarkListRow[],
    format: BookmarkListFormat,
    at: number,
): string {
    const stamp = formatStampCompact(at)
    const bookName =
        rows.length > 0 && new Set(rows.map((r) => r.bookName)).size === 1
            ? String(rows[0]!.bookName ?? '').trim()
            : ''
    const safe = bookName
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 40)
        .trim()
    const stem = safe === '' ? '书签清单' : `书签-${safe}`
    return `${stem}-${stamp}.${format}`
}

/**
 * 不做 `Content-Disposition` 的拼装
 *
 * 那个函数 `index.ts` 里已经有了（媒体下载也在用同一份），且已经把
 * 「中文文件名必须走 `filename*`、头部里不能出现非 ASCII」这件事处理过了。
 * 在这里再写一份只会让两条路的转义规则慢慢分叉。
 */

export interface BookmarkFilter {
    sourceId?: string
    bookUrl?: string
}

/**
 * 从 D1 取清单要的行
 *
 * 分两次查、在内存里拼书名：`bookmarks` 里有 `source_id` / `book_url`，
 * 而书名在 `shelf` 里，两张表的键不同（`shelf.book_key` 是「书源 id + 换行 + 书籍地址」），
 * 用 SQL 拼这个键就得写字符串连接 + 换行，既不好读也容易在换行上出错。
 * 书架上的书才有书名，不在书架的书签退回空书名 —— **不丢条目**。
 *
 * 排序按「章节 → 页」，与阅读顺序一致；书签是攒下来的东西，按添加时间排读起来是乱的。
 */
export async function loadBookmarkRows(
    db: PlatformDb,
    user: Pick<AccountUser, 'id'>,
    filter: BookmarkFilter = {},
): Promise<BookmarkListRow[]> {
    const owner = ownerForUser(user)

    const where: string[] = ['owner = ?']
    const binds: unknown[] = [owner]
    if (filter.sourceId && filter.bookUrl) {
        where.push('source_id = ?', 'book_url = ?')
        binds.push(filter.sourceId, filter.bookUrl)
    }

    const [bookmarkRows, shelfRows] = await Promise.all([
        db
            .prepare(
                `SELECT source_id, book_url, chapter_url, chapter_name, chapter_index,
                        page_index, percent, excerpt, note, created_at
                   FROM bookmarks WHERE ${where.join(' AND ')}
                  ORDER BY source_id, book_url, chapter_index, page_index, created_at`,
            )
            .bind(...binds)
            .all<Record<string, unknown>>(),
        db
            .prepare('SELECT source_id, book_url, name, author FROM shelf WHERE owner = ?')
            .bind(owner)
            .all<Record<string, unknown>>(),
    ])

    const names = new Map<string, { name: string; author: string }>()
    for (const row of shelfRows.results ?? []) {
        const key = `${String(row.source_id ?? '')}\n${String(row.book_url ?? '')}`
        names.set(key, {
            name: String(row.name ?? ''),
            author: String(row.author ?? ''),
        })
    }

    return (bookmarkRows.results ?? []).map((row) => {
        const sourceId = String(row.source_id ?? '')
        const bookUrl = String(row.book_url ?? '')
        const meta = names.get(`${sourceId}\n${bookUrl}`)
        return {
            bookName: meta?.name ?? '',
            bookAuthor: meta?.author ?? '',
            chapterName: String(row.chapter_name ?? ''),
            chapterIndex: Number(row.chapter_index ?? 0),
            pageIndex: Number(row.page_index ?? 0),
            percent: Number(row.percent ?? 0),
            excerpt: String(row.excerpt ?? ''),
            note: String(row.note ?? ''),
            createdAt: Number(row.created_at ?? 0),
        }
    })
}
