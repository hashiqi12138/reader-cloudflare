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

/** 小写十六进制，小端序（MD5 的输出字节序就是小端） */
function hexLE(value: number): string {
    let out = ''
    for (let i = 0; i < 4; i += 1) {
        out += ((value >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
    }
    return out
}

/**
 * MD5，返回 32 位小写十六进制
 *
 * 输入按 **UTF-8** 取字节 —— 与 Legado 的 `java.md5Encode` 一致；
 * 直接对 JS 字符串按 UTF-16 取字节的话，含中文的输入会算出完全不同的结果。
 */
export function md5Hex(input: string): string {
    const bytes = new TextEncoder().encode(input)
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

    return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0)
}
