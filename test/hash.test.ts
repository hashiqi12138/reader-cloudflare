import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { md5Hex, runHash, sha256Hex } from '../src/lib/hash'

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

/**
 * SHA-256 走的是 WebCrypto（`crypto.subtle.digest`），不是自己实现的，
 * 但它要能被 `java.digestHex` 用上，就必须：**返回十六进制**、**按 UTF-8 取字节**、
 * 而且**异步**（这一点靠签名保证，调用方要 await）。
 * 这里同样和 `node:crypto` 对拍。
 */
describe('sha256Hex', () => {
    it('和 node:crypto 的结果一致（含多字节与长输入）', async () => {
        const samples = [
            '',
            'a',
            'abc',
            '中文',
            '禁漫天堂API',
            'x'.repeat(55),
            'x'.repeat(64),
            'x'.repeat(1000),
            '简体中文 + English + 日本語 + 1234567890',
        ]
        for (const sample of samples) {
            const expected = createHash('sha256').update(sample, 'utf8').digest('hex')
            const actual = await sha256Hex(sample)
            expect(actual, `输入 ${JSON.stringify(sample.slice(0, 20))}`).toBe(expected)
        }
    })

    it('输出固定是 64 位小写十六进制', async () => {
        expect(await sha256Hex('中文')).toMatch(/^[0-9a-f]{64}$/)
    })

    it('对已知向量给出标准答案', async () => {
        expect(await sha256Hex('')).toBe(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        )
        expect(await sha256Hex('abc')).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        )
    })
})

/**
 * `runHash`：书源的 `java.digestBase64Str` / `java.HMacHex` / `java.HMacBase64`
 *
 * 这三条桥的存在理由与 MD5 那条一样：**算错是静默的** —— 拿错的摘要去签名，
 * 站点只会说「参数不对」。所以同样和 `node:crypto` 对拍，而不是抄常量。
 *
 * 另外两件事一起钉住：
 *   - **算法名归一化**：语料里同一个算法有 `SHA-256` / `sha-256` / `HMAC-SHA1` /
 *     `HmacSHA256` 四种写法，都得认
 *   - **HMAC-MD5 明确报错**：WebCrypto 不提供 MD5，硬做会算出错的摘要，
 *     所以这里断言「抛错」而不是「返回一个值」
 */
describe('runHash', () => {
    const SAMPLES = ['', 'a', 'abc', 'The quick brown fox jumps over the lazy dog', '中文密钥测试']

    it('digest：hex 与 base64 都和 node:crypto 一致（MD5 / SHA-1 / SHA-256 / SHA-512）', async () => {
        for (const [algorithm, nodeName] of [
            ['MD5', 'md5'],
            ['SHA-1', 'sha1'],
            ['SHA-256', 'sha256'],
            ['SHA-512', 'sha512'],
        ] as const) {
            for (const data of SAMPLES) {
                const expected = createHash(nodeName).update(data, 'utf8')
                const hex = await runHash({ op: 'digest', algorithm, data, encoding: 'hex' })
                const base64 = await runHash({ op: 'digest', algorithm, data, encoding: 'base64' })
                expect(hex, `${algorithm} ${JSON.stringify(data)}`).toBe(
                    expected.copy().digest('hex'),
                )
                expect(base64, `${algorithm} ${JSON.stringify(data)}`).toBe(
                    expected.copy().digest('base64'),
                )
            }
        }
    })

    it('digest：算法名大小写与分隔符都不影响（语料里四种写法）', async () => {
        const reference = await runHash({
            op: 'digest',
            algorithm: 'SHA-256',
            data: 'abc',
            encoding: 'hex',
        })
        for (const spelling of ['sha-256', 'SHA256', 'sha_256', 'Sha-256']) {
            expect(
                await runHash({ op: 'digest', algorithm: spelling, data: 'abc', encoding: 'hex' }),
                spelling,
            ).toBe(reference)
        }
    })

    it('hmac：hex 与 base64 都和 node:crypto 一致（含 JCA 的两种拼法）', async () => {
        for (const [algorithm, nodeName] of [
            ['HMAC-SHA1', 'sha1'],
            ['HmacSHA256', 'sha256'],
            ['HmacSHA512', 'sha512'],
        ] as const) {
            for (const data of SAMPLES) {
                const key =
                    'wj3imab73kwceuf51lf01ORHe2cmo8X0YrZwF4p2uv3WEfmqxrT2oIBwRFRNErXW20UKal15ZTDdxPKQ43puZFqcuXk'
                const expected = createHmac(nodeName, Buffer.from(key, 'utf8')).update(data, 'utf8')
                const hex = await runHash({ op: 'hmac', algorithm, key, data, encoding: 'hex' })
                const base64 = await runHash({
                    op: 'hmac',
                    algorithm,
                    key,
                    data,
                    encoding: 'base64',
                })
                // `Hmac` 上没有 copy()，hex 与 base64 各建一个
                expect(hex, `${algorithm} ${JSON.stringify(data)}`).toBe(
                    createHmac(nodeName, Buffer.from(key, 'utf8'))
                        .update(data, 'utf8')
                        .digest('hex'),
                )
                expect(base64, `${algorithm} ${JSON.stringify(data)}`).toBe(
                    createHmac(nodeName, Buffer.from(key, 'utf8'))
                        .update(data, 'utf8')
                        .digest('base64'),
                )
            }
        }
    })

    it('HMAC 用的是 UTF-8 的密钥字节（不是十六进制、也不是 base64）', async () => {
        // 这一条不说清就会踩：书源里的密钥看着像随机串，但它按字面 UTF-8 取字节
        const key = '0123456789abcdef'
        expect(
            await runHash({ op: 'hmac', algorithm: 'HmacSHA256', key, data: 'x', encoding: 'hex' }),
        ).toBe(createHmac('sha256', Buffer.from(key, 'utf8')).update('x').digest('hex'))
    })

    it('HMAC-MD5 明确报错（WebCrypto 没有 MD5，硬做会算出错的摘要）', async () => {
        await expect(
            runHash({ op: 'hmac', algorithm: 'HmacMD5', key: 'k', data: 'x', encoding: 'hex' }),
        ).rejects.toThrowError(/不支持的 HMAC 算法：HmacMD5（HMAC-MD5 没有 WebCrypto 实现）/)
    })

    it('不认识的算法报错时要带上算法名', async () => {
        await expect(
            runHash({ op: 'digest', algorithm: 'SHA3-256', data: 'x', encoding: 'hex' }),
        ).rejects.toThrowError(/不支持的消息摘要算法：SHA3-256/)
    })
})
