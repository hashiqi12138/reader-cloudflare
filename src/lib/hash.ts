/**
 * 摘要算法（纯函数，Node 里可直接单测）
 *
 * 书源里的 `java.md5Encode` 用得不少：禁漫天堂API 拿它拼鉴权 token、
 * 书音M 拿它给目录接口签名。而 **WebCrypto 不提供 MD5**（设计上就不给弱摘要），
 * 所以只能自己实现一份，放在宿主侧、走同步桥进沙箱 ——
 * 好处是它是纯函数，能在 Node 里和 `node:crypto` 逐条对拍。
 */

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
