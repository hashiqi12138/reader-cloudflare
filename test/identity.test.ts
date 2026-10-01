/**
 * 身份校验的单元测试
 *
 * 这一层决定「书架归谁」，判断错了就是数据串户，所以边界逐条钉住。
 */

import { describe, expect, it } from 'vitest'

import { USER_HEADER, parseUserToken } from '../src/lib/identity'

describe('身份校验', () => {
    it('正常 token 原样返回', () => {
        const token = 'abcdef0123456789abcdef0123456789'
        expect(parseUserToken(token)).toBe(token)
    })

    it('两端空白会被去掉（HTTP 头值常有尾随空格）', () => {
        expect(parseUserToken('  abcdef0123456789abcd  ')).toBe('abcdef0123456789abcd')
    })

    it('允许 - 与 _ 这两种 URL 安全字符', () => {
        expect(parseUserToken('a-b_c-d_e-f_g-h_i-j_k-0123')).toBe('a-b_c-d_e-f_g-h_i-j_k-0123')
    })

    it('缺失、空串、空白串都拒绝', () => {
        for (const raw of [undefined, null, '', '   ']) {
            expect(() => parseUserToken(raw)).toThrowError(/缺少/)
        }
    })

    it('太短会被拒绝（太短就容易被猜到）', () => {
        expect(() => parseUserToken('abc')).toThrowError(/格式不对/)
        expect(() => parseUserToken('a'.repeat(19))).toThrowError(/格式不对/)
    })

    it('太长会被拒绝', () => {
        expect(() => parseUserToken('a'.repeat(65))).toThrowError(/格式不对/)
    })

    it('含非 URL 安全字符会被拒绝（避免注入到 SQL/头里）', () => {
        for (const raw of [
            'abcdef0123456789abc ',
            "abc'def0123456789abcd",
            'abc;def0123456789abc',
            '中文身份中文身份中文身份中文身份',
        ]) {
            expect(() => parseUserToken(raw)).toThrow()
        }
    })

    it('报错信息里带上头名，便于排查', () => {
        try {
            parseUserToken('')
        } catch (err) {
            expect(err instanceof Error && err.message).toContain(USER_HEADER)
        }
    })
})
