/**
 * 分组密码的**公共外壳**：transformation 解析、补位、CBC/ECB 串块
 *
 * AES（`aes.ts`）与 DES（`des.ts`）在书源眼里是同一个东西 —— 都是一个
 * `createSymmetricCrypto("算法/模式/补位", key, iv)`。真正与算法相关的只有两件事：
 * 密钥怎么扩展、一块怎么变换；其余（补位、CBC 串块、iv 与长度校验、报错措辞）
 * 两边一模一样。
 *
 * 所以把「一样的」放在这一层，「不一样的」留给各自的文件。分开的收益很具体：
 * 补位逻辑重复两份，迟早有一份会漂 —— 而补位错了的症状是「解出来多几个字节的
 * 垃圾」，与密钥错、密文错长得一模一样，是最难查的那类。
 */

/** 分组模式。CFB/OFB/CTR 这些流式模式没做（线上 0 处） */
export type BlockMode = 'CBC' | 'ECB'

/**
 * 补位方式
 *
 * Java 的 `PKCS5Padding` 对 8 字节分组的 DES 与 16 字节分组的 AES 都是「补满一整块」，
 * 与 PKCS7 同义，所以两个名字归一成 `PKCS7`。
 */
export type BlockPadding = 'PKCS7' | 'Zero' | 'None'

export type CipherAlgorithm = 'AES' | 'DES'

export interface ParsedTransformation {
    algorithm: CipherAlgorithm
    mode: BlockMode
    padding: BlockPadding
}

const ALGORITHMS = ['AES', 'DES'] as const

/**
 * 解析 Java 风格的 transformation
 *
 * 线上写法：`AES/CBC/PKCS5Padding`（30 处）、`AES/CBC/PKCS7Padding`（5 处）、
 * `DES/CBC/PKCS5Padding`（3 处）、`AES/CBC/ZeroPadding`（1 处），
 * 大小写混杂（`aes/cbc/pkcs7padding`），也有只写 `AES` 的。
 * 只写算法时按 Java 的默认补齐：CBC + PKCS5。
 *
 * 认不出来的一律**报出具体名字**，不静默降级成别的算法 ——
 * 降级的结果是一段「看起来像密文的东西」解出来的乱码，比直接报错难查得多。
 */
export function parseTransformation(transformation: string): ParsedTransformation {
    const parts = String(transformation)
        .split('/')
        .map((part) => part.trim())
    const rawAlgorithm = (parts[0] ?? '').toUpperCase()
    const mode = (parts[1] ?? 'CBC').toUpperCase()
    const padding = (parts[2] ?? 'PKCS5PADDING').toUpperCase()

    if (!(ALGORITHMS as readonly string[]).includes(rawAlgorithm)) {
        throw new Error(
            `本引擎只实现了 ${ALGORITHMS.join(' 与 ')}，不支持 ${rawAlgorithm}（transformation: ${transformation}）`,
        )
    }
    if (mode !== 'CBC' && mode !== 'ECB') {
        throw new Error(
            `暂不支持 ${rawAlgorithm} 的 ${mode} 模式（transformation: ${transformation}）`,
        )
    }

    let normalizedPadding: BlockPadding
    if (padding === 'NOPADDING') normalizedPadding = 'None'
    else if (padding === 'ZEROPADDING') normalizedPadding = 'Zero'
    else if (padding === 'PKCS5PADDING' || padding === 'PKCS7PADDING') normalizedPadding = 'PKCS7'
    else {
        throw new Error(`暂不支持 ${padding} 补位（transformation: ${transformation}）`)
    }

    return { algorithm: rawAlgorithm as CipherAlgorithm, mode, padding: normalizedPadding }
}

/** 一次加解密调用要用到的参数（AES 与 DES 的形状完全一致） */
export interface BlockCipherOptions {
    mode: BlockMode
    padding: BlockPadding
    key: Uint8Array
    /** ECB 不需要；CBC 必填 */
    iv?: Uint8Array | null
    data: Uint8Array
}

export type BlockCipher = (options: BlockCipherOptions) => Uint8Array

export interface BlockRunOptions {
    /** 报错信息里用的算法名（'AES' / 'DES'），让「iv 长度不对」能看出是哪个算法 */
    label: string
    blockSize: number
    mode: BlockMode
    padding: BlockPadding
    iv?: Uint8Array | null
    data: Uint8Array
    /** 原地变换一块。密钥扩展由调用方闭包持有，这里不认识密钥 */
    transform: (block: Uint8Array) => void
}

