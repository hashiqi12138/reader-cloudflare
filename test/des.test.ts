import { describe, expect, it } from 'vitest'

import {
    DES_TABLES,
    desDecrypt,
    desDecryptBlock,
    desEncrypt,
    desEncryptBlock,
    desSubkeys,
} from '../src/lib/des'
import { parseTransformation } from '../src/lib/cipher'
import { bytesOfHex, runSymmetric } from '../src/lib/symmetric'

const hexBytes = (text: string): Uint8Array =>
    Uint8Array.from((text.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)))

const hexOf = (bytes: Uint8Array): string =>
    Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/**
 * DES 的验证条件与 AES 不同
 *
 * AES 那一份能拿 `node:crypto` 随机对拍，DES **不能** —— 本机的 OpenSSL 3
 * 要显式加载 legacy provider 才有 `des-cbc`，直接报
 * `error:0308010C:digital envelope routines::unsupported`。
 * 所以这里靠三个互相独立的方向：公开的已知答案向量、不依赖任何「记忆中的数字」的
 * 结构性不变式、以及与 AES 共用的那一层（已被随机对拍覆盖）。
 */
describe('DES 置换表的结构', () => {
    it('IP 与 FP 互逆（FP 是从 IP 现算的，这里逐位验一遍）', () => {
        for (let i = 0; i < 64; i += 1) {
            expect(DES_TABLES.FP[DES_TABLES.IP[i]! - 1]).toBe(i + 1)
        }
    })

    it('每张表的位置数都对（数错一位就是整个算法错）', () => {
        expect(DES_TABLES.IP).toHaveLength(64)
        expect(DES_TABLES.FP).toHaveLength(64)
        expect(DES_TABLES.E).toHaveLength(48)
        expect(DES_TABLES.P).toHaveLength(32)
        expect(DES_TABLES.PC1).toHaveLength(56)
        expect(DES_TABLES.PC2).toHaveLength(48)
        expect(DES_TABLES.SHIFTS).toHaveLength(16)
        expect(DES_TABLES.SBOXES).toHaveLength(8)
    })

    it('S 盒是 8 个 4×16 的表，取值都在 0～15', () => {
        for (const box of DES_TABLES.SBOXES) {
            expect(box).toHaveLength(64)
            for (const value of box) {
                expect(value).toBeGreaterThanOrEqual(0)
                expect(value).toBeLessThanOrEqual(15)
            }
            // 每个盒子都是「16 个值各出现 4 次」：错抄一个数字通常会让某个值多一个少一个
            const counts = new Map<number, number>()
            for (const value of box) counts.set(value, (counts.get(value) ?? 0) + 1)
            expect([...counts.values()].every((count) => count === 4)).toBe(true)
        }
    })

    it('表里的序号都在合法范围内（1 起的源位序号）', () => {
        const within = (table: readonly number[], max: number) =>
            table.every((index) => index >= 1 && index <= max)
        expect(within(DES_TABLES.IP, 64)).toBe(true)
        expect(within(DES_TABLES.FP, 64)).toBe(true)
        expect(within(DES_TABLES.E, 32)).toBe(true)
        expect(within(DES_TABLES.P, 32)).toBe(true)
        expect(within(DES_TABLES.PC1, 64)).toBe(true)
        expect(within(DES_TABLES.PC2, 56)).toBe(true)
    })
})

describe('DES 的结构性不变式', () => {
    const WEAK_KEYS = [
        '0101010101010101',
        'fefefefefefefefe',
        'e0e0e0e0f1f1f1f1',
        '1f1f1f1f0e0e0e0e',
    ]

    it('弱密钥下 16 个轮密钥完全相同', () => {
        for (const hex of WEAK_KEYS) {
            const subkeys = desSubkeys(hexBytes(hex))
            expect(subkeys).toHaveLength(16)
            const first = subkeys[0]!
            for (const subkey of subkeys) expect(subkey).toEqual(first)
        }
    })

    it('弱密钥下加密是对合：E_K(E_K(P)) = P', () => {
        const plain = hexBytes('0123456789abcdef')
        for (const hex of WEAK_KEYS) {
            const key = hexBytes(hex)
            expect(hexOf(desEncryptBlock(desEncryptBlock(plain, key), key))).toBe(hexOf(plain))
        }
    })

    it('补性质：E(~K, ~P) = ~E(K, P)', () => {
        // 这条与任何表的具体取值无关，是 DES 的代数性质 —— 表抄错了这里就会失守
        const invert = (bytes: Uint8Array) => Uint8Array.from(bytes, (byte) => byte ^ 0xff)
        const key = hexBytes('133457799bbcdff1')
        const plain = hexBytes('0123456789abcdef')
        const normal = desEncryptBlock(plain, key)
        const complemented = desEncryptBlock(invert(plain), invert(key))
        expect(hexOf(complemented)).toBe(hexOf(invert(normal)))
    })

    it('解密就是加密的逆（随便造一批数据来回走）', () => {
        for (let i = 0; i < 40; i += 1) {
            const key = Uint8Array.from({ length: 8 }, () => Math.floor(Math.random() * 256))
            const plain = Uint8Array.from({ length: 8 }, () => Math.floor(Math.random() * 256))
            expect(hexOf(desDecryptBlock(desEncryptBlock(plain, key), key))).toBe(hexOf(plain))
        }
    })
})

