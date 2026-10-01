/**
 * 媒体地址签名的单元测试
 *
 * 签名是「媒体代取接口不会被当成开放代理」的唯一依据，所以这里必须验到：
 * 能验过正常签名，且**改一个字节、换一个密钥、超时**都验不过。
 */

import { describe, expect, it } from 'vitest'

import { MediaTokenError, signMediaToken, verifyMediaToken } from '../src/lib/signing'

const SECRET = 'a'.repeat(64)
const PAYLOAD = { sourceId: 'builtin:fixture-image', url: 'https://cdn.x.com/a.jpg' }
const TTL = 3600

/** 解开签名载荷，用来伪造「签名不动、内容改掉」的情况 */
function decodeBody(body: string): Record<string, unknown> {
    const normalized = body.replace(/-/g, '+').replace(/_/g, '/')
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(normalized + padding)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

describe('媒体地址签名', () => {
    it('签完能验回来，字段不丢', async () => {
        const token = await signMediaToken(SECRET, PAYLOAD, TTL)
        await expect(verifyMediaToken(SECRET, token)).resolves.toEqual(PAYLOAD)
    })

    it('token 是「载荷.签名」两段，且都可放进 URL 路径', async () => {
        const token = await signMediaToken(SECRET, PAYLOAD, TTL)
        expect(token.split('.')).toHaveLength(2)
        // 路径里不能出现 + / = 这些字符，否则 /api/media/:token 会被切坏
        expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    })

    it('载荷里带特殊字符（查询串、中文、逗号）也不受影响', async () => {
        const tricky = {
            sourceId: 'user:abc',
            url: 'https://cdn.x.com/图.jpg?a=1&b=%20&c=x,y',
        }
        const token = await signMediaToken(SECRET, tricky, TTL)
        await expect(verifyMediaToken(SECRET, token)).resolves.toEqual(tricky)
    })

    it('换一把密钥就验不过', async () => {
        const token = await signMediaToken(SECRET, PAYLOAD, TTL)
        await expect(verifyMediaToken('b'.repeat(64), token)).rejects.toThrowError(MediaTokenError)
    })

    it('改了目标地址就验不过（这正是签名要防的）', async () => {
        const token = await signMediaToken(SECRET, PAYLOAD, TTL)
        const [body, signature] = token.split('.')

        // 解开载荷、把地址换成别的站点、再用**原来那个签名**拼回去
        const payload = decodeBody(body!)
        payload.u = 'https://evil.example.com/a.jpg'
        const forged = btoa(JSON.stringify(payload))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '')

        expect(forged).not.toBe(body)
        await expect(verifyMediaToken(SECRET, `${forged}.${signature}`)).rejects.toThrowError(
            /签名不对/,
        )
    })

    it('改了签名就验不过', async () => {
        const token = await signMediaToken(SECRET, PAYLOAD, TTL)
        const [body, signature] = token.split('.')

        // 改**开头**那一位、而不是末位：base64url 的最后一个字符里有几位是被丢弃的
        // （32 字节摘要编成 43 个字符，末位只有 2 位有效），改末位可能解出完全相同的字节，
        // 那样的断言是碰运气 —— 换一把密钥就会时过时不过。
        const flipped = `${body}.${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`
        expect(flipped).not.toBe(token)
        await expect(verifyMediaToken(SECRET, flipped)).rejects.toThrowError(/签名不对/)
    })

    it('过期就验不过，并且提示怎么说人话', async () => {
        const now = Date.now()
        const token = await signMediaToken(SECRET, PAYLOAD, 60, now)
        await expect(verifyMediaToken(SECRET, token, now + 61_000)).rejects.toThrowError(/过期/)
    })

    it('刚好在有效期内仍然可用', async () => {
        const now = Date.now()
        const token = await signMediaToken(SECRET, PAYLOAD, 60, now)
        await expect(verifyMediaToken(SECRET, token, now + 59_000)).resolves.toEqual(PAYLOAD)
    })

    it('缺签名、缺分隔符、签名不是合法编码都拒绝', async () => {
        for (const bad of ['', 'nodot', '.onlysignature', 'onlybody.', 'a.b']) {
            await expect(verifyMediaToken(SECRET, bad)).rejects.toThrowError(MediaTokenError)
        }
    })

    it('签名合法但载荷缺字段时照样拒绝', async () => {
        // 用同一把密钥对一份不完整的载荷签名：签名过得去，结构不合法
        const token = await signMediaToken(SECRET, { sourceId: '', url: '' }, TTL)
        await expect(verifyMediaToken(SECRET, token)).rejects.toThrowError(/缺少书源/)
    })
})
