import { describe, expect, it } from 'vitest'

import {
    bookmarkFileName,
    csvCell,
    escapeMarkdownCell,
    formatChapter,
    formatPosition,
    formatStamp,
    formatStampCompact,
    renderCsv,
    renderMarkdown,
    type BookmarkListRow,
} from '../src/data/bookmarkList'

/**
 * 书签清单（Markdown / CSV）的纯函数
 *
 * 这一组盯的是「导出之后拿去用会怎样」，而不是「函数没报错」：
 * 时间是不是真的是 +8、Markdown 表格会不会被摘录里的 `|` 和换行拆散、
 * CSV 能不能被 Excel 读（BOM）与能不能被解析回来（引号转义）、
 * 文件名里的中文与非法字符。
 */

/** 2026-10-03 05:04:05 UTC → UTC+8 是 13:04 */
const T = Date.UTC(2026, 9, 3, 5, 4, 5)

function row(over: Partial<BookmarkListRow> = {}): BookmarkListRow {
    return {
        bookName: '测试小说·甲',
        bookAuthor: '作者甲',
        chapterName: '第一章 起风了',
        chapterIndex: 0,
        pageIndex: 0,
        percent: 0,
        excerpt: '这是一段摘录',
        note: '这里的伏笔',
        createdAt: T,
        ...over,
    }
}

describe('时间与位置', () => {
    it('按 UTC+8 渲染，并在文件名里给紧凑格式', () => {
        expect(formatStamp(T)).toBe('2026-10-03 13:04')
        expect(formatStampCompact(T)).toBe('20261003')
    })

    it('跨日边界按 +8 算（UTC 还是前一天）', () => {
        const late = Date.UTC(2026, 9, 3, 20, 30) // +8 → 10-04 04:30
        expect(formatStamp(late)).toBe('2026-10-04 04:30')
    })

    it('位置：有百分比写百分比，否则写页码（页码从 1 数）', () => {
        expect(formatPosition({ pageIndex: 0, percent: 0 })).toBe('第 1 页')
        expect(formatPosition({ pageIndex: 2, percent: 0 })).toBe('第 3 页')
        expect(formatPosition({ pageIndex: 2, percent: 0.425 })).toBe('42.5%')
    })

    it('章节名缺了就退回「第 N 章」', () => {
        expect(formatChapter({ chapterName: '  ', chapterIndex: 4 })).toBe('第 5 章')
        expect(formatChapter({ chapterName: '楔子', chapterIndex: 4 })).toBe('楔子')
    })
})

describe('转义', () => {
    it('Markdown 单元格：`|` 与换行必须处理，否则整张表错位', () => {
        expect(escapeMarkdownCell('a|b')).toBe('a\\|b')
        expect(escapeMarkdownCell('第一行\n第二行')).toBe('第一行<br>第二行')
        expect(escapeMarkdownCell('反斜杠\\')).toBe('反斜杠\\\\')
        // 反斜杠要先转义：否则后面那个 `\|` 会被当成「真的竖线」
        expect(escapeMarkdownCell('a\\|b')).toBe('a\\\\\\|b')
    })

    it('CSV 单元格：只有必要时才加引号，内部引号翻倍', () => {
        expect(csvCell('普通')).toBe('普通')
        expect(csvCell('带,逗号')).toBe('"带,逗号"')
        expect(csvCell('带"引号')).toBe('"带""引号"')
        expect(csvCell('跨\n行')).toBe('"跨\n行"')
    })
})

