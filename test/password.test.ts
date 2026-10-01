import { describe, expect, it } from 'vitest'
import {
    PBKDF2_ITERATIONS,
    PBKDF2_MAX_ITERATIONS,
    hashPassword,
    randomToken,
    verifyPassword,
} from '../src/lib/password'

/**
 * 口令哈希
 *
 * 迭代次数在测试里调到很小（2000）—— 这一层要验的是「同一条口令能验过、
 * 别的口令验不过、盐不一样结果就不一样」，不是「算得够慢」。
 * 真实使用的迭代次数由 PBKDF2_ITERATIONS 决定，运行时的开销另测。
 */
const FAST = 2000

describe('hashPassword / verifyPassword', () => {
    it('同一条口令验得通过', async () => {
        const record = await hashPassword('correct horse battery staple', FAST)
        expect(await verifyPassword('correct horse battery staple', record)).toBe(true)
    })

    it('换个口令验不过', async () => {
        const record = await hashPassword('correct horse battery staple', FAST)
        expect(await verifyPassword('Correct horse battery staple', record)).toBe(false)
        expect(await verifyPassword('', record)).toBe(false)
        expect(await verifyPassword('correct horse battery stapl', record)).toBe(false)
    })

    it('同一条口令每次的盐都不同，因此哈希也不同', async () => {
        const a = await hashPassword('same-password', FAST)
        const b = await hashPassword('same-password', FAST)
        expect(a.salt).not.toBe(b.salt)
        expect(a.hash).not.toBe(b.hash)
        // 但两条都能验过
        expect(await verifyPassword('same-password', a)).toBe(true)
        expect(await verifyPassword('same-password', b)).toBe(true)
    })

    it('迭代次数随记录一起存下来（以后调高不必强制老账号改密码）', async () => {
        const record = await hashPassword('whatever', 5000)
        expect(record.iterations).toBe(5000)
        expect(await verifyPassword('whatever', record)).toBe(true)
        // 用错的迭代次数就验不过 —— 说明它确实参与了派生
        expect(await verifyPassword('whatever', { ...record, iterations: 4000 })).toBe(false)
    })

    it('带中文与多字节字符的口令按 UTF-8 处理', async () => {
        const record = await hashPassword('口令·测试🔒', FAST)
        expect(await verifyPassword('口令·测试🔒', record)).toBe(true)
        expect(await verifyPassword('口令·测试', record)).toBe(false)
    })

    it('哈希与盐都是 base64，长度稳定', async () => {
        const record = await hashPassword('x'.repeat(20), FAST)
        expect(record.hash).toMatch(/^[A-Za-z0-9+/]+=*$/)
        expect(record.salt).toMatch(/^[A-Za-z0-9+/]+=*$/)
        expect(Buffer.from(record.hash, 'base64').length).toBe(32)
        expect(Buffer.from(record.salt, 'base64').length).toBe(16)
    })

    it('记录被弄坏时按「验不过」处理，而不是抛错', async () => {
        const record = await hashPassword('whatever', FAST)
        expect(await verifyPassword('whatever', { ...record, salt: '不是 base64??' })).toBe(false)
        expect(await verifyPassword('whatever', { ...record, iterations: -1 })).toBe(false)
    })

    it('默认迭代次数取 Workers 上限：低了没成本，高了线上直接注册失败', () => {
        // 下界：太低等于没加成本
        expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(100_000)
        // 上界才是这条测试存在的理由：超过 workerd 的上限会让**注册整个失败**，
        // 而本地 wrangler dev 不卡这条，所以只能在这里守住
        expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(PBKDF2_MAX_ITERATIONS)
    })

    it('迭代次数刚好卡在上限上（拿满可用的成本）', () => {
        expect(PBKDF2_ITERATIONS).toBe(PBKDF2_MAX_ITERATIONS)
    })
})

describe('randomToken', () => {
    it('长度与字符集符合 URL 安全要求', () => {
        const token = randomToken(32)
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(token.length).toBeGreaterThanOrEqual(40)
    })

    it('不会撞车（随机源必须够用）', () => {
        const set = new Set(Array.from({ length: 200 }, () => randomToken(32)))
        expect(set.size).toBe(200)
    })
})
