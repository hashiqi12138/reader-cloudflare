import { describe, expect, it } from 'vitest'

import { base64OfUtf8, utf8OfBase64 } from '../src/lib/base64'

/**
 * base64 的 UTF-8 语义
 *
 * 这一层值得单测，是因为它最早用的是 `btoa(str)` —— 那东西对**中文直接抛错**
 * （`btoa() can only operate on characters in the Latin1 range`），
 * 而书源里对中文做 base64 是最常见的用法。全量探测里就有一条源栽在这上面，
 * 报的还是与书源毫无关系的一句宿主错误。
 */
describe('base64 按 UTF-8 编解码', () => {
    it('中文能编码，且是标准 base64（与 Node 的 Buffer 一致）', () => {
        const text = '斗破苍穹'
        const expected = Buffer.from(text, 'utf8').toString('base64')
        expect(base64OfUtf8(text)).toBe(expected)
    })

    it('中文能原样解回来', () => {
        for (const text of ['斗破苍穹', '第123章 · 起风了', 'emoji 🐟 与标点「」']) {
            expect(utf8OfBase64(base64OfUtf8(text))).toBe(text)
        }
    })

    it('空串与纯 ASCII 也对得上', () => {
        expect(base64OfUtf8('')).toBe('')
        expect(base64OfUtf8('abc')).toBe('YWJj')
        expect(utf8OfBase64('YWJj')).toBe('abc')
    })

    it('Latin1 之外的字符不再抛错（这正是修之前的行为）', () => {
        expect(() => base64OfUtf8('中文')).not.toThrow()
        // 对照：直接用 btoa 会抛
        expect(() => btoa('中文')).toThrow()
    })

    it('较长的文本也正确（逐字节拼接不会在中途出错）', () => {
        const text = '正文'.repeat(2000)
        expect(utf8OfBase64(base64OfUtf8(text))).toBe(text)
    })

    it('不是合法 base64 时解码抛错，由调用方决定怎么兜', () => {
        expect(() => utf8OfBase64('这不是 base64!!')).toThrow()
    })
})
