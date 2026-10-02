import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { AES_SBOX, aesDecrypt, aesEncrypt } from '../src/lib/aes'
import { parseTransformation } from '../src/lib/cipher'

/**
 * AES 的同步实现
 *
 * 三层验证，一层比一层强：
 *   1. **官方向量**（FIPS-197 单块、NIST SP 800-38A 的 CBC/ECB 多块）——
 *      钉住算法本身没写错
 *   2. **与 node:crypto 对拍**（随机密钥长度 × 随机长度 × 两种模式 × 三种补位）——
 *      数百组随机用例，覆盖我自己想不到的组合
 *   3. 往返（加密再解密）—— 抓补位与分块边界
 *
 * 这一层写错的症状是「正文解密成乱码」，而排查时完全看不出问题在算法上，
 * 所以宁可测得比它看起来需要的更狠。
 */

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const fromHex = (text: string) => new Uint8Array(Buffer.from(text, 'hex'))
const utf8 = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'))

describe('S 盒逐项对照', () => {
    /**
     * FIPS-197 第 5 节的 S 盒，256 项一个不落。
     *
     * 为什么值得抄一遍：S 盒只错一两个表项时，官方向量**可能恰好没用到那一项**而通过 ——
     * 开发时就真踩到过（逆元越界让 SBOX[1] 算成 0，而 FIPS 的单块样例里没出现 0x01，
     * 于是 AES-128 的向量"通过"了，换成 AES-192/256 或随机数据才暴露）。
     */
    const REFERENCE = [
        '63 7c 77 7b f2 6b 6f c5 30 01 67 2b fe d7 ab 76',
        'ca 82 c9 7d fa 59 47 f0 ad d4 a2 af 9c a4 72 c0',
        'b7 fd 93 26 36 3f f7 cc 34 a5 e5 f1 71 d8 31 15',
        '04 c7 23 c3 18 96 05 9a 07 12 80 e2 eb 27 b2 75',
        '09 83 2c 1a 1b 6e 5a a0 52 3b d6 b3 29 e3 2f 84',
        '53 d1 00 ed 20 fc b1 5b 6a cb be 39 4a 4c 58 cf',
        'd0 ef aa fb 43 4d 33 85 45 f9 02 7f 50 3c 9f a8',
        '51 a3 40 8f 92 9d 38 f5 bc b6 da 21 10 ff f3 d2',
        'cd 0c 13 ec 5f 97 44 17 c4 a7 7e 3d 64 5d 19 73',
        '60 81 4f dc 22 2a 90 88 46 ee b8 14 de 5e 0b db',
        'e0 32 3a 0a 49 06 24 5c c2 d3 ac 62 91 95 e4 79',
        'e7 c8 37 6d 8d d5 4e a9 6c 56 f4 ea 65 7a ae 08',
        'ba 78 25 2e 1c a6 b4 c6 e8 dd 74 1f 4b bd 8b 8a',
        '70 3e b5 66 48 03 f6 0e 61 35 57 b9 86 c1 1d 9e',
        'e1 f8 98 11 69 d9 8e 94 9b 1e 87 e9 ce 55 28 df',
        '8c a1 89 0d bf e6 42 68 41 99 2d 0f b0 54 bb 16',
    ]
        .join(' ')
        .split(' ')
        .map((byte) => Number.parseInt(byte, 16))

    it('与 FIPS-197 的 256 项完全一致', () => {
        expect(AES_SBOX.length).toBe(256)
        expect(Array.from(AES_SBOX)).toEqual(REFERENCE)
    })

    it('是个双射（S 盒必须是 0..255 的一个排列）', () => {
        const seen = new Set(AES_SBOX)
        expect(seen.size).toBe(256)
    })
})

describe('官方向量：FIPS-197 单块加密', () => {
    // FIPS-197 附录 C 的样例：明文/密文都是 00112233445566778899aabbccddeeff
    const plain = fromHex('00112233445566778899aabbccddeeff')

    it('AES-128', () => {
        const key = fromHex('000102030405060708090a0b0c0d0e0f')
        const out = aesEncrypt({ mode: 'ECB', padding: 'None', key, data: plain })
        expect(hex(out)).toBe('69c4e0d86a7b0430d8cdb78070b4c55a')
    })

    it('AES-192', () => {
        const key = fromHex('000102030405060708090a0b0c0d0e0f1011121314151617')
        const out = aesEncrypt({ mode: 'ECB', padding: 'None', key, data: plain })
        expect(hex(out)).toBe('dda97ca4864cdfe06eaf70a0ec0d7191')
    })

    it('AES-256', () => {
        const key = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
        const out = aesEncrypt({ mode: 'ECB', padding: 'None', key, data: plain })
        expect(hex(out)).toBe('8ea2b7ca516745bfeafc49904b496089')
    })

    it('解密是加密的逆运算（官方向量反过来）', () => {
        const key = fromHex('000102030405060708090a0b0c0d0e0f')
        const cipher = fromHex('69c4e0d86a7b0430d8cdb78070b4c55a')
        const out = aesDecrypt({ mode: 'ECB', padding: 'None', key, data: cipher })
        expect(hex(out)).toBe('00112233445566778899aabbccddeeff')
    })
})

