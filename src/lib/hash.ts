/**
 * 摘要算法（纯函数，Node 里可直接单测）
 *
 * 书源里的 `java.md5Encode` 用得不少：禁漫天堂API 拿它拼鉴权 token、
 * 书音M 拿它给目录接口签名。而 **WebCrypto 不提供 MD5**（设计上就不给弱摘要），
 * 所以只能自己实现一份，放在宿主侧、走同步桥进沙箱 ——
 * 好处是它是纯函数，能在 Node 里和 `node:crypto` 逐条对拍。
 */

import { base64OfBytes } from './base64'

/** 32 位循环左移 */
function rotl(x: number, n: number): number {
    return ((x << n) | (x >>> (32 - n))) >>> 0
}

// 每轮的移位量与常量表，都是 MD5 规范里的固定值
const SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const K = (() => {
    const table = new Uint32Array(64)
    for (let i = 0; i < 64; i += 1) {
        table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0
    }
    return table
})()

/**
 * MD5 原始字节（16 字节）
 *
 * 与 `md5Hex` 分开提供，是因为书源里两种用法都有：
 *   - `java.md5Encode(s)` 要的是十六进制串 → `md5Hex`
 *   - `Packages.java.security.MessageDigest.getInstance('MD5').digest(str.getBytes('UTF-8'))`
 *     要的是**字节数组**，脚本自己再 `(b[i] & 0xff).toString(16)` 拼十六进制
 *     （七猫小说·API 就是这么算签名的）
 *
 * 后者必须给出真正的字节：只给十六进制串的话脚本会按「字节」逐位处理它，
 * 算出一个合法但完全错的签名，站点回 403 —— 又是一个静默错数据。
 */
export function md5Bytes(input: Uint8Array): Uint8Array {
    const bytes = input
    const bitLength = bytes.length * 8

    // 补一个 0x80，再补 0 到 56 mod 64，最后接 8 字节的长度（小端）
    const withOne = bytes.length + 1
    const paddedLength = withOne + ((56 - (withOne % 64) + 64) % 64)
    const buffer = new Uint8Array(paddedLength + 8)
    buffer.set(bytes)
    buffer[bytes.length] = 0x80

    const view = new DataView(buffer.buffer)
    view.setUint32(paddedLength, bitLength >>> 0, true)
    view.setUint32(paddedLength + 4, Math.floor(bitLength / 0x100000000), true)

    let a0 = 0x67452301
    let b0 = 0xefcdab89
    let c0 = 0x98badcfe
    let d0 = 0x10325476

    const words = new Uint32Array(16)
    for (let chunk = 0; chunk < buffer.length; chunk += 64) {
        for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(chunk + i * 4, true)

        let a = a0
        let b = b0
        let c = c0
        let d = d0

        for (let i = 0; i < 64; i += 1) {
            let f: number
            let g: number
            if (i < 16) {
                f = (b & c) | (~b & d)
                g = i
            } else if (i < 32) {
                f = (d & b) | (~d & c)
                g = (5 * i + 1) % 16
            } else if (i < 48) {
                f = b ^ c ^ d
                g = (3 * i + 5) % 16
            } else {
                f = c ^ (b | ~d)
                g = (7 * i) % 16
            }

            const sum = (f + a + K[i]! + words[g]!) >>> 0
            a = d
            d = c
            c = b
            b = (b + rotl(sum, SHIFTS[i]!)) >>> 0
        }

        a0 = (a0 + a) >>> 0
        b0 = (b0 + b) >>> 0
        c0 = (c0 + c) >>> 0
        d0 = (d0 + d) >>> 0
    }

    const out = new Uint8Array(16)
    const outView = new DataView(out.buffer)
    outView.setUint32(0, a0, true)
    outView.setUint32(4, b0, true)
    outView.setUint32(8, c0, true)
    outView.setUint32(12, d0, true)
    return out
}

/**
 * MD5，返回 32 位小写十六进制
 *
 * 输入按 **UTF-8** 取字节 —— 与 Legado 的 `java.md5Encode` 一致；
 * 直接对 JS 字符串按 UTF-16 取字节的话，含中文的输入会算出完全不同的结果。
 */
export function md5Hex(input: string): string {
    const digest = md5Bytes(new TextEncoder().encode(input))
    let out = ''
    for (const byte of digest) out += byte.toString(16).padStart(2, '0')
    return out
}

/**
 * SHA-256，返回 64 位小写十六进制
 *
 * 给 `java.digestHex(str, 'SHA-256')` 用（线上 5 处，两处在拼 App 接口的签名）。
 * 与 MD5 不同，**这个不必自己实现** —— WebCrypto 提供 SHA-256，
 * 而它在 Worker 与 Node 里都有，代价只是它**是异步的**（`crypto.subtle.digest` 只给 Promise）。
 *
 * 异步在这里不是问题：沙箱那一侧本来就是 asyncify 的（`java.ajax` 就是
 * 「脚本里同步、宿主侧 await」），加一条异步桥与加一条同步桥的写法一样。
 * 反过来，为它在纯 JS 里手抄一份 SHA-256 才是真的贵。
 *
 * 输入同样按 **UTF-8** 取字节。
 */
