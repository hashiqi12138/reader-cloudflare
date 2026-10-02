/*
 * 书签输入的规范化
 *
 * 只测 `normalizeBookmarkInput` 这一个纯函数：它是「浏览器传上来的 JSON」到
 * 「入库形状」之间的那一道关口，全部是纯计算，不需要 D1 就能把边界钉住。
 *
 * 增删改查本身没在这里测（那需要真的 D1），它们的端到端覆盖在
 * scripts/smoke.mjs 里 —— 那一段走的是真实 HTTP + 真实数据库。
 */

import { describe, expect, it } from 'vitest'

import { normalizeBookmarkInput } from '../src/data/bookmarks'
import { DataError } from '../src/data/types'

/** 一份最小的合法输入，各用例只覆盖自己关心的那几项 */
const base = {
    sourceId: 'user:https://example.com',
    bookUrl: 'https://example.com/book/1',
    chapterUrl: 'https://example.com/book/1/chapter/2',
}

describe('normalizeBookmarkInput', () => {
    it('最小输入也能收敛出完整形状，可选字段给默认值', () => {
        expect(normalizeBookmarkInput(base)).toEqual({
            sourceId: base.sourceId,
            bookUrl: base.bookUrl,
            chapterUrl: base.chapterUrl,
            chapterName: '',
            chapterIndex: 0,
            pageIndex: 0,
            percent: 0,
            excerpt: '',
            note: '',
        })
    })

    it('缺必填字段时抛 DataError（不是 TypeError），状态与 code 都要对', () => {
        for (const field of ['sourceId', 'bookUrl', 'chapterUrl']) {
            const input = { ...base, [field]: '' }
            let caught: unknown = null
            try {
                normalizeBookmarkInput(input)
            } catch (err) {
                caught = err
            }
            expect(caught).toBeInstanceOf(DataError)
            // 收窄之后再断言具体字段：路由层就是靠 code 决定回哪个状态码的
            const dataError = caught as DataError
            expect(dataError.code).toBe('invalid_bookmark_input')
            expect(dataError.status).toBe(400)
            expect(dataError.message).toContain(field)
        }
    })

    it('必填字段只接受非空字符串，数字/对象/数组一律拒掉', () => {
        expect(() => normalizeBookmarkInput({ ...base, sourceId: 123 })).toThrow(DataError)
        expect(() => normalizeBookmarkInput({ ...base, bookUrl: {} })).toThrow(DataError)
        expect(() => normalizeBookmarkInput({ ...base, chapterUrl: [] })).toThrow(DataError)
        expect(() => normalizeBookmarkInput({ ...base, bookUrl: '   ' })).toThrow(DataError)
    })

    it('首尾空白会被去掉：地址带空格是复制粘贴的常见意外', () => {
        const out = normalizeBookmarkInput({ ...base, bookUrl: `  ${base.bookUrl}  ` })
        expect(out.bookUrl).toBe(base.bookUrl)
    })

    it('过长的必填字段直接拒掉，而不是截断', () => {
        // 地址被截断之后指向的就是另一本书了，这种「静默改数据」不能做
        expect(() =>
            normalizeBookmarkInput({ ...base, bookUrl: `https://e.com/${'x'.repeat(3000)}` }),
        ).toThrow(DataError)
    })

    it('章节序号与页码取非负整数；负数、小数、非数字都退化成 0', () => {
        expect(normalizeBookmarkInput({ ...base, chapterIndex: -3 }).chapterIndex).toBe(0)
        expect(normalizeBookmarkInput({ ...base, chapterIndex: 4.7 }).chapterIndex).toBe(4)
        expect(normalizeBookmarkInput({ ...base, chapterIndex: '5' }).chapterIndex).toBe(0)
        expect(normalizeBookmarkInput({ ...base, pageIndex: Number.NaN }).pageIndex).toBe(0)
        expect(
            normalizeBookmarkInput({ ...base, pageIndex: Number.POSITIVE_INFINITY }).pageIndex,
        ).toBe(0)
    })

    it('percent 夹在 0～1 之间：滚动位置是按比例记的，越界值只会跳错地方', () => {
        expect(normalizeBookmarkInput({ ...base, percent: 0.42 }).percent).toBeCloseTo(0.42)
        expect(normalizeBookmarkInput({ ...base, percent: 1.8 }).percent).toBe(1)
        expect(normalizeBookmarkInput({ ...base, percent: -0.5 }).percent).toBe(0)
        expect(normalizeBookmarkInput({ ...base, percent: '0.5' }).percent).toBe(0)
    })

    it('摘录与备注超长时截断而不是拒掉（长度来自正文，用户控制不了）', () => {
        const out = normalizeBookmarkInput({
            ...base,
            excerpt: '摘'.repeat(500),
            note: '注'.repeat(900),
        })
        expect(out.excerpt).toHaveLength(120)
        expect(out.note).toHaveLength(500)
    })

    it('章节名超长时截断到 200 字', () => {
        expect(
            normalizeBookmarkInput({ ...base, chapterName: '章'.repeat(400) }).chapterName,
        ).toHaveLength(200)
    })

    it('非字符串的摘录/备注当成空，不会变成 "undefined" 或 "[object Object]"', () => {
        const out = normalizeBookmarkInput({ ...base, excerpt: undefined, note: { a: 1 } })
        expect(out.excerpt).toBe('')
        expect(out.note).toBe('')
    })

    it('备注里的换行保留（用户可能写多行），首尾空白去掉', () => {
        const out = normalizeBookmarkInput({ ...base, note: '  第一行\n第二行  ' })
        expect(out.note).toBe('第一行\n第二行')
    })
})
