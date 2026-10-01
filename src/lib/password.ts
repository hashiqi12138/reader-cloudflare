/**
 * 口令哈希与会话令牌
 *
 * 为什么是 PBKDF2 而不是 bcrypt / scrypt / argon2：
 * 后三者都需要原生模块或额外依赖，而 Workers 里能用的只有 **WebCrypto** ——
 * 它提供 PBKDF2。这不是「最好的选择」，但它是这个运行时上唯一不引依赖的选择，
 * 而「用现成的、经过审查的原语」比「自己糊一个 KDF」强得多。
 *
 * 迭代次数写在**每一行**上（见 migrations/0005）：以后要调高，老账号不必强制改密码，
 * 用户下次登录成功后可以顺手用新参数重算一次哈希。
 *
 * 常数时间比较是自己写的：`crypto.subtle.timingSafeEqual` 是 Cloudflare 的扩展，
 * 在 Node 里没有 —— 而这一层要能在 Node 里单测（它是纯函数）。
 */

/** 新账号的默认迭代次数 */
export const PBKDF2_ITERATIONS = 120_000

/** 派生密钥长度（位） */
const DERIVED_BITS = 256

/** 盐长度（字节） */
const SALT_BYTES = 16

export interface PasswordRecord {
    hash: string
    salt: string
    iterations: number
}

function toBase64(bytes: Uint8Array): string {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}

/**
 * 返回类型显式写成 `Uint8Array<ArrayBuffer>`
 *
 * TS 5.7 起 TypedArray 带上了 buffer 的类型参数，默认是 `ArrayBufferLike`（含
 * SharedArrayBuffer）。而 `crypto.subtle` 只接受真正的 `ArrayBuffer` ——
 * 不写这一笔，`deriveBits({ salt })` 那一处会报「类型不兼容」。
 */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
}

/** URL 安全的 base64（放进 cookie 与查询参数都不需要再转义） */
function toBase64Url(bytes: Uint8Array): string {
    return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 密码学安全的随机 token。**不能用 Math.random** —— 那类随机源是可预测的 */
export function randomToken(byteLength = 32): string {
    const bytes = new Uint8Array(byteLength)
    crypto.getRandomValues(bytes)
    return toBase64Url(bytes)
}

/** 盐也要用密码学随机源：固定的盐等于让彩虹表重新生效 */
export function randomSalt(): string {
    return toBase64(randomBytes(SALT_BYTES))
}

function randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length)
    crypto.getRandomValues(bytes)
    return bytes
}

async function derive(password: string, salt: string, iterations: number): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits'],
    )
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: fromBase64(salt), iterations, hash: 'SHA-256' },
        key,
        DERIVED_BITS,
    )
    return toBase64(new Uint8Array(bits))
}

/** 算出一份新的口令记录 */
export async function hashPassword(
    password: string,
    iterations = PBKDF2_ITERATIONS,
): Promise<PasswordRecord> {
    const salt = randomSalt()
    return { hash: await derive(password, salt, iterations), salt, iterations }
}

/**
 * 常数时间比较两个 base64 串
 *
 * 逐字符 `===` 会在第一个不同的字符处返回，比较耗时因此泄漏「猜对了几位」——
 * 对哈希值来说这不足以直接复原口令，但没有任何理由留这个口子。
 * 长度不同时直接返回 false：长度本身不是秘密。
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}

/** 校验口令。任何异常（比如哈希格式坏了）都按「不通过」处理，不当成服务端错误 */
export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
    try {
        const attempt = await derive(password, record.salt, record.iterations)
        return timingSafeEqual(attempt, record.hash)
    } catch {
        return false
    }
}
