import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import {
    normalizeDisplayName,
    normalizePassword,
    normalizeUsername,
    ownerForUser,
} from '../src/data/accounts'

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

/**
 * 显示名与用户名**刻意是两套规则**
 *
 * 用户名会进 URL、日志与 `owner` 值，所以限死 ASCII；显示名只出现在界面上，
 * 用户想叫「张三」就叫「张三」。把它们写成一套（比如都要求 ASCII），
 * 结果就是中文用户只能叫 `zhangsan2026`。
 */
describe('normalizeDisplayName', () => {
    it('允许中文、空格与常见符号，只去掉首尾空白', () => {
        expect(normalizeDisplayName('张三')).toBe('张三')
        expect(normalizeDisplayName('  Reader One  ')).toBe('Reader One')
        expect(normalizeDisplayName('读书人·阿吉')).toBe('读书人·阿吉')
        expect(normalizeDisplayName('a@b.c')).toBe('a@b.c')
    })

    it('空值与纯空白被拒', () => {
        expect(() => normalizeDisplayName('')).toThrow()
        expect(() => normalizeDisplayName('   ')).toThrow()
        expect(() => normalizeDisplayName(null)).toThrow()
        expect(() => normalizeDisplayName(42)).toThrow()
    })

    it('超过 24 个字被拒', () => {
        expect(normalizeDisplayName('字'.repeat(24))).toBe('字'.repeat(24))
        expect(() => normalizeDisplayName('字'.repeat(25))).toThrow()
    })

    it('控制字符被拒：换行会撑破界面，U+202E 能把一行字显示成相反的顺序', () => {
        expect(() => normalizeDisplayName('张三\n李四')).toThrow()
        expect(() => normalizeDisplayName('张三\t李四')).toThrow()
        expect(() => normalizeDisplayName('abc\u202Edef')).toThrow()
        expect(() => normalizeDisplayName('a\u0000b')).toThrow()
    })

    it('用户名限 ASCII，显示名不限 —— 这就是两个函数存在的理由', () => {
        expect(() => normalizeUsername('张三')).toThrow()
        expect(normalizeDisplayName('张三')).toBe('张三')
    })
})

describe('normalizePassword', () => {
    it('长度上下限都在这一份里（注册与改密码共用，不能各写一遍）', () => {
        expect(normalizePassword('12345678')).toBe('12345678')
        expect(() => normalizePassword('1234567')).toThrow()
        expect(() => normalizePassword('')).toThrow()
        expect(() => normalizePassword(undefined)).toThrow()
        expect(() => normalizePassword(12345678)).toThrow()
        expect(normalizePassword('a'.repeat(200))).toBe('a'.repeat(200))
        expect(() => normalizePassword('a'.repeat(201))).toThrow()
    })

    it('口令原样返回：不做 trim、不转小写（口令里的空格是它的一部分）', () => {
        expect(normalizePassword(' pass word ')).toBe(' pass word ')
    })
})

/**
 * 「两处共用同一份」这件事要有人看着
 *
 * 注册与改密码各写一遍长度校验的话，改密码那条路就成了一次绕过注册限制的机会
 * （把密码改成 1 位）。这条扫的是 `accounts.ts` 本身：长度常量除了声明处，
 * 只允许出现在 `normalizePassword` 里。
 */
describe('口令下限只存在于一处', () => {
    it('accounts.ts 里 MIN_PASSWORD_LENGTH 的引用都在 normalizePassword 体内', () => {
        const text = readFileSync('src/data/accounts.ts', 'utf8')
        const start = text.indexOf('export function normalizePassword')
        expect(start).toBeGreaterThan(0)
        // 函数体：从签名后的第一个 { 到配对的 }
        const open = text.indexOf('{', start)
        let depth = 0
        let close = open
        for (let i = open; i < text.length; i += 1) {
            if (text[i] === '{') depth += 1
            else if (text[i] === '}') {
                depth -= 1
                if (depth === 0) {
                    close = i
                    break
                }
            }
        }
        const inside = text.slice(open, close)
        const outside = text.slice(0, start) + text.slice(close)
        const refs = (source: string) => (source.match(/MIN_PASSWORD_LENGTH/g) ?? []).length

        // 声明行（常量定义）在外面，只有那一处；其余引用必须在函数体内
        expect(refs(inside)).toBeGreaterThan(0)
        expect(refs(outside)).toBe(1)
    })
})

describe('ownerForUser', () => {
    it('账号数据在 shelf / reading_progress 里的 owner 带前缀，不会和旧的匿名 token 撞', () => {
        expect(ownerForUser({ id: 7 })).toBe('u:7')
        // 旧的匿名 token 是 20～64 位 URL 安全字符，不可能以 `u:` 开头（会含冒号）
        expect(ownerForUser({ id: 7 })).not.toMatch(/^[A-Za-z0-9_-]+$/)
    })
})
