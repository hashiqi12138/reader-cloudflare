/**
 * 媒体地址的签名与校验
 *
 * 为什么需要签名
 * --------------
 * 图片和音频不能直接把上游地址交给浏览器，原因有三个，每一个都会让「读不出来」：
 *
 *   1. **防盗链**。多数站点的图片 CDN 校验 Referer，必须是站点自己的域名。
 *      浏览器在 `<img>` 上只能带当前页面的 Referer（也就是我们的域名），改不了。
 *   2. **混合内容**。这些站点大量是 http，而我们部署在 https 上，
 *      浏览器会直接拦掉 http 子资源，连请求都不会发出去。
 *   3. **跨域**。`<audio>` 播放和 `fetch` 探测都需要 CORS 头，上游通常不给。
 *
 * 所以媒体必须由服务端代取。但代取接口一旦开放，它就是一个**对全网开放的反向代理**：
 * 任何人都能拿它当免费中转、隐藏真实来源、消耗我们的额度。
 *
 * 因此只有本站自己发出的媒体地址才允许代取 —— 签名就是那个「自己发出去的」凭证。
 * 签名密钥随机生成后存在库里（见 data/settings.ts），不需要额外的部署配置，
 * 也就不存在「忘了配置密钥导致代理裸奔」这种情况。
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class MediaTokenError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'MediaTokenError'
    }
}

/** 签名载荷：谁的书源 + 取哪个地址 + 什么时候失效 */
export interface MediaTokenPayload {
    sourceId: string
    url: string
}

function toBase64Url(bytes: Uint8Array): string {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(normalized + padding)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
}

async function hmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
    )
}

/**
 * 签一个媒体地址
 *
 * @param ttlSeconds 有效期。章节正文每次读取都会重新签发，
 *                   所以这里不需要很长；短一点能减少凭证被复用的窗口。
 */
export async function signMediaToken(
    secret: string,
    payload: MediaTokenPayload,
    ttlSeconds: number,
    now: number = Date.now(),
): Promise<string> {
    const body = toBase64Url(
        encoder.encode(
            JSON.stringify({
                s: payload.sourceId,
                u: payload.url,
                e: Math.floor(now / 1000) + ttlSeconds,
            }),
        ),
    )
    const signature = new Uint8Array(
        await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body)),
    )
    return `${body}.${toBase64Url(signature)}`
}

/**
 * 校验并还原一个媒体地址
 *
 * 先验签名再解载荷 —— 顺序反过来的话，未签名的内容会被当成可信数据解析，
 * 那正是签名想要防的事情。
 */
export async function verifyMediaToken(
    secret: string,
    token: string,
    now: number = Date.now(),
): Promise<MediaTokenPayload> {
    const dot = token.indexOf('.')
    if (dot <= 0 || dot === token.length - 1) {
        throw new MediaTokenError('媒体地址缺少签名')
    }
    const body = token.slice(0, dot)

    let signature: Uint8Array<ArrayBuffer>
    try {
        signature = fromBase64Url(token.slice(dot + 1))
    } catch {
        throw new MediaTokenError('媒体地址的签名不是合法编码')
    }

    // subtle.verify 自带恒定时间比较，不用自己写比对
    const valid = await crypto.subtle.verify(
        'HMAC',
        await hmacKey(secret),
        signature,
        encoder.encode(body),
    )
    if (!valid) throw new MediaTokenError('媒体地址的签名不对，可能被改过')

    let parsed: unknown
    try {
        parsed = JSON.parse(decoder.decode(fromBase64Url(body)))
    } catch {
        throw new MediaTokenError('媒体地址的载荷不是合法 JSON')
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new MediaTokenError('媒体地址的载荷不是对象')
    }

    const { s, u, e } = parsed as { s?: unknown; u?: unknown; e?: unknown }
    if (typeof s !== 'string' || s === '') throw new MediaTokenError('媒体地址的载荷缺少书源')
    if (typeof u !== 'string' || u === '') throw new MediaTokenError('媒体地址的载荷缺少目标地址')
    if (typeof e !== 'number' || !Number.isFinite(e)) {
        throw new MediaTokenError('媒体地址的载荷缺少有效期')
    }
    if (e * 1000 < now) throw new MediaTokenError('媒体地址已过期，重新打开这一章即可')

    return { sourceId: s, url: u }
}