describe('Markdown 清单', () => {
    it('按书分组，表头写清时区与条数', () => {
        const md = renderMarkdown(
            [row(), row({ bookName: '测试小说·乙', bookAuthor: '作者乙' }), row()],
            T,
        )
        expect(md).toContain('# 书签清单')
        expect(md).toContain('- 导出时间：2026-10-03 13:04（UTC+8）')
        expect(md).toContain('- 共 3 条，来自 2 本书')
        expect(md).toContain('## 测试小说·甲（作者甲）')
        expect(md).toContain('## 测试小说·乙（作者乙）')
        // 每本书一张表，表头只出现两次
        expect(md.match(/\| 章节 \| 位置 \| 摘录 \| 备注 \| 添加时间 \|/g)).toHaveLength(2)
    })

    it('摘录里的 `|` 与换行不会把表格拆散', () => {
        const md = renderMarkdown([row({ excerpt: 'a|b\nc', note: 'x|y' })], T)
        const dataLine = md.split('\n').find((line) => line.startsWith('| 第一章 起风了'))!
        // 5 列 → 6 个**未转义**的竖线（`\|` 是转义过的，不算分列）
        expect(dataLine.split(/(?<!\\)\|/)).toHaveLength(7)
        expect(dataLine).toContain('a\\|b<br>c')
        expect(dataLine).toContain('x\\|y')
    })

    it('没有书签时也给一份能读的文件，而不是空字符串', () => {
        const md = renderMarkdown([], T)
        expect(md).toContain('- 共 0 条，来自 0 本书')
        expect(md).toContain('（还没有书签）')
        expect(md.endsWith('\n')).toBe(true)
    })
})

/** 一个够用的 CSV 解析器：只在测试里用，用来证明「写出去的还能读回来」 */
function parseCsv(text: string): string[][] {
    const body = text.replace(/^\uFEFF/, '')
    const rows: string[][] = []
    let field = ''
    let line: string[] = []
    let quoted = false
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i]!
        if (quoted) {
            if (ch === '"') {
                if (body[i + 1] === '"') {
                    field += '"'
                    i += 1
                } else quoted = false
            } else field += ch
            continue
        }
        if (ch === '"') {
            quoted = true
            continue
        }
        if (ch === ',') {
            line.push(field)
            field = ''
            continue
        }
        if (ch === '\r' && body[i + 1] === '\n') {
            line.push(field)
            rows.push(line)
            field = ''
            line = []
            i += 1
            continue
        }
        field += ch
    }
    if (field !== '' || line.length > 0) {
        line.push(field)
        rows.push(line)
    }
    return rows
}

describe('CSV 清单', () => {
    it('带 BOM、用 CRLF，表头是中文列名', () => {
        const csv = renderCsv([row()])
        expect(csv.startsWith('\uFEFF')).toBe(true)
        expect(csv.split('\r\n')[0]).toBe('\uFEFF书名,作者,章节,位置,摘录,备注,添加时间')
        expect(csv.endsWith('\r\n')).toBe(true)
    })

    it('写出去还能读回来（含逗号、引号、换行）', () => {
        const tricky = row({
            excerpt: '有,逗号 和 "引号"\n还有换行',
            note: '换行\r\n也有',
            bookName: '书名,带逗号',
        })
        const rows = parseCsv(renderCsv([tricky]))
        expect(rows[0]).toEqual(['书名', '作者', '章节', '位置', '摘录', '备注', '添加时间'])
        expect(rows[1]).toEqual([
            '书名,带逗号',
            '作者甲',
            '第一章 起风了',
            '第 1 页',
            '有,逗号 和 "引号"\n还有换行',
            '换行\r\n也有',
            '2026-10-03 13:04',
        ])
    })

    it('一条书签都没有时只有表头', () => {
        expect(parseCsv(renderCsv([]))).toHaveLength(1)
    })
})

describe('文件名', () => {
    it('单本书带书名，多于一本或零本用「书签清单」', () => {
        expect(bookmarkFileName([row()], 'md', T)).toBe('书签-测试小说·甲-20261003.md')
        expect(bookmarkFileName([row(), row({ bookName: '乙' })], 'csv', T)).toBe(
            '书签清单-20261003.csv',
        )
        expect(bookmarkFileName([], 'md', T)).toBe('书签清单-20261003.md')
    })

    it('书名里的路径分隔符与保留字符要清掉（它会进响应头）', () => {
        const name = bookmarkFileName([row({ bookName: 'a/b\\c:d*e?f"g<h>i|j' })], 'md', T)
        expect(name).toBe('书签-abcdefghij-20261003.md')
    })

    it('超长书名截断，且不留尾随空格', () => {
        const name = bookmarkFileName([row({ bookName: `${'长'.repeat(80)}` })], 'md', T)
        expect(name.length).toBeLessThanOrEqual('书签--20261003.md'.length + 40)
        expect(name.endsWith('-20261003.md')).toBe(true)
    })
})