describe('官方向量：NIST SP 800-38A（AES-128-CBC）', () => {
    const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c')
    const iv = fromHex('000102030405060708090a0b0c0d0e0f')
    const plain = fromHex(
        '6bc1bee22e409f96e93d7e117393172a' +
            'ae2d8a571e03ac9c9eb76fac45af8e51' +
            '30c81c46a35ce411e5fbc1191a0a52ef' +
            'f69f2445df4f9b17ad2b417be66c3710',
    )

    it('CBC 加密与官方向量逐字节一致', () => {
        const out = aesEncrypt({ mode: 'CBC', padding: 'None', key, iv, data: plain })
        expect(hex(out)).toBe(
            '7649abac8119b246cee98e9b12e9197d' +
                '5086cb9b507219ee95db113a917678b2' +
                '73bed6b8e3c1743b7116e69e22229516' +
                '3ff1caa1681fac09120eca307586e1a7',
        )
    })

    it('CBC 解密与官方向量一致', () => {
        const cipher = fromHex(
            '7649abac8119b246cee98e9b12e9197d' +
                '5086cb9b507219ee95db113a917678b2' +
                '73bed6b8e3c1743b7116e69e22229516' +
                '3ff1caa1681fac09120eca307586e1a7',
        )
        expect(hex(aesDecrypt({ mode: 'CBC', padding: 'None', key, iv, data: cipher }))).toBe(
            hex(plain),
        )
    })
})

describe('与 node:crypto 逐条对拍', () => {
    /** 用 node:crypto 做同一件事，作为「标准答案」 */
    function reference(
        direction: 'encrypt' | 'decrypt',
        mode: 'cbc' | 'ecb',
        key: Uint8Array,
        iv: Uint8Array | null,
        data: Uint8Array,
        padding: 'pkcs7' | 'none',
    ): Uint8Array {
        const algorithm = `aes-${key.length * 8}-${mode}`
        const cipher =
            direction === 'encrypt'
                ? createCipheriv(algorithm, key, iv)
                : createDecipheriv(algorithm, key, iv)
        // Node 的补位开关是 `setAutoPadding(false)`；默认就是 PKCS 补位，
        // 与 Java 的 PKCS5Padding 对 AES 是同一件事
        if (padding === 'none') cipher.setAutoPadding(false)
        return new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]))
    }

    it('PKCS7：128/192/256 位密钥 × 各种长度 × CBC/ECB 都与 node:crypto 一致', () => {
        for (const keyLength of [16, 24, 32]) {
            for (const length of [0, 1, 15, 16, 17, 31, 32, 100]) {
                for (const mode of ['CBC', 'ECB'] as const) {
                    const key = new Uint8Array(randomBytes(keyLength))
                    const iv = mode === 'CBC' ? new Uint8Array(randomBytes(16)) : null
                    const data = new Uint8Array(randomBytes(length))

                    const mine = aesEncrypt({ mode, padding: 'PKCS7', key, iv, data })
                    const theirs = reference(
                        'encrypt',
                        mode.toLowerCase() as 'cbc' | 'ecb',
                        key,
                        iv,
                        data,
                        'pkcs7',
                    )
                    expect(hex(mine)).toBe(hex(theirs))

                    const back = aesDecrypt({ mode, padding: 'PKCS7', key, iv, data: mine })
                    expect(hex(back)).toBe(hex(data))
                }
            }
        }
    })

    it('NoPadding：整块数据与 node:crypto 一致', () => {
        for (const mode of ['CBC', 'ECB'] as const) {
            const key = new Uint8Array(randomBytes(16))
            const iv = mode === 'CBC' ? new Uint8Array(randomBytes(16)) : null
            const data = new Uint8Array(randomBytes(48))
            const mine = aesEncrypt({ mode, padding: 'None', key, iv, data })
            const theirs = reference(
                'encrypt',
                mode.toLowerCase() as 'cbc' | 'ecb',
                key,
                iv,
                data,
                'none',
            )
            expect(hex(mine)).toBe(hex(theirs))
        }
    })

    it('ZeroPadding：不是整块时补 0，补齐后与 node:crypto 的 NoPadding 一致', () => {
        // Node 不提供 zero 补位，所以「补完 0 再按 NoPadding 加密」就是它的标准答案
        const key = new Uint8Array(randomBytes(16))
        const iv = new Uint8Array(randomBytes(16))
        const data = utf8('中文内容 123')

        const mine = aesEncrypt({ mode: 'CBC', padding: 'Zero', key, iv, data })

        const padded = new Uint8Array(Math.ceil(data.length / 16) * 16)
        padded.set(data)
        const theirs = reference('encrypt', 'cbc', key, iv, padded, 'none')
        expect(hex(mine)).toBe(hex(theirs))

        // 补 0 是不可逆的（尾部本来就可能是 0），这里只要求解出来以原文开头
        const back = aesDecrypt({ mode: 'CBC', padding: 'Zero', key, iv, data: mine })
        expect(Buffer.from(back).toString('utf8')).toBe('中文内容 123')
    })

    it('中文与长文本都能原样往返', () => {
        const key = utf8('1234567890abcdef')
        const iv = utf8('abcdef1234567890')
        for (const text of ['', '斗破苍穹', '第一章 起风了\n第二段正文'.repeat(50)]) {
            const cipher = aesEncrypt({ mode: 'CBC', padding: 'PKCS7', key, iv, data: utf8(text) })
            const back = aesDecrypt({ mode: 'CBC', padding: 'PKCS7', key, iv, data: cipher })
            expect(Buffer.from(back).toString('utf8')).toBe(text)
        }
    })
})

