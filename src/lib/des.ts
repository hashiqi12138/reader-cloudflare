/**
 * DES 的**同步**实现（CBC / ECB，与 AES 共用补位与串块那一层）
 *
 * 为什么连 DES 也要自己写
 * ----------------------
 * 线上有 3 条书源用 `createSymmetricCrypto("DES/CBC/PKCS5Padding", key, iv)`
 * 解正文（晋江文学那几条）。和 AES 一样，现成的两条路都不通：WebCrypto 不提供
 * DES，而 Workers 的 `nodejs_compat` 里没有 `createCipheriv`——更麻烦的是
 * **本地 dev 跑在 Node 上、DES 也要 OpenSSL 3 的 legacy provider 才有**，
 * 所以「靠 node:crypto」会做出一份环境相关的实现。
 *
 * 一个必须说清楚的验证条件
 * ----------------------
 * AES 那一份可以拿 `node:crypto` 随机对拍，DES **不行**（本机的 OpenSSL 3 直接报
 * `digital envelope routines::unsupported`）。所以这一份的验证来自三个互相独立的方向：
 *
 *   1. **公开的已知答案向量**（下面测试里那几组）；
 *   2. **结构性不变式**，它们不依赖任何记忆中的数字：
 *      - `IP` 与 `FP` 互逆（FP 是从 IP 现算的，测试里逐位验一遍）；
 *      - 弱密钥（四个）下加密是**对合**：`E_K(E_K(P)) = P`；
 *      - 补性质：`E(~K, ~P) = ~E(K, P)`；
 *      - CBC/ECB 往返一致、与 AES 结果不同。
 *   3. 与 AES **共用**的补位/串块那一层已经被 AES 的随机对拍覆盖过。
 *
 * 三组已知向量同时对上的概率可以忽略不计，所以「向量全中 + 不变式全过」足以认定实现正确。
 */

import { decryptBlocks, encryptBlocks, type BlockCipherOptions, type BlockCipher } from './cipher'

// ---------------------------------------------------------------- 置换表
//
// 全部按 FIPS 46-3 的写法：数字是**源位的序号（1 起、最高位在前）**。
// 这类表只能照抄，所以摆成和标准文档一样的形状，方便逐行核对。

/** 初始置换 IP */
const IP = [
    58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64,
    56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53,
    45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
]

/**
 * 末置换 FP
 *
 * **由 IP 现算而不是照抄**：FP 就是 IP 的逆置换。少抄一张 64 项的整数表，
 * 就少一次抄错的机会；而且这样「互逆」这件事可以在测试里逐位断言 ——
 * 照抄的话两边各错一处也可能恰好自洽，只能靠向量兜住。
 */
const FP = (() => {
    const out = new Array<number>(64)
    for (let i = 0; i < 64; i += 1) out[IP[i]! - 1] = i + 1
    return out
})()

/** 扩展置换 E：32 → 48 位 */
const E = [
    32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18,
    19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
]

/** 轮函数末尾的置换 P：32 → 32 位 */
const P = [
    16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13,
    30, 6, 22, 11, 4, 25,
]

/** 密钥置换 PC-1：64 → 56 位（丢掉 8 个校验位） */
const PC1 = [
    57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60,
    52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29,
    21, 13, 5, 28, 20, 12, 4,
]

/** 密钥置换 PC-2：56 → 48 位（这就是轮密钥） */
const PC2 = [
    14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52,
    31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
]

/** 每轮的左移位数 */
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]

/**
 * 8 个 S 盒
 *
 * 标准文档里每个盒子是 4 行 × 16 列；查表时「行号 = 6 位里的首尾两位、
 * 列号 = 中间四位」。这里就用 4×16 的形状原样摆着，好在核对时一眼看出位置对不对。
 */
const SBOXES: readonly (readonly number[])[] = [
    // S1
    [
        14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12,
        11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1,
        7, 5, 11, 3, 14, 10, 0, 6, 13,
    ],
    // S2
    [
        15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1,
        10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15,
        4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
    ],
    // S3
    [
        10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14,
        12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8,
        7, 4, 15, 14, 3, 11, 5, 2, 12,
    ],
    // S4
    [
        7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2,
        12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1,
        13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
    ],
    // S5
    [
        2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15,
        10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14,
        2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
    ],
    // S6
    [
        12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13,
        14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5,
        15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
    ],
    // S7
    [
        4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5,
        12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4,
        10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
    ],
    // S8
    [
        13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6,
        11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10,
        8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
    ],
]

