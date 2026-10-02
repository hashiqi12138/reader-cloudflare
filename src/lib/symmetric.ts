/**
 * 书源视角的对称加解密（Legado 的 `java.createSymmetricCrypto` / `java.aesBase64DecodeToString`）
 *
 * 算法本身在 `aes.ts`（纯计算、可对拍）。这一层只做**书源那侧的输入输出约定**：
 * 密钥与 iv 可能是字符串也可能是字节数组、密文可能是 base64 也可能是十六进制，
 * 而 `createSymmetricCrypto` 返回的对象上有一整排方法（encrypt / decrypt /
 * encryptBase64 / decryptBase64ToString / encryptHex …）。
 *
 * 把这一层单独拆出来的理由：它全是「形状转换」，最容易把「输入当成了什么」
 * 弄错，而错了以后症状是「解密出来是乱码」——看不出是编码问题还是密钥问题。
 * 拆出来就能直接对着 `node:crypto` 逐条测。
 */

import { aesDecrypt, aesEncrypt } from './aes'
import { base64OfBytes, bytesOfBase64 } from './base64'
import { parseTransformation, type BlockCipher, type CipherAlgorithm } from './cipher'
import { desDecrypt, desEncrypt } from './des'

/** 书源里的字节数组就是普通 JS 数组（`base64DecodeToByteArray` 返回的也是它） */
export type BytesLike = string | number[] | Uint8Array

export type SymmetricOp =
    | 'encrypt'
    | 'decrypt'
    | 'encryptBase64'
    | 'decryptBase64'
    | 'encryptBase64ToString'
    | 'decryptBase64ToString'
    | 'encryptHex'
    | 'decryptHex'

export interface SymmetricRequest {
    op: SymmetricOp
    transformation: string
    key: BytesLike
    iv?: BytesLike | null
    data: BytesLike
}

/** 字节数组 ↔ 十六进制（小写，与 `java.hexEncodeToString` 的习惯一致） */
function hexOfBytes(bytes: Uint8Array): string {
    let out = ''
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
    return out
}

export function bytesOfHex(text: string): Uint8Array {
    const cleaned = String(text).replace(/[^0-9a-fA-F]/g, '')
    const out = new Uint8Array(Math.floor(cleaned.length / 2))
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16)
    }
    return out
}

export function bytesOfText(text: string): Uint8Array {
    return new TextEncoder().encode(text)
}

/**
 * 算法 → [加密, 解密]
 *
 * 表比三元表达式好读，也方便以后再加算法（这张表是唯一需要改的地方）。
 */
const CIPHERS: Record<CipherAlgorithm, readonly [BlockCipher, BlockCipher]> = {
    AES: [aesEncrypt, aesDecrypt],
    DES: [desEncrypt, desDecrypt],
}

/**
 * 把书源给的「密钥/iv」变成字节
 *
 * **字符串按 UTF-8 取字节** —— 与 Legado 一致（`"0123456789abcdef"` 这种
 * 字面量密钥在书源里非常常见）。注意它不是「十六进制字符串」：
 * 十六进制那种写法要用 `java.hexDecodeToString` 或 `base64DecodeToByteArray` 转。
 */
function toBytes(value: BytesLike | null | undefined, label: string): Uint8Array {
    if (value === null || value === undefined) return new Uint8Array(0)
    if (typeof value === 'string') return bytesOfText(value)
    if (Array.isArray(value) || value instanceof Uint8Array)
        return Uint8Array.from(value as number[])
    throw new Error(`${label} 只能是字符串或字节数组，收到 ${typeof value}`)
}

/**
 * 执行一次对称加解密
 *
 * 返回值与 Legado 对齐：涉及字节的方法给**字节数组**（脚本侧接着 `hexEncodeToString`
 * 或再喂给别的算法），涉及字符串的方法给字符串。
 */
export function runSymmetric(request: SymmetricRequest): number[] | string {
    const { algorithm, mode, padding } = parseTransformation(request.transformation)
    const key = toBytes(request.key, '密钥')
    const iv = request.iv === null || request.iv === undefined ? null : toBytes(request.iv, 'iv')

    const decrypting = request.op.startsWith('decrypt')
    // 密文的给法因方法而异：base64 那批先解 base64、hex 那批先解十六进制、其余当字节
    const inputBytes =
        request.op === 'decryptBase64' || request.op === 'decryptBase64ToString'
            ? bytesOfBase64(String(request.data))
            : request.op === 'decryptHex'
              ? bytesOfHex(String(request.data))
              : toBytes(request.data, '数据')

    // AES 与 DES 的入参形状完全一致，所以这里只是选一个实现 —— 模式、补位、报错措辞
    // 都在 cipher.ts 那一层，不随算法分叉
    const [encrypt, decrypt] = CIPHERS[algorithm]
    const output = (decrypting ? decrypt : encrypt)({ mode, padding, key, iv, data: inputBytes })

    switch (request.op) {
        case 'encrypt':
        case 'decrypt':
            return Array.from(output)
        case 'encryptBase64':
        case 'encryptBase64ToString':
            return base64OfBytes(output)
        case 'decryptBase64':
        case 'decryptHex':
            return Array.from(output)
        case 'decryptBase64ToString':
            return new TextDecoder().decode(output)
        case 'encryptHex':
            return hexOfBytes(output)
        default: {
            const never: never = request.op
            throw new Error(`不支持的加解密操作：${String(never)}`)
        }
    }
}
