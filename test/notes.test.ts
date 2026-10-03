/*
 * 笔记入库前的校验
 *
 * 只测 `normalizeNoteInput` / `normalizeNoteText` 这两个纯函数：读/写要落到 D1 上，
 * 用一个自己写的假 D1 去测等于测那个假实现 —— 那一半交给冒烟测试（`scripts/smoke.mjs`）。
 *
 * 这里钉住的是**笔记与书签唯一的行为差别**：正文必填。
 * 书签可以只有一个位置，笔记不行 —— 空正文的笔记在列表里就是一行空白，
 * 而且还会占掉导出与备份里的位置。
 */

import { describe, expect, it } from 'vitest'

import { MAX_NOTE_TEXT, normalizeNoteInput, normalizeNoteText } from '../src/data/notes'
import { DataError } from '../src/data/types'

const input = (over: Record<string, unknown> = {}) => ({
    sourceId: 'builtin:fixture-css',
    bookUrl: 'http://example.com/book/1',
    text: '这一段的想法',
    ...over,
})

describe('写入前的归一', () => {
    it('正文、书源与书籍地址是必填的', () => {
        expect(() => normalizeNoteInput(input({ text: '' }))).toThrow(/缺少 text/)
        expect(() => normalizeNoteInput(input({ text: '   ' }))).toThrow(/缺少 text/)
        expect(() => normalizeNoteInput(input({ text: 42 }))).toThrow(/缺少 text/)
        expect(() => normalizeNoteInput(input({ sourceId: '' }))).toThrow(/缺少 sourceId/)
        expect(() => normalizeNoteInput(input({ bookUrl: undefined }))).toThrow(/缺少 bookUrl/)
    })

    it('报错带上自己的 code，前端据此分支', () => {
        try {
            normalizeNoteInput(input({ text: '' }))
            throw new Error('这里应该抛错')
        } catch (err) {
            expect(err).toBeInstanceOf(DataError)
            expect((err as DataError).code).toBe('invalid_note_input')
        }
    })

    it('正文超长被拒；正好到上限要能过', () => {
        expect(() => normalizeNoteInput(input({ text: '字'.repeat(MAX_NOTE_TEXT + 1) }))).toThrow(
            /超过 5000 字符/,
        )
        expect(normalizeNoteInput(input({ text: '字'.repeat(MAX_NOTE_TEXT) })).text).toHaveLength(
            MAX_NOTE_TEXT,
        )
    })

    it('改正文走的是同一套校验 —— 空正文不是「清空」，是这条笔记不该存在', () => {
        expect(() => normalizeNoteText('')).toThrow(/缺少 text/)
        expect(normalizeNoteText('  改好了  ')).toBe('改好了')
    })

    it('正文两端的空白被去掉，但中间的不动', () => {
        const { text } = normalizeNoteInput(input({ text: '  第一行\n\n第二行  ' }))
        expect(text).toBe('第一行\n\n第二行')
    })

    it('摘录超长是**截断**而不是报错 —— 它来自正文，长度不是用户能控制的', () => {
        const { excerpt } = normalizeNoteInput(input({ excerpt: '摘'.repeat(500) }))
        expect(excerpt).toHaveLength(200)
    })

    it('章节名超长同样截断', () => {
        const { chapterName } = normalizeNoteInput(input({ chapterName: '章'.repeat(500) }))
        expect(chapterName).toHaveLength(200)
    })

    it('位置字段容错：负数与浮点收敛，非数字退回 0', () => {
        expect(normalizeNoteInput(input({ chapterIndex: -3 })).chapterIndex).toBe(0)
        expect(normalizeNoteInput(input({ chapterIndex: 2.7 })).chapterIndex).toBe(2)
        expect(normalizeNoteInput(input({ chapterIndex: 'x' })).chapterIndex).toBe(0)
        expect(normalizeNoteInput(input({ pageIndex: undefined })).pageIndex).toBe(0)
    })

    it('滚动位置夹到 0～1（越界的备份文件或老版本客户端都可能送来）', () => {
        expect(normalizeNoteInput(input({ percent: 1.4 })).percent).toBe(1)
        expect(normalizeNoteInput(input({ percent: -0.2 })).percent).toBe(0)
        expect(normalizeNoteInput(input({ percent: Number.NaN })).percent).toBe(0)
        expect(normalizeNoteInput(input({ percent: 0.375 })).percent).toBe(0.375)
    })

    it('完全不给可选字段也能写进去（位置与摘录都是「有就带上」）', () => {
        const data = normalizeNoteInput({ sourceId: 'a', bookUrl: '/b', text: '想法' })
        expect(data).toEqual({
            sourceId: 'a',
            bookUrl: '/b',
            chapterName: '',
            chapterIndex: 0,
            pageIndex: 0,
            percent: 0,
            excerpt: '',
            text: '想法',
        })
    })
})