// ---------------------------------------------------------------- 位运算小工具
//
// 一块 64 位的数据用两个 32 位数表示（[高 32 位, 低 32 位]）。表里的序号是
// 1 起、最高位在前，于是「第 n 位」落在哪个字、以及落在字的哪一位都是固定的，
// 不必来回转成大整数（BigInt 在这里只会更慢）。

type Pair = readonly [number, number]

/** 取 64 位视图里的第 index 位（1 起、最高位在前） */
function bitOf(value: Pair, index: number): number {
    const [hi, lo] = value
    return index <= 32 ? (hi >>> (32 - index)) & 1 : (lo >>> (64 - index)) & 1
}

/** 按表做置换，源与结果都按 64 位视图（表里是 1 起的源位序号） */
function permutePair(value: Pair, table: readonly number[]): Pair {
    let hi = 0
    let lo = 0
    for (let i = 0; i < table.length; i += 1) {
        if (bitOf(value, table[i]!) === 0) continue
        if (i < 32) hi = (hi | (1 << (31 - i))) >>> 0
        else lo = (lo | (1 << (63 - i))) >>> 0
    }
    return [hi, lo]
}

/** 把一个 32 位字按表（1 起、最高位在前）扩展/置换，结果可能超过 32 位（E 是 48 位） */
function permuteFrom32(source: number, table: readonly number[]): Pair {
    let hi = 0
    let lo = 0
    for (let i = 0; i < table.length; i += 1) {
        if (((source >>> (32 - table[i]!)) & 1) === 0) continue
        if (i < 32) hi = (hi | (1 << (31 - i))) >>> 0
        else lo = (lo | (1 << (63 - i))) >>> 0
    }
    return [hi, lo]
}

/** 把 32 位字按表置换回 32 位（P 用） */
function permuteTo32(source: number, table: readonly number[]): number {
    let out = 0
    for (let i = 0; i < table.length; i += 1) {
        // 用 *2 而不是 <<1：32 位字左移 32 次会被 JS 取模回到 0，这里必须真的进位
        out = (out * 2 + ((source >>> (32 - table[i]!)) & 1)) >>> 0
    }
    return out
}

function xorPair(a: Pair, b: Pair): Pair {
    return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0]
}

function bytesToPair(bytes: Uint8Array): Pair {
    let hi = 0
    let lo = 0
    for (let i = 0; i < 4; i += 1) hi = (hi * 256 + bytes[i]!) >>> 0
    for (let i = 4; i < 8; i += 1) lo = (lo * 256 + bytes[i]!) >>> 0
    return [hi, lo]
}

function pairToBytes(value: Pair): Uint8Array {
    const out = new Uint8Array(8)
    let hi = value[0]
    let lo = value[1]
    for (let i = 3; i >= 0; i -= 1) {
        out[i] = hi & 0xff
        hi = hi >>> 8
    }
    for (let i = 7; i >= 4; i -= 1) {
        out[i] = lo & 0xff
        lo = lo >>> 8
    }
    return out
}

// ---------------------------------------------------------------- 密钥扩展

function toBits(value: number, count: number): number[] {
    const out: number[] = []
    for (let i = count - 1; i >= 0; i -= 1) out.push((value >>> i) & 1)
    return out
}

function keyBitsOf(key: Uint8Array): number[] {
    const out: number[] = []
    for (const byte of key) for (let i = 7; i >= 0; i -= 1) out.push((byte >>> i) & 1)
    return out
}

function rotateLeft(bits: number[], count: number): number[] {
    const shift = count % bits.length
    return bits.slice(shift).concat(bits.slice(0, shift))
}

function bitsToPair(bits: number[]): Pair {
    let hi = 0
    let lo = 0
    for (let i = 0; i < bits.length; i += 1) {
        if (bits[i] === 0) continue
        if (i < 32) hi = (hi | (1 << (31 - i))) >>> 0
        else lo = (lo | (1 << (63 - i))) >>> 0
    }
    return [hi, lo]
}

