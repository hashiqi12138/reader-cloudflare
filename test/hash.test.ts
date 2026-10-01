import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { md5Hex } from '../src/lib/hash'

/**
 * MD5 是「要么全对、要么全错」的那类实现：中间任何一处移位或字节序写错，
 * 结果会完全不同。所以这里不和写死的期望值对，而是**直接和 `node:crypto` 对拍** ——
 * 自己写的实现和 Node 的实现对上，才算真的对。
 */
describe('md5Hex', () => {
    it('和 node:crypto 的结果一致（含边界长度与多字节字符）', () => {
        const samples = [
            '',
            'a',
            'abc',
            'message digest',
            'abcdefghijklmnopqrstuvwxyz',
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
            '1234567890'.repeat(8),
            // 关键边界：55/56/57 与 63/64/65 字节，直接决定「补位」写对没有
            'x'.repeat(55),
            'x'.repeat(56),
            'x'.repeat(57),
            'x'.repeat(63),
            'x'.repeat(64),
            'x'.repeat(65),
            'x'.repeat(1000),
            // 多字节：必须按 UTF-8 取字节，按 UTF-16 会算出完全不同的值
            '中文',
            '禁漫天堂API',
            '185Hcomic3PAPP7R',
            '简体中文 + English + 日本語 + 1234567890',
        ]

        for (const sample of samples) {
            const expected = createHash('md5').update(sample, 'utf8').digest('hex')
            expect(md5Hex(sample), `输入 ${JSON.stringify(sample.slice(0, 20))}`).toBe(expected)
        }
    })

    it('输出固定是 32 位小写十六进制', () => {
        const out = md5Hex('中文')
        expect(out).toMatch(/^[0-9a-f]{32}$/)
    })

    it('对已知向量给出标准答案', () => {
        expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
        expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
        expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe(
            '9e107d9d372bb6826bd81d3542a419d6',
        )
    })
})
