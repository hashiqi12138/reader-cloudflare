import { describe, expect, it } from 'vitest'
import { normalizeUsername, ownerForUser } from '../src/data/accounts'

/**
 * 用户名的规范化与校验
 *
 * 归一化的意义在于**唯一约束落在哪一列上**：不统一成小写，
 * Alice 与 alice 会变成两个账号，而用户自己完全看不出区别。
 */
describe('normalizeUsername', () => {
    it('统一成小写并去掉首尾空格', () => {
        expect(normalizeUsername('  Alice  ')).toBe('alice')
        expect(normalizeUsername('BOB_2026')).toBe('bob_2026')
    })

    it('允许字母、数字、下划线与连字符', () => {
        expect(normalizeUsername('a-b_c1')).toBe('a-b_c1')
    })

    it('空值与纯空白被拒', () => {
        expect(() => normalizeUsername('')).toThrow()
        expect(() => normalizeUsername('   ')).toThrow()
        expect(() => normalizeUsername(null)).toThrow()
        expect(() => normalizeUsername(undefined)).toThrow()
        expect(() => normalizeUsername(123)).toThrow()
    })

    it('太短或太长被拒（3～32 位）', () => {
        expect(() => normalizeUsername('ab')).toThrow()
        expect(() => normalizeUsername('a'.repeat(33))).toThrow()
        expect(normalizeUsername('abc')).toBe('abc')
        expect(normalizeUsername('a'.repeat(32))).toBe('a'.repeat(32))
    })

    it('中文字符与其它符号被拒（用户名会被放进 URL 与日志，保持 ASCII 最省事）', () => {
        expect(() => normalizeUsername('张三')).toThrow()
        expect(() => normalizeUsername('a b')).toThrow()
        expect(() => normalizeUsername('a@b')).toThrow()
        expect(() => normalizeUsername('../etc/passwd')).toThrow()
    })
})

describe('ownerForUser', () => {
    it('账号数据在 shelf / reading_progress 里的 owner 带前缀，不会和旧的匿名 token 撞', () => {
        expect(ownerForUser({ id: 7 })).toBe('u:7')
        // 旧的匿名 token 是 20～64 位 URL 安全字符，不可能以 `u:` 开头（会含冒号）
        expect(ownerForUser({ id: 7 })).not.toMatch(/^[A-Za-z0-9_-]+$/)
    })
})