/**
 * 16 个 48 位轮密钥
 *
 * 密钥先过 PC-1 丢掉校验位，再劈成左右各 28 位；每轮各自循环左移、拼起来过 PC-2。
 * 导出是为了能直接测「弱密钥下 16 个轮密钥全相同」这条结构性事实。
 */
export function desSubkeys(key: Uint8Array): Pair[] {
    if (key.length !== 8) {
        throw new Error(`DES 密钥必须是 8 字节，收到 ${key.length} 字节`)
    }
    const keyBits = keyBitsOf(key)
    const permuted = PC1.map((index) => keyBits[index - 1]!)
    let c = permuted.slice(0, 28)
    let d = permuted.slice(28)

    const subkeys: Pair[] = []
    for (let round = 0; round < 16; round += 1) {
        c = rotateLeft(c, SHIFTS[round]!)
        d = rotateLeft(d, SHIFTS[round]!)
        const cd = c.concat(d)
        subkeys.push(bitsToPair(PC2.map((index) => cd[index - 1]!)))
    }
    return subkeys
}

// ---------------------------------------------------------------- 单块加解密

/** 轮函数 f(R, K)：扩展 → 与轮密钥异或 → 8 个 S 盒 → 置换 P */
function feistel(right: number, subkey: Pair): number {
    const expanded = xorPair(permuteFrom32(right, E), subkey)

    let packed = 0
    for (let box = 0; box < 8; box += 1) {
        const start = box * 6
        const b0 = bitOf(expanded, start + 1)
        const b5 = bitOf(expanded, start + 6)
        // 行号 = 首尾两位，列号 = 中间四位
        const row = (b0 << 1) | b5
        let column = 0
        for (let i = 1; i <= 4; i += 1) column = (column << 1) | bitOf(expanded, start + 1 + i)
        packed = (packed * 16 + SBOXES[box]![row * 16 + column]!) >>> 0
    }
    return permuteTo32(packed, P)
}

function cryptBlock(block: Uint8Array, subkeys: Pair[], decrypting: boolean): Uint8Array {
    const permuted = permutePair(bytesToPair(block), IP)
    let left = permuted[0]
    let right = permuted[1]

    for (let round = 0; round < 16; round += 1) {
        // 解密就是把 16 个轮密钥倒过来用，其余完全一样
        const subkey = subkeys[decrypting ? 15 - round : round]!
        const next = (left ^ feistel(right, subkey)) >>> 0
        left = right
        right = next
    }
    // 16 轮之后左右再交换一次才过 FP —— 这是 DES 的定义，不是笔误
    return pairToBytes(permutePair([right, left], FP))
}

/** 一遍算好轮密钥，逐块变换（`cipher.ts` 只要求「原地变换一块」） */
function blockTransform(key: Uint8Array, decrypting: boolean): (block: Uint8Array) => void {
    const subkeys = desSubkeys(key)
    return (block: Uint8Array) => {
        block.set(cryptBlock(block, subkeys, decrypting))
    }
}

export const desEncrypt: BlockCipher = (options: BlockCipherOptions): Uint8Array =>
    encryptBlocks({
        label: 'DES',
        blockSize: 8,
        mode: options.mode,
        padding: options.padding,
        iv: options.iv,
        data: options.data,
        transform: blockTransform(options.key, false),
    })

export const desDecrypt: BlockCipher = (options: BlockCipherOptions): Uint8Array =>
    decryptBlocks({
        label: 'DES',
        blockSize: 8,
        mode: options.mode,
        padding: options.padding,
        iv: options.iv,
        data: options.data,
        transform: blockTransform(options.key, true),
    })

/** 单块加密（不带模式与补位），单测里对着已知向量用 */
export function desEncryptBlock(block: Uint8Array, key: Uint8Array): Uint8Array {
    return cryptBlock(block, desSubkeys(key), false)
}

export function desDecryptBlock(block: Uint8Array, key: Uint8Array): Uint8Array {
    return cryptBlock(block, desSubkeys(key), true)
}

/** 置换表（导出给单测：IP 与 FP 必须互逆，这件事值得逐位钉住） */
export const DES_TABLES = { IP, FP, E, P, PC1, PC2, SBOXES, SHIFTS }