function checkIv(options: BlockRunOptions): Uint8Array | null {
    const iv = options.iv ?? null
    if (options.mode !== 'CBC') return null
    if (!iv || iv.length !== options.blockSize) {
        throw new Error(
            `${options.label}/CBC 需要 ${options.blockSize} 字节的 iv，收到 ${
                iv ? `${iv.length} 字节` : '空值'
            }`,
        )
    }
    return iv
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
    for (let i = 0; i < target.length; i += 1) target[i] = target[i]! ^ source[i]!
}

/** CBC / ECB 加密：补位 → 逐块（CBC 先异或上一块密文）→ 加密 */
export function encryptBlocks(options: BlockRunOptions): Uint8Array {
    const iv = checkIv(options)
    const padded = addPadding(options.data, options.padding, options.blockSize)
    const out = new Uint8Array(padded.length)

    // 只有 CBC 才把「上一块密文」串到下一块；ECB 的块之间完全独立
    let previous = options.mode === 'CBC' ? iv : null

    for (let offset = 0; offset < padded.length; offset += options.blockSize) {
        const block = padded.slice(offset, offset + options.blockSize)
        if (previous) xorInto(block, previous)
        options.transform(block)
        out.set(block, offset)
        // ECB 无条件串块的话，每一块（除首块）都会解错 —— 而密文长度照样对得上
        if (options.mode === 'CBC') previous = block
    }
    return out
}

/** CBC / ECB 解密：逐块解密 → CBC 异或上一块**密文** → 去补位 */
export function decryptBlocks(options: BlockRunOptions): Uint8Array {
    const iv = checkIv(options)
    if (options.data.length === 0 || options.data.length % options.blockSize !== 0) {
        throw new Error(
            `${options.label} 密文长度必须是 ${options.blockSize} 的倍数，收到 ${
                options.data.length
            } 字节（base64 解出来不对时会是这样）`,
        )
    }

    const out = new Uint8Array(options.data.length)
    let previous = options.mode === 'CBC' ? iv : null

    for (let offset = 0; offset < options.data.length; offset += options.blockSize) {
        const cipherBlock = options.data.slice(offset, offset + options.blockSize)
        const block = cipherBlock.slice()
        options.transform(block)
        if (previous) xorInto(block, previous)
        out.set(block, offset)
        if (options.mode === 'CBC') previous = cipherBlock
    }
    return removePadding(out, options.padding, options.blockSize)
}

export function addPadding(data: Uint8Array, padding: BlockPadding, blockSize: number): Uint8Array {
    const remainder = data.length % blockSize
    if (padding === 'None') {
        if (remainder !== 0) {
            throw new Error(
                `NoPadding 要求数据长度是 ${blockSize} 的倍数，收到 ${data.length} 字节`,
            )
        }
        return data
    }
    if (padding === 'Zero') {
        // 已对齐时**不补**：Java 的 ZeroPadding 也不补，否则尾部会多出一整块 0
        if (remainder === 0) return data
        const out = new Uint8Array(data.length + (blockSize - remainder))
        out.set(data)
        return out
    }
    // PKCS7（Java 的 PKCS5Padding 就是它）：补满一整块，补几个字节就填几个几
    const padLength = blockSize - remainder
    const out = new Uint8Array(data.length + padLength)
    out.set(data)
    out.fill(padLength, data.length)
    return out
}

export function removePadding(
    data: Uint8Array,
    padding: BlockPadding,
    blockSize: number,
): Uint8Array {
    if (padding === 'None' || data.length === 0) return data

    if (padding === 'Zero') {
        // 尾部连续的 0 都去掉 —— 与 Java 的 ZeroPadding 语义一致（它不记长度）
        let end = data.length
        while (end > 0 && data[end - 1] === 0) end -= 1
        return data.slice(0, end)
    }

    const padLength = data[data.length - 1]!
    if (padLength < 1 || padLength > blockSize || padLength > data.length) {
        // 补位字节不合法，多半是密钥/iv 不对。**不猜**，明确报出来 ——
        // 硬按 blockSize 截一段的话，会得到一段看起来正常、其实是垃圾的正文
        throw new Error(`PKCS7 补位字节是 ${padLength}，不合法（通常是密钥或 iv 不对）`)
    }
    for (let i = data.length - padLength; i < data.length; i += 1) {
        if (data[i] !== padLength) {
            throw new Error('PKCS7 补位内容不一致（通常是密钥或 iv 不对）')
        }
    }
    return data.slice(0, data.length - padLength)
}