describe('DES 的已知答案向量', () => {
    it('经典样例：key 0123456789abcdef、明文 4e6f772069732074', () => {
        expect(
            hexOf(desEncryptBlock(hexBytes('4e6f772069732074'), hexBytes('0123456789abcdef'))),
        ).toBe('3fa40e8a984d4815')
    })

    it('教科书样例：key 133457799bbcdff1、明文 0123456789abcdef', () => {
        expect(
            hexOf(desEncryptBlock(hexBytes('0123456789abcdef'), hexBytes('133457799bbcdff1'))),
        ).toBe('85e813540f0ab405')
    })

    it('全零 key 与全零明文', () => {
        expect(
            hexOf(desEncryptBlock(hexBytes('0000000000000000'), hexBytes('0000000000000000'))),
        ).toBe('8ca64de9c1b123a7')
    })

    it('解密方向也对着来一遍（向量反过来用）', () => {
        expect(
            hexOf(desDecryptBlock(hexBytes('3fa40e8a984d4815'), hexBytes('0123456789abcdef'))),
        ).toBe('4e6f772069732074')
    })
})

describe('DES 的 CBC / ECB 与补位', () => {
    const key = hexBytes('0123456789abcdef')
    const iv = hexBytes('fedcba9876543210')

    it('CBC 往返（长度跨越多个块）', () => {
        for (const length of [1, 7, 8, 9, 16, 17, 64]) {
            const data = Uint8Array.from({ length }, (_, i) => i * 7 + 3)
            const cipher = desEncrypt({ mode: 'CBC', padding: 'PKCS7', key, iv, data })
            expect(cipher.length % 8).toBe(0)
            expect(
                hexOf(desDecrypt({ mode: 'CBC', padding: 'PKCS7', key, iv, data: cipher })),
            ).toBe(hexOf(data))
        }
    })

    it('ECB 往返，且同样的明文块给出同样的密文块（没有串块）', () => {
        const block = hexBytes('0123456789abcdef')
        const data = new Uint8Array(16)
        data.set(block, 0)
        data.set(block, 8)
        const cipher = desEncrypt({ mode: 'ECB', padding: 'None', key, data })
        expect(hexOf(cipher.slice(0, 8))).toBe(hexOf(cipher.slice(8, 16)))
        expect(hexOf(desDecrypt({ mode: 'ECB', padding: 'None', key, data: cipher }))).toBe(
            hexOf(data),
        )
    })

    it('CBC 下同样的明文块给出不同的密文块（iv 真的串进去了）', () => {
        const block = hexBytes('0123456789abcdef')
        const data = new Uint8Array(16)
        data.set(block, 0)
        data.set(block, 8)
        const cipher = desEncrypt({ mode: 'CBC', padding: 'None', key, iv, data })
        expect(hexOf(cipher.slice(0, 8))).not.toBe(hexOf(cipher.slice(8, 16)))
    })

    it('ZeroPadding 与 NoPadding 各按自己的语义来', () => {
        const zero = desEncrypt({ mode: 'CBC', padding: 'Zero', key, iv, data: utf8('abc') })
        expect(zero.length).toBe(8)
        expect(hexOf(desDecrypt({ mode: 'CBC', padding: 'Zero', key, iv, data: zero }))).toBe(
            hexOf(utf8('abc')),
        )
        expect(() =>
            desEncrypt({ mode: 'CBC', padding: 'None', key, iv, data: utf8('abc') }),
        ).toThrowError(/8 的倍数/)
    })

    it('中文正文往返（书源解的就是这种内容）', () => {
        const text = '第一章 起风了，这一段是要解出来的正文。'
        const cipher = desEncrypt({ mode: 'CBC', padding: 'PKCS7', key, iv, data: utf8(text) })
        const back = desDecrypt({ mode: 'CBC', padding: 'PKCS7', key, iv, data: cipher })
        expect(new TextDecoder().decode(back)).toBe(text)
    })
})