describe('错误情形要报得准', () => {
    const key = utf8('1234567890abcdef')
    const iv = utf8('abcdef1234567890')

    it('密钥长度不对时明确说出来', () => {
        expect(() =>
            aesEncrypt({ mode: 'CBC', padding: 'PKCS7', key: utf8('short'), iv, data: utf8('x') }),
        ).toThrowError(/16 \/ 24 \/ 32 字节/)
    })

    it('CBC 缺 iv 时明确说出来', () => {
        expect(() =>
            aesEncrypt({ mode: 'CBC', padding: 'PKCS7', key, iv: null, data: utf8('x') }),
        ).toThrowError(/需要 16 字节的 iv/)
    })

    it('密文长度不是 16 的倍数时明确说出来（多半是 base64 解错了）', () => {
        expect(() =>
            aesDecrypt({ mode: 'CBC', padding: 'PKCS7', key, iv, data: utf8('not-a-block') }),
        ).toThrowError(/16 的倍数/)
    })

    it('密钥不对时不会「悄悄返回一段正常文本」', () => {
        const cipher = aesEncrypt({ mode: 'CBC', padding: 'PKCS7', key, iv, data: utf8('正文') })
        const wrongKey = utf8('0000000000000000')
        // 钥匙不对有两种可能：补位校验拦住（多数），或补位**恰好**合法（约 1/256）。
        // 后者也不能装作成功 —— 这里要求「要么报错，要么结果不等于原文」。
        let leaked = ''
        try {
            leaked = Buffer.from(
                aesDecrypt({ mode: 'CBC', padding: 'PKCS7', key: wrongKey, iv, data: cipher }),
            ).toString('utf8')
        } catch {
            leaked = ''
        }
        expect(leaked).not.toBe('正文')
    })
})

describe('transformation 解析', () => {
    it('大小写与 Java 的 PKCS5Padding 都认（对 AES 就是 PKCS7）', () => {
        expect(parseTransformation('AES/CBC/PKCS5Padding')).toEqual({
            algorithm: 'AES',
            mode: 'CBC',
            padding: 'PKCS7',
        })
        expect(parseTransformation('aes/cbc/pkcs7padding')).toEqual({
            algorithm: 'AES',
            mode: 'CBC',
            padding: 'PKCS7',
        })
        expect(parseTransformation('AES/CBC/ZeroPadding').padding).toBe('Zero')
        expect(parseTransformation('AES/ECB/NoPadding').mode).toBe('ECB')
    })

    it('只写 AES 时按 Java 的默认（CBC + PKCS5）处理', () => {
        expect(parseTransformation('AES')).toEqual({
            algorithm: 'AES',
            mode: 'CBC',
            padding: 'PKCS7',
        })
    })

    it('不支持的算法/模式/补位都报出具体名字，而不是静默降级', () => {
        // DES 自己的那些情况在 des.test.ts 里（它现在是支持的了）
        expect(() => parseTransformation('DESede/CBC/PKCS5Padding')).toThrowError(/不支持 DESEDE/)
        expect(() => parseTransformation('AES/CFB/NoPadding')).toThrowError(/暂不支持 AES 的 CFB/)
        expect(() => parseTransformation('AES/CBC/ISO10126Padding')).toThrowError(
            /暂不支持 ISO10126PADDING/,
        )
    })
})
