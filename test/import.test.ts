/**
 * 书源导入的单元测试
 *
 * 导入是「不可信输入」的边界：书源文件来自社区，可能是坏 JSON、可能根本不是书源、
 * 也可能一条 500 条的集合里混着两条坏的。这里的每个用例都对应一个真实的坏输入形态。
 *
 * 这一层是纯函数（不碰 D1），所以能像其它引擎测试一样在 Node 里毫秒级跑完。
 */

import { describe, expect, it } from 'vitest'

import { parseImportPayload, validateImportedSource } from '../src/data/db'
import { DataError, userIdForUrl } from '../src/data/types'

describe('导入内容的结构识别', () => {
    it('接受裸数组', () => {
        expect(parseImportPayload('[{"a":1},{"b":2}]')).toHaveLength(2)
    })

    it('接受 { "sources": [...] } 包装', () => {
        expect(parseImportPayload('{"sources":[{"a":1}]}')).toHaveLength(1)
    })

    it('坏 JSON 报 invalid_json，并把解析器的原话带上', () => {
        try {
            parseImportPayload('{ 不是 JSON')
            throw new Error('这里本该抛错')
        } catch (err) {
            expect(err).toBeInstanceOf(DataError)
            expect((err as DataError).code).toBe('invalid_json')
            expect((err as DataError).status).toBe(400)
            // 原始报错是定位问题的关键，不能被吞掉
            expect((err as DataError).message).toContain('导入内容不是合法 JSON')
        }
    })

    it('对象里没有 sources 数组就报 invalid_shape', () => {
        expect(() => parseImportPayload('{"foo":1}')).toThrowError(/invalid_shape|必须是书源数组/)
    })

    it('null 与纯数字这类合法 JSON 但不是书源，报 invalid_shape', () => {
        for (const text of ['null', '42', '"abc"']) {
            expect(() => parseImportPayload(text)).toThrowError(/必须是书源数组/)
        }
    })
})

describe('单条书源的校验', () => {
    const ok = (raw: unknown, index = 0) => validateImportedSource(raw, index)

    it('名字与地址齐全时通过，并原样保留规则', () => {
        const result = ok({
            bookSourceName: '示例源',
            bookSourceUrl: 'https://example.com',
            searchUrl: 'https://example.com/s?q={{key}}',
        })
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.name).toBe('示例源')
            expect(result.url).toBe('https://example.com')
            expect(result.source.searchUrl).toBe('https://example.com/s?q={{key}}')
        }
    })

    it('名字两端的空白会被去掉', () => {
        const result = ok({ bookSourceName: '  示例源  ', bookSourceUrl: 'https://example.com' })
        expect(result.ok && result.name).toBe('示例源')
    })

    it('缺名字 / 缺地址 / 名字是空白，都拒绝', () => {
        const cases = [
            { bookSourceUrl: 'https://example.com' },
            { bookSourceName: '示例源' },
            { bookSourceName: '   ', bookSourceUrl: 'https://example.com' },
        ]
        for (const raw of cases) {
            const result = ok(raw)
            expect(result.ok).toBe(false)
            if (!result.ok) expect(result.rejected.reason).toMatch(/缺少 bookSource(Name|Url)/)
        }
    })

    it('地址不是合法 URL、或协议不是 http(s)，都拒绝', () => {
        const bad = ['不是地址', 'ftp://example.com', 'file:///etc/passwd', 'example.com']
        for (const url of bad) {
            const result = ok({ bookSourceName: '示例源', bookSourceUrl: url })
            expect(result.ok, `${url} 本该被拒`).toBe(false)
            if (!result.ok)
                expect(result.rejected.reason).toMatch(/不是合法地址|只支持 http\/https/)
        }
    })

    it('非对象（数组 / null / 字符串）一律拒绝', () => {
        for (const raw of [[], null, 'abc', 42]) {
            const result = ok(raw)
            expect(result.ok).toBe(false)
            if (!result.ok) expect(result.rejected.reason).toBe('不是对象')
        }
    })

    it('被拒绝时用「第 N 条」定位，而不是丢掉位置信息', () => {
        const result = validateImportedSource({ bookSourceUrl: 'https://example.com' }, 6)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.rejected.name).toBe('第 7 条')
    })

    it('名字或地址超长会被拒绝（挡住「误把长文本当书源」）', () => {
        const longName = ok({
            bookSourceName: 'x'.repeat(201),
            bookSourceUrl: 'https://example.com',
        })
        expect(longName.ok).toBe(false)

        const longUrl = ok({
            bookSourceName: '示例源',
            bookSourceUrl: 'https://example.com/' + 'x'.repeat(600),
        })
        expect(longUrl.ok).toBe(false)
        if (!longUrl.ok) expect(longUrl.rejected.reason).toContain('bookSourceUrl 超过')
    })

    it('单条体积超过上限时拒绝，并报出实际大小', () => {
        const result = ok({
            bookSourceName: '巨型源',
            bookSourceUrl: 'https://example.com',
            bookSourceComment: 'x'.repeat(300 * 1024),
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.rejected.reason).toMatch(/超过上限 \d+ KB/)
    })
})

describe('书源 id 的派生', () => {
    it('同一个站点地址派生出同一个 id —— 这是「重复导入算更新」的依据', () => {
        expect(userIdForUrl('https://example.com')).toBe(userIdForUrl('https://example.com'))
        expect(userIdForUrl('https://example.com')).toMatch(/^user:/)
    })

    it('不同站点地址派生出不同 id', () => {
        expect(userIdForUrl('https://a.com')).not.toBe(userIdForUrl('https://b.com'))
    })
})
