/**
 * base64 与 UTF-8 文本之间的转换
 *
 * 书源里的 `java.base64Encode` / `java.base64Decode` 走这里。**不能直接用
 * `btoa(str)`**：它只接受 Latin1 范围内的字符，碰到中文直接抛
 * `InvalidCharacterError: btoa() can only operate on characters in the Latin1 range`。
 * 而书源里对**中文**做 base64 恰恰是最常见的用法（拼签名、拼请求体），
 * 全量探测里就有一条源（晋江文学）栽在这上面，报的还是一句与书源毫无关系的错。
 *
 * 正确做法是标准的那一套：先取 UTF-8 字节，再逐字节转成 Latin1 字符串交给 `btoa`。
 * 放在 `lib/` 而不是沙箱里，是为了能直接单测（含中文、emoji、空串这些边界）。
 */

/** UTF-8 文本 → base64 */
export function base64OfUtf8(text: string): string {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    // 逐个字符拼接而不是一次 spread：超长字符串走 apply 会撞上参数个数上限
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!)
    return btoa(binary)
}

/** base64 → 原始字节。输入不是合法 base64 时抛错，由调用方决定怎么兜 */
export function bytesOfBase64(encoded: string): Uint8Array {
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
}

/** base64 → UTF-8 文本。输入不是合法 base64 时抛错，由调用方决定怎么兜 */
export function utf8OfBase64(encoded: string): string {
    return new TextDecoder().decode(bytesOfBase64(encoded))
}

/** 原始字节 → base64 */
export function base64OfBytes(bytes: Uint8Array | number[]): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]! & 0xff)
    return btoa(binary)
}