describe('DES 通过书源那个入口（runSymmetric）', () => {
    const key = 'KW8Dvm2N'
    const iv = '1ae2c94b'
    const text = '这是解出来的正文'

    it('transformation 解析成 DES（与 AES 同一条路径）', () => {
        expect(parseTransformation('DES/CBC/PKCS5Padding')).toEqual({
            algorithm: 'DES',
            mode: 'CBC',
            padding: 'PKCS7',
        })
        expect(parseTransformation('DES/CBC/PKCS7Padding')).toEqual({
            algorithm: 'DES',
            mode: 'CBC',
            padding: 'PKCS7',
        })
        // 只写算法时按 Java 的默认补齐
        expect(parseTransformation('DES')).toEqual({
            algorithm: 'DES',
            mode: 'CBC',
            padding: 'PKCS7',
        })
    })

    it('createSymmetricCrypto 的 encryptBase64ToString 与 decryptBase64ToString 能对上', () => {
        const encrypted = runSymmetric({
            op: 'encryptBase64ToString',
            transformation: 'DES/CBC/PKCS5Padding',
            key,
            iv,
            data: text,
        }) as string
        expect(typeof encrypted).toBe('string')
        expect(encrypted).not.toContain(text)

        const back = runSymmetric({
            op: 'decryptBase64ToString',
            transformation: 'DES/CBC/PKCS5Padding',
            key,
            iv,
            data: encrypted,
        })
        expect(back).toBe(text)
    })

    it('密钥与 iv 按 UTF-8 取字节（8 字节字符串是书源里的常见写法）', () => {
        expect(key).toHaveLength(8)
        expect(iv).toHaveLength(8)
        const hex = runSymmetric({
            op: 'encryptHex',
            transformation: 'DES/CBC/PKCS5Padding',
            key,
            iv,
            data: 'x',
        }) as string
        expect(hex).toMatch(/^[0-9a-f]+$/)
        // 8 字节补成 8 字节一组 → 一整块
        expect(hex).toHaveLength(16)
        // decryptHex 给的是**字节数组**（Legado 就是这样，脚本侧常拿去做下一步变换），
        // 要文本得自己解一次 UTF-8
        const bytes = runSymmetric({
            op: 'decryptHex',
            transformation: 'DES/CBC/PKCS5Padding',
            key,
            iv,
            data: hex,
        }) as number[]
        expect(new TextDecoder().decode(Uint8Array.from(bytes))).toBe('x')
    })

    it('密钥或 iv 长度不对时报清楚，而不是给一段乱码', () => {
        expect(() =>
            runSymmetric({
                op: 'decryptBase64ToString',
                transformation: 'DES/CBC/PKCS5Padding',
                key: 'short',
                iv,
                data: 'AAAAAAAAAAA=',
            }),
        ).toThrowError(/DES 密钥必须是 8 字节/)
        expect(() =>
            runSymmetric({
                op: 'decryptBase64ToString',
                transformation: 'DES/CBC/PKCS5Padding',
                key,
                iv: 'short',
                data: 'AAAAAAAAAAA=',
            }),
        ).toThrowError(/DES\/CBC 需要 8 字节的 iv/)
    })

    it('密文长度不是 8 的倍数时报清楚', () => {
        expect(() =>
            runSymmetric({
                op: 'decryptBase64ToString',
                transformation: 'DES/CBC/PKCS5Padding',
                key,
                iv,
                // 5 字节的密文，任何分组密码都解不了
                data: Buffer.from('abcde').toString('base64'),
            }),
        ).toThrowError(/8 的倍数/)
    })

    it('字节数组形式的密钥与 iv 也认（base64DecodeToByteArray 的产物）', () => {
        const keyBytes = Array.from(bytesOfHex('0123456789abcdef'))
        const ivBytes = Array.from(bytesOfHex('fedcba9876543210'))
        const hex = runSymmetric({
            op: 'encryptHex',
            transformation: 'DES/CBC/PKCS5Padding',
            key: keyBytes,
            iv: ivBytes,
            data: '正文',
        }) as string
        const bytes = runSymmetric({
            op: 'decryptHex',
            transformation: 'DES/CBC/PKCS5Padding',
            key: keyBytes,
            iv: ivBytes,
            data: hex,
        }) as number[]
        expect(new TextDecoder().decode(Uint8Array.from(bytes))).toBe('正文')
    })
})

describe('不支持的算法仍然报出名字', () => {
    it('没实现的算法（DESede / Blowfish）明确报错', () => {
        expect(() => parseTransformation('DESede/CBC/PKCS5Padding')).toThrowError(/不支持 DESEDE/)
        expect(() => parseTransformation('Blowfish/CBC/PKCS5Padding')).toThrowError(
            /不支持 BLOWFISH/,
        )
        expect(() => parseTransformation('AES/CFB/NoPadding')).toThrowError(/暂不支持 AES 的 CFB/)
        expect(() => parseTransformation('DES/CFB/NoPadding')).toThrowError(/暂不支持 DES 的 CFB/)
        expect(() => parseTransformation('AES/CBC/ISO10126Padding')).toThrowError(
            /暂不支持 ISO10126PADDING/,
        )
    })
})
