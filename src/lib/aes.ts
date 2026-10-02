/**
 * AES 的**同步**实现（CBC / ECB，PKCS7·Zero·无填充）
 *
 * 为什么得自己写
 * ------------
 * 书源里的 `java.createSymmetricCrypto("AES/CBC/PKCS5Padding", key, iv)` 与
 * `java.aesBase64DecodeToString(...)` 是**在脚本里当同步函数调用的**（线上 30 多处），
 * 而两条现成的路都走不通：
 *   - WebCrypto 的 `crypto.subtle` 全是异步的，同步桥里没法等 Promise
 *   - Workers 的 `nodejs_compat` 不提供分组密码（`createCipheriv` 那一路不在支持范围内），
 *     而且**本地 dev 是 Node，可能"能用"**——真那样会出现「本地全绿、线上全挂」
 *
 * 所以这里按 FIPS-197 写一份纯计算实现。好处是它完全可测：单测里与 `node:crypto`
 * 逐条对拍（随机密钥/长度/模式各来一批），再加 FIPS-197 与 NIST SP 800-38A 的官方向量。
 * 这类代码写错的后果是「解密出来是乱码」，而排查时完全看不出是算法的问题。
 *
 * 文件里只留**与 AES 有关**的东西：S 盒、密钥扩展、单块变换。
 * 补位与 CBC/ECB 串块那一层与 DES 共用，在 `cipher.ts`（见那里的说明）。
 *
 * 加密也在实现范围内：`createSymmetricCrypto` 返回的对象上两个方向都有，
 * 书源用它拼请求体（例如把参数加密后提交）。
 */

import {
    decryptBlocks,
    encryptBlocks,
    type BlockCipherOptions,
    type BlockMode,
    type BlockPadding,
} from './cipher'

/** AES 的 S 盒：由 GF(2^8) 的乘法逆元 + 仿射变换算出来，不手抄 256 个常量 */
const SBOX = (() => {
    // 对数/反对数表（生成元 3），用来快速求乘法逆元
    const exp = new Uint8Array(255)
    const log = new Uint8Array(256)
    let x = 1
    for (let i = 0; i < 255; i += 1) {
        exp[i] = x
        log[x] = i
        // x *= 3（GF(2^8) 下等价于 x ^ (x<<1)，溢出时模 0x11b）
        const doubled = (x << 1) ^ (x & 0x80 ? 0x11b : 0)
        x = (x ^ doubled) & 0xff
    }

    const rotl8 = (value: number, bits: number) => ((value << bits) | (value >>> (8 - bits))) & 0xff

    const box = new Uint8Array(256)
    for (let i = 0; i < 256; i += 1) {
        // 乘法逆元：a^-1 = exp[(255 - log a) mod 255]。
        // **必须取模** —— log[1] 是 0，255-0 会越界读到 undefined，
        // 于是 SBOX[1] 算成 0（应为 0x7c）。这种错在刚好没用到那个表项的
        // 测试向量上会「通过」，所以这里格外小心。
        const inverse = i === 0 ? 0 : exp[(255 - log[i]!) % 255]!
        // 仿射变换：s ^ rotl(s,1) ^ rotl(s,2) ^ rotl(s,3) ^ rotl(s,4) ^ 0x63
        box[i] =
            (inverse ^
                rotl8(inverse, 1) ^
                rotl8(inverse, 2) ^
                rotl8(inverse, 3) ^
                rotl8(inverse, 4) ^
                0x63) &
            0xff
    }
    return box
})()

/**
 * S 盒（导出给单测）
 *
 * 之所以要导出：S 盒只错一两个表项时，官方向量有可能**恰好**没用到那一项而通过 ——
 * 开发时就真踩到过（逆元越界导致 SBOX[1] 算成 0，而 FIPS 的单块样例里没出现 0x01）。
 * 测试里逐项对照一次，比多跑几个向量可靠。
 */
export const AES_SBOX: Uint8Array = SBOX

/** 逆 S 盒：把 S 盒反过来查 */
const INV_SBOX = (() => {
    const box = new Uint8Array(256)
    for (let i = 0; i < 256; i += 1) box[SBOX[i]!] = i
    return box
})()

/** GF(2^8) 乘法（模 x^8+x^4+x^3+x+1） */
function gmul(a: number, b: number): number {
    let result = 0
    let x = a & 0xff
    let y = b & 0xff
    while (y > 0) {
        if (y & 1) result ^= x
        x = ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff
        y >>= 1
    }
    return result & 0xff
}

/** 一张轮密钥表 + 轮数 */
interface ExpandedKey {
    words: Uint8Array
    rounds: number
}

function subWord(word: Uint8Array): Uint8Array {
    const out = new Uint8Array(4)
    for (let i = 0; i < 4; i += 1) out[i] = SBOX[word[i]!]!
    return out
}

