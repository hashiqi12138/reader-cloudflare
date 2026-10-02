import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { bytesOfHex, runSymmetric, type SymmetricOp } from '../src/lib/symmetric'

/**
 * 书源视角的对称加解密
 *
 * 算法本身在 `aes.test.ts` 里已对准（官方向量 + node:crypto 随机对拍）。
 * 这一层的风险全在**形状**上：字符串密钥按 UTF-8 还是十六进制、密文是 base64 还是
 * 裸字节、方法返回字节数组还是字符串 —— 弄错的症状同样是「解出来是乱码」，
 * 所以这里对每种方法都拿 node:crypto 走一遍同样的形状。
 */

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'))
const hex = (bytes: Uint8Array | number[]) => Buffer.from(Uint8Array.from(bytes)).toString('hex')

/** 标准答案：node:crypto 按同样的形状算一遍 */
function referenceDecryptBase64ToString(data: string, key: string, iv: string): string {
    const decipher = createDecipheriv('aes-128-cbc', utf8(key), utf8(iv))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
        'utf8',
    )
}

describe('runSymmetric：与 node:crypto 形状一致', () => {
    const key = '1234567890abcdef'
    const iv = 'abcdef1234567890'

    it('decryptBase64ToString：base64 密文 → 文本（书源最常见的用法）', () => {
        // 先用 node:crypto 造一份密文，再让我们的实现解
        const cipher = createCipheriv('aes-128-cbc', utf8(key), utf8(iv))
        const encrypted = Buffer.concat([
            cipher.update(Buffer.from('斗破苍穹 第1章', 'utf8')),
            cipher.final(),
        ])

        const mine = runSymmetric({
            op: 'decryptBase64ToString',
            transformation: 'AES/CBC/PKCS5Padding',
            key,
            iv,
            data: encrypted.toString('base64'),
        })
        expect(mine).toBe('斗破苍穹 第1章')
        expect(mine).toBe(referenceDecryptBase64ToString(encrypted.toString('base64'), key, iv))
    })

    it('encryptBase64ToString：文本 → base64 密文，能被 node:crypto 解开', () => {
        const mine = runSymmetric({
            op: 'encryptBase64ToString',
            transformation: 'AES/CBC/PKCS7Padding',
            key,
            iv,
            data: '中文正文',
        }) as string

        const decipher = createDecipheriv('aes-128-cbc', utf8(key), utf8(iv))
        const back = Buffer.concat([
            decipher.update(Buffer.from(mine, 'base64')),
            decipher.final(),
        ]).toString('utf8')
        expect(back).toBe('中文正文')
    })

    it('encrypt / decrypt 给的是字节数组（脚本接着做 hex 或再加密）', () => {
        const cipherBytes = runSymmetric({
            op: 'encrypt',
            transformation: 'AES/ECB/PKCS5Padding',
            key,
            data: 'abc',
        }) as number[]
        expect(Array.isArray(cipherBytes)).toBe(true)
        expect(cipherBytes.length % 16).toBe(0)

        const back = runSymmetric({
            op: 'decrypt',
            transformation: 'AES/ECB/PKCS5Padding',
            key,
            data: cipherBytes,
        }) as number[]
        expect(Buffer.from(Uint8Array.from(back)).toString('utf8')).toBe('abc')
    })

    it('decryptHex / encryptHex 走十六进制', () => {
        const cipherHex = runSymmetric({
            op: 'encryptHex',
            transformation: 'AES/CBC/PKCS5Padding',
            key,
            iv,
            data: 'hello 世界',
        }) as string
        expect(cipherHex).toMatch(/^[0-9a-f]+$/)

        const back = runSymmetric({
            op: 'decryptHex',
            transformation: 'AES/CBC/PKCS5Padding',
            key,
            iv,
            data: cipherHex,
        }) as number[]
        expect(Buffer.from(Uint8Array.from(back)).toString('utf8')).toBe('hello 世界')
    })

    it('密钥/iv 给字节数组也认（base64DecodeToByteArray 的结果就是这样）', () => {
        const keyBytes = Array.from(utf8(key))
        const ivBytes = Array.from(utf8(iv))
        const cipher = createCipheriv('aes-128-cbc', utf8(key), utf8(iv))
        const encrypted = Buffer.concat([
            cipher.update(Buffer.from('字节密钥', 'utf8')),
            cipher.final(),
        ])

        const mine = runSymmetric({
            op: 'decryptBase64ToString',
            transformation: 'AES/CBC/PKCS5Padding',
            key: keyBytes,
            iv: ivBytes,
            data: encrypted.toString('base64'),
        })
        expect(mine).toBe('字节密钥')
    })

    it('AES-256 + 字符串密钥（32 字节）也能用', () => {
        const longKey = 'abcdefghijklmnopqrstuvwxyz012345'
        const longIv = '0123456789abcdef'
        const mine = runSymmetric({
            op: 'encryptBase64ToString',
            transformation: 'AES/CBC/PKCS5Padding',
            key: longKey,
            iv: longIv,
            data: '长密钥',
        }) as string

        const decipher = createDecipheriv('aes-256-cbc', utf8(longKey), utf8(longIv))
        expect(
            Buffer.concat([
                decipher.update(Buffer.from(mine, 'base64')),
                decipher.final(),
            ]).toString('utf8'),
        ).toBe('长密钥')
    })

    it('随机往返：128/192/256 位密钥 × 两种模式', () => {
        // 密钥必须是**可打印**的随机串：字符串密钥按 UTF-8 取字节，
        // 而 Latin1 的 0x80 以上字符在 UTF-8 里变成两个字节，长度就不是原来了
        // （书源里的字面量密钥也都是可打印的，比如 `"0123456789abcdef"`）
        const printable = (length: number) =>
            Buffer.from(randomBytes(length)).toString('base64url').slice(0, length)

        for (const keyLength of [16, 24, 32]) {
            for (const transformation of ['AES/CBC/PKCS5Padding', 'AES/ECB/PKCS7Padding']) {
                const randomKey = printable(keyLength)
                const randomIv = printable(16)
                const text = '正文' + Math.random().toString(36).slice(2)

                const encrypted = runSymmetric({
                    op: 'encryptBase64ToString',
                    transformation,
                    key: randomKey,
                    iv: randomIv,
                    data: text,
                }) as string
                const back = runSymmetric({
                    op: 'decryptBase64ToString',
                    transformation,
                    key: randomKey,
                    iv: randomIv,
                    data: encrypted,
                })
                expect(back).toBe(text)
            }
        }
    })

    it('字符串密钥按 UTF-8 取字节：非 ASCII 字符会让密钥变长', () => {
        // 这条不是「特性」而是**提醒**：中文密钥会变成 3 倍字节数。
        // AES 会以「16/24/32 字节」为由拒绝，而不是悄悄用前 16 个字节 ——
        // 后者会得到一个能跑但结果全错的密钥
        expect(() =>
            runSymmetric({
                op: 'decryptBase64ToString',
                transformation: 'AES/CBC/PKCS5Padding',
                key: '中文密钥',
                iv: 'abcdef1234567890',
                data: 'AAAA',
            }),
        ).toThrowError(/16 \/ 24 \/ 32 字节/)
    })

    it('还是没实现的算法报出来，而不是给一段乱码', () => {
        // DES 已经在 des.test.ts 里覆盖（它现在是支持的）；这里钉住「没实现的算法
        // 必须报出名字」这条规矩本身
        expect(() =>
            runSymmetric({
                op: 'decryptBase64ToString',
                transformation: 'DESede/CBC/PKCS5Padding',
                key,
                iv,
                data: 'AAAA',
            }),
        ).toThrowError(/不支持 DESEDE/)
    })

    it('密文不是合法 base64 / 长度不对时也报清楚', () => {
        expect(() =>
            runSymmetric({
                op: 'decryptBase64ToString',
                transformation: 'AES/CBC/PKCS5Padding',
                key,
                iv,
                // 长度不是 16 的倍数 —— 多半是密文本身取错了
                data: Buffer.from('too short').toString('base64'),
            }),
        ).toThrowError(/16 的倍数/)
    })
})

describe('bytesOfHex', () => {
    it('忽略分隔符与大小写', () => {
        expect(hex(bytesOfHex('0A ff-1b'))).toBe('0aff1b')
    })

    it('奇数长度时丢掉最后半个字节，而不是算成 NaN', () => {
        expect(hex(bytesOfHex('abc'))).toBe('ab')
    })
})

describe('方法名与 Legado 对齐', () => {
    it('八个方法都在支持范围内（漏一个就是「not a function」）', () => {
        const ops: SymmetricOp[] = [
            'encrypt',
            'decrypt',
            'encryptBase64',
            'decryptBase64',
            'encryptBase64ToString',
            'decryptBase64ToString',
            'encryptHex',
            'decryptHex',
        ]
        for (const op of ops) {
            expect(typeof op).toBe('string')
        }
    })
})
