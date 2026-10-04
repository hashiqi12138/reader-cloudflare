/*
 * 媒体响应的服务端缓存（走平台那层 `PlatformCache`，Workers 上是 Cache API）
 *
 * 为什么需要它
 * ------------
 * 媒体必须由服务端代取（防盗链 / 混合内容 / 跨域，见 `signing.ts`），于是热门封面
 * 会被反复回源：同一张图，每个换设备的人、每个边缘机房各取一次。浏览器那侧虽然有
 * `public, max-age=86400`，但它只挡住同一个浏览器 —— 挡不住「别人」和「另一个机房」。
 *
 * 为什么键**不是**请求地址
 * ----------------------
 * 媒体令牌里带着过期时间（`e`，见 `signing.ts`），所以同一张图每次签发出来的地址
 * **都不一样**，拿地址当键等于永远命不中。键要从**验签之后的载荷**算
 * （书源 + 目标地址 + 是不是封面），再取个哈希 —— 顺带把上游地址从缓存键里隐掉。
 *
 * 哪些不缓存：每一条都是「存了会出错」，不是保守
 * --------------------------------------------
 * - **书源带登录态**（`loginHeader` / `loginInfo` 非空）：取媒体时会把登录头带上
 *   （见 `mediaRequestHeaders`），也就是这张图可能只有登录后才给。存进**共享**缓存
 *   就会发给没登录的人 —— 那是串号，也是唯一一条会「泄内容」的，所以放在最前面。
 * - **带 `Range` 的请求**：回来的是一段而不是整份，存下来会把后面的播放切坏。
 * - **文件源**（`bookSourceType=3`）：响应头本来就是 `private`，不该进共享缓存；
 *   而且它是给人下载的。
 * - **非图片**：音频动辄几十 MB（正文那条路刻意「不做缓冲」），存它既占配额、
 *   收益也低（音频多数带 Range）。
 * - **体积未知或超过上限**：Cache API 要把响应体收完才写得进去，对「不知道多大」的
 *   东西直接放弃，别拿内存去赌。
 */

import type { MediaTokenPayload } from './signing'
import { sha256Hex } from './hash'

/** 存多久。与给浏览器的 `public, max-age=86400` 对齐（那个值在 `mediaResponseHeaders` 里） */
export const MEDIA_CACHE_TTL_SECONDS = 86_400

/**
 * 观测用的响应头：`hit` / `miss` / `skip`
 *
 * 缓存到底有没有生效，从外面**只看得到这一个信号** —— 命中与未命中的响应体一模一样。
 * 冒烟与线上排查都靠它（见 `scripts/smoke.mjs`）。
 */
export const MEDIA_CACHE_STATUS_HEADER = 'X-Media-Cache'

/** 单张图的上限。封面是几十 KB 量级，3 MB 已经很宽松；再大就不像是封面了 */
export const MEDIA_CACHE_MAX_BYTES = 3 * 1024 * 1024

/** 「这一次代取能不能用共享缓存」的三个条件 */
export interface MediaRequestFacts {
    /** 书源带没带登录态 */
    loggedIn: boolean
    /** 是不是文件源（要强制下载的那种） */
    fileSource: boolean
    /** 请求带没带 `Range` */
    ranged: boolean
}

/** 这次代取值不值得走 / 写共享缓存 */
export function canCacheMediaRequest(facts: MediaRequestFacts): boolean {
    return !facts.loggedIn && !facts.fileSource && !facts.ranged
}

/** 回来的响应配不配存：只认「体积已知且不大」的图片 */
export function canCacheMediaResponse(init: {
    status: number
    contentType: string | null
    contentLength: string | null
}): boolean {
    if (init.status !== 200) return false
    if (!(init.contentType ?? '').toLowerCase().startsWith('image/')) return false

    const size = Number(init.contentLength)
    return Number.isFinite(size) && size > 0 && size <= MEDIA_CACHE_MAX_BYTES
}

/**
 * 缓存键
 *
 * 用**请求自己的源**（`/api/media-cache/<哈希>`）而不是另造一个主机名：
 * Cache API 的键本身就是一个 URL，同源最不容易出意外。
 */
export async function mediaCacheKey(
    requestUrl: string,
    payload: MediaTokenPayload,
): Promise<Request> {
    // 三段分开拼、中间夹换行：免得 (a, bc) 与 (ab, c) 撞成同一个键
    const digest = await sha256Hex(
        `${payload.sourceId}\n${payload.url}\n${payload.cover ? 'cover' : 'media'}`,
    )
    return new Request(new URL(`/api/media-cache/${digest}`, requestUrl).href)
}