/** 密钥扩展（FIPS-197 第 5.2 节），支持 128 / 192 / 256 位密钥 */
function expandKey(key: Uint8Array): ExpandedKey {
    const nk = key.length / 4
    if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
        throw new Error(`AES 密钥必须是 16 / 24 / 32 字节，收到 ${key.length} 字节`)
    }
    const rounds = nk + 6
    const totalWords = 4 * (rounds + 1)
    const words = new Uint8Array(totalWords * 4)
    words.set(key)

    // Rcon：2 的连续幂（GF 下），第 1 项起用
    let rcon = 1
    for (let i = nk; i < totalWords; i += 1) {
        // 显式标注成带 ArrayBufferLike 的 Uint8Array：subWord 返回的视图
        // 在 TS 5.7+ 里被标成 Uint8Array<ArrayBuffer>，不标注会和 slice 的推断打架
        let temp: Uint8Array = words.slice((i - 1) * 4, i * 4)
        if (i % nk === 0) {
            // RotWord 再 SubWord，最后异或 Rcon
            temp = subWord(new Uint8Array([temp[1]!, temp[2]!, temp[3]!, temp[0]!]))
            temp[0] = temp[0]! ^ rcon
            rcon = gmul(rcon, 2)
        } else if (nk > 6 && i % nk === 4) {
            temp = subWord(temp)
        }
        for (let j = 0; j < 4; j += 1) {
            words[i * 4 + j] = words[(i - nk) * 4 + j]! ^ temp[j]!
        }
    }
    return { words, rounds }
}

function addRoundKey(state: Uint8Array, words: Uint8Array, round: number): void {
    for (let i = 0; i < 16; i += 1) state[i] = state[i]! ^ words[round * 16 + i]!
}

function shiftRows(state: Uint8Array, inverse: boolean): void {
    // 第 0 行不动；第 r 行左移 r 位（逆变换则右移 r 位）
    for (let r = 1; r < 4; r += 1) {
        const row = [state[r]!, state[r + 4]!, state[r + 8]!, state[r + 12]!]
        for (let c = 0; c < 4; c += 1) {
            const from = inverse ? (c - r + 4) % 4 : (c + r) % 4
            state[r + 4 * c] = row[from]!
        }
    }
}

function mixColumns(state: Uint8Array, inverse: boolean): void {
    // 每列独立做一次矩阵乘；正向与逆向用的系数不同
    const a = [0, 0, 0, 0]
    for (let c = 0; c < 4; c += 1) {
        for (let i = 0; i < 4; i += 1) a[i] = state[c * 4 + i]!
        if (inverse) {
            state[c * 4 + 0] = gmul(a[0]!, 14) ^ gmul(a[1]!, 11) ^ gmul(a[2]!, 13) ^ gmul(a[3]!, 9)
            state[c * 4 + 1] = gmul(a[0]!, 9) ^ gmul(a[1]!, 14) ^ gmul(a[2]!, 11) ^ gmul(a[3]!, 13)
            state[c * 4 + 2] = gmul(a[0]!, 13) ^ gmul(a[1]!, 9) ^ gmul(a[2]!, 14) ^ gmul(a[3]!, 11)
            state[c * 4 + 3] = gmul(a[0]!, 11) ^ gmul(a[1]!, 13) ^ gmul(a[2]!, 9) ^ gmul(a[3]!, 14)
        } else {
            state[c * 4 + 0] = gmul(a[0]!, 2) ^ gmul(a[1]!, 3) ^ a[2]! ^ a[3]!
            state[c * 4 + 1] = a[0]! ^ gmul(a[1]!, 2) ^ gmul(a[2]!, 3) ^ a[3]!
            state[c * 4 + 2] = a[0]! ^ a[1]! ^ gmul(a[2]!, 2) ^ gmul(a[3]!, 3)
            state[c * 4 + 3] = gmul(a[0]!, 3) ^ a[1]! ^ a[2]! ^ gmul(a[3]!, 2)
        }
    }
}

/** 单块加密（16 字节原地） */
function encryptBlock(state: Uint8Array, key: ExpandedKey): void {
    addRoundKey(state, key.words, 0)
    for (let round = 1; round < key.rounds; round += 1) {
        for (let i = 0; i < 16; i += 1) state[i] = SBOX[state[i]!]!
        shiftRows(state, false)
        mixColumns(state, false)
        addRoundKey(state, key.words, round)
    }
    for (let i = 0; i < 16; i += 1) state[i] = SBOX[state[i]!]!
    shiftRows(state, false)
    addRoundKey(state, key.words, key.rounds)
}

/** 单块解密（16 字节原地） */
function decryptBlock(state: Uint8Array, key: ExpandedKey): void {
    addRoundKey(state, key.words, key.rounds)
    for (let round = key.rounds - 1; round >= 1; round -= 1) {
        shiftRows(state, true)
        for (let i = 0; i < 16; i += 1) state[i] = INV_SBOX[state[i]!]!
        addRoundKey(state, key.words, round)
        mixColumns(state, true)
    }
    shiftRows(state, true)
    for (let i = 0; i < 16; i += 1) state[i] = INV_SBOX[state[i]!]!
    addRoundKey(state, key.words, 0)
}

export interface AesOptions extends BlockCipherOptions {
    data: Uint8Array
}

/**
 * 加密一块及以上的数据
 *
 * iv 长度、密文长度、补位这些**与算法无关**的检查都在 `cipher.ts` 里 ——
 * 那边要用 `label` 与 `blockSize` 拼报错信息，所以这里只把这两个事实递过去。
 */
export function aesEncrypt(options: AesOptions): Uint8Array {
    const expanded = expandKey(options.key)
    return encryptBlocks({
        label: 'AES',
        blockSize: 16,
        mode: options.mode,
        padding: options.padding,
        iv: options.iv,
        data: options.data,
        transform: (block) => encryptBlock(block, expanded),
    })
}

export function aesDecrypt(options: AesOptions): Uint8Array {
    const expanded = expandKey(options.key)
    return decryptBlocks({
        label: 'AES',
        blockSize: 16,
        mode: options.mode,
        padding: options.padding,
        iv: options.iv,
        data: options.data,
        transform: (block) => decryptBlock(block, expanded),
    })
}