export async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    let out = ''
    for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, '0')
    return out
}

/** 书源里 `java.digestBase64Str` / `java.HMacHex` / `java.HMacBase64` 的一次调用 */
export interface HashRequest {
    /** `digest` = 消息摘要，`hmac` = 散列消息鉴别码 */
    op: 'digest' | 'hmac'
    /** JCA 写法：`MD5` / `SHA-256` / `HmacSHA256` / `HMAC-SHA1` */
    algorithm: string
    key?: string
    data: string
    encoding: 'hex' | 'base64'
}

/**
 * 算法名归一化：上游书源里同一个算法有四种写法
 *
 * 语料里实际出现的是 `"SHA-256"`、`'sha-256'`、`"HmacSHA256"`、`"HMAC-SHA1"` ——
 * 去分隔符并大写之后都是同一件事。归一化放在这里，沙箱那侧就不必各写一遍。
 */
function normalizeAlgorithm(algorithm: string): string {
    return String(algorithm ?? '')
        .toUpperCase()
        .replace(/[-_\s]/g, '')
}

const WEB_DIGESTS: Record<string, string> = {
    SHA1: 'SHA-1',
    SHA256: 'SHA-256',
    SHA384: 'SHA-384',
    SHA512: 'SHA-512',
}

/** HMAC 的哈希算法同样只有这几种走 WebCrypto */
const WEB_HMAC: Record<string, string> = { ...WEB_DIGESTS }

/**
 * UTF-8 取字节
 *
 * **不要给它写显式返回类型**：写成 `Uint8Array` 会退化成 `Uint8Array<ArrayBufferLike>`，
 * 而 `crypto.subtle.*` 只接受 `ArrayBuffer` 那一支，于是「类型不兼容」的报错会出现在
 * 每一个调用点上。让 TS 自己从 `TextEncoder.encode` 推。
 */
function bytesOfText(text: string) {
    return new TextEncoder().encode(text)
}

function hexOfBytes(bytes: Uint8Array): string {
    let out = ''
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
    return out
}

/**
 * 消息摘要与 HMAC：`java.digestBase64Str` / `java.HMacHex` / `java.HMacBase64`
 *
 * 两者都归到这里，是因为它们的输入输出约定完全一样（字符串进、hex 或 base64 出），
 * 区别只是 HMAC 多一个密钥。
 *
 * 算法覆盖面上有一处**明确的缺口**：**HMAC-MD5 不做**。WebCrypto 不提供 MD5，
 * 而 `md5Bytes` 只吃字符串 —— HMAC 的中间结果（`H((K⊕ipad)||text)`）是**任意字节**，
 * 用字符串接口套不出来，硬做会算出一个错的摘要。缺就报错（见下面的分支）。
 * 语料里 HMac 那两处用的是 `HMAC-SHA1` 与 `HmacSHA256`，都不受影响。
 */
export async function runHash(request: HashRequest): Promise<string> {
    // 归一化之后再去掉 HMAC 前缀：`HmacSHA256` / `HMAC-SHA1` 归一化完是
    // `HMACSHA256` / `HMACSHA1`，底下要查的是哈希算法 `SHA256` / `SHA1`
    const algorithm = normalizeAlgorithm(request.algorithm).replace(/^HMAC/, '')
    const encode = (bytes: Uint8Array): string =>
        request.encoding === 'base64' ? base64OfBytes(bytes) : hexOfBytes(bytes)

    if (request.op === 'digest') {
        if (algorithm === 'MD5') return encode(md5Bytes(bytesOfText(request.data)))
        const webAlgorithm = WEB_DIGESTS[algorithm]
        if (!webAlgorithm) throw new Error(`不支持的消息摘要算法：${request.algorithm}`)
        const digest = await crypto.subtle.digest(webAlgorithm, bytesOfText(request.data))
        return encode(new Uint8Array(digest))
    }

    const webAlgorithm = WEB_HMAC[algorithm]
    if (!webAlgorithm) {
        throw new Error(
            `不支持的 HMAC 算法：${request.algorithm}` +
                (algorithm === 'MD5' ? '（HMAC-MD5 没有 WebCrypto 实现）' : ''),
        )
    }
    const key = await crypto.subtle.importKey(
        'raw',
        bytesOfText(request.key ?? ''),
        { name: 'HMAC', hash: webAlgorithm },
        false,
        ['sign'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, bytesOfText(request.data))
    return encode(new Uint8Array(signature))
}
