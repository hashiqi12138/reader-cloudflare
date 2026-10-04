/**
 * 取网层
 *
 * 三件在书源场景下必须做对的事：
 *   1. **按站点声明的字符集解码**。国内小说站大量使用 GBK/GB2312，
 *      一律按 UTF-8 解会得到满屏乱码，而乱码会一路传到正文里。
 *      字符集优先取书源配置，其次取响应头，最后从 HTML 的 meta 里嗅探。
 *   2. **限制响应体积**。Workers 有 128 MB 内存上限，一章正文通常几十 KB，
 *      但遇到被重定向到视频/下载页的站点，无上限读取会直接把 Worker 打挂。
 *   3. **带上合理的默认请求头**。不少站点校验 Referer，不带就返回错误页。
 */

import type { FetchPlan } from '../engine/types'
import { cookieHeaderFor, mergeSetCookie } from './cookies'

/**
 * 单次响应最多读取多少字节，超出直接截断并标记
 *
 * 上限是为了挡住「被重定向到视频/下载页」这类意外，而不是为了卡正文长度 ——
 * 所以它必须高于**正常页面的最大体积**。原先定 4 MiB 太紧：
 * 音频源（喜马拉雅）的一章接口返回 5 MB JSON，正文直接读不出来，
 * 报的还是「体积超限」这种与书源无关的错。现在放到 16 MiB，
 * 既覆盖了这类接口型书源，也仍远低于 Workers 的 128 MB 内存上限。
 */
const MAX_BYTES = 16 * 1024 * 1024

export class UpstreamError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message)
        this.name = 'UpstreamError'
    }
}

/** 默认请求头：伪装成普通浏览器，并带上同源 Referer */
export function defaultHeaders(baseUrl: string): Record<string, string> {
    const headers: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    if (baseUrl) {
        try {
            headers.Referer = new URL(baseUrl).origin + '/'
        } catch {
            /* baseUrl 不是合法 URL 就跳过 */
        }
    }
    return headers
}

/** 从 HTML 的 <meta charset> / <meta http-equiv> 里嗅探字符集 */
function sniffCharset(html: string): string | null {
    const head = html.slice(0, 2048)
    const m1 = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head)
    if (m1?.[1]) return m1[1].toLowerCase()
    const m2 = /<meta[^>]+content=["'][^"']*charset=\s*([\w-]+)/i.exec(head)
    if (m2?.[1]) return m2[1].toLowerCase()
    return null
}

function normalizeCharset(raw: string | null | undefined): string | null {
    if (!raw) return null
    const c = raw.trim().toLowerCase().replace(/["']/g, '')
    if (c === '' || c === 'utf8') return 'utf-8'
    return c
}

/** 按字节解码，遇到运行时不支持的字符集就退回 UTF-8 而不是抛错 */
function decode(buffer: ArrayBuffer, charset: string): string {
    try {
        return new TextDecoder(charset).decode(buffer)
    } catch {
        return new TextDecoder('utf-8').decode(buffer)
    }
}

/** 没有请求体的方法 —— 只有这两种不该带 body，也不该带 body 的 Content-Type */
function isBodyless(method: string): boolean {
    const m = method.toUpperCase()
    return m === 'GET' || m === 'HEAD'
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
    const target = name.toLowerCase()
    return Object.keys(headers).some((key) => key.toLowerCase() === target)
}

/**
 * 带请求体时**必须自己声明 Content-Type** —— 表单站点只认 `application/x-www-form-urlencoded`
 *
 * 不声明的话，`fetch` 对字符串 body 会自动补 `text/plain;charset=UTF-8`，而站点那侧
 * 根本不会把这些字节当参数解析。这一条不是猜的：`curl -X POST -H 'Content-Type: text/plain'
 * -d 'a=1&b=2' https://httpbin.org/post` 回的是 `"form": {}`（参数躺在原始 data 里），
 * 换成 `application/x-www-form-urlencoded` 才有 `"form": {"a":"1","b":"2"}` ——
 * PHP 的 `$_POST` 也是同一条规则。
 *
 * 书源里 POST 的 body 全是表单写法（`searchkey={{key}}&page={{page}}`，Legado 的
 * 「URL 参数详解」里 POST 就是这一种），所以缺了这一行，站点收到的是「没有参数」，
 * 返回一个空结果页。于是**搜索「成功」、0 条、不报错** —— 线上 320 个源（39%）用的是
 * POST 搜索，其中只有 4 个自己声明了 Content-Type，其余全栽在这里。
 *
 * 书源自己配了 Content-Type（比如 JSON 接口那几条）时不覆盖。
 */
export function requestHeaders(
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
): Record<string, string> {
    if (body === undefined || body === '' || isBodyless(method)) return headers
    if (hasHeader(headers, 'content-type')) return headers
    return { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }
}

/** 读取响应体，超过上限就截断 */
async function readBounded(response: Response): Promise<ArrayBuffer> {
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_BYTES) {
        throw new UpstreamError(`响应体积 ${declared} 字节，超过 ${MAX_BYTES} 字节上限，已中止读取`)
    }

    if (!response.body) return new ArrayBuffer(0)

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > MAX_BYTES) {
            chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - MAX_BYTES))))
            await reader.cancel()
            break
        }
        chunks.push(value)
    }

    const merged = new Uint8Array(Math.min(total, MAX_BYTES))
    let offset = 0
    for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
    }
    return merged.buffer
}

/**
 * 一次页面请求的默认超时
 *
 * 以前**完全没有超时**，于是站点不响应时只能干等上游自己放弃 —— 实测最慢的一次
 * 是 39 秒（`wrangler tail` 里也能看到 522 要等 20 秒才回来）。20 秒是给
 * 「慢但真的能读」的站点留的余量，同时给所有请求一个上限。
 *
 * 第五十五轮改成自己跟重定向之后，它是**整条链**的预算（见 `fetchDetailed`），
 * 不是每一跳各给一份 —— 否则 5 跳 × 20 秒能把一次搜索拖到 100 秒。
 */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * 最多跟几跳重定向
 *
 * 书源场景里 2 跳（`http` → `https` → `www`）就见顶了，5 跳足够；
 * 超过就**停下、把那个 3xx 当最终响应交出去**（`fetchText` 会照常报
 * 「上游返回 HTTP 302」，比编一个「重定向太多」更贴近事实）。
 */
const MAX_REDIRECTS = 5

/** 这一跳要不要跟下去 */
function isRedirectStatus(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 相对 `Location` 按当前这一跳的地址解析成绝对地址 */
function resolveLocation(location: string, from: string): string {
    try {
        return new URL(location, from).href
    } catch {
        return location
    }
}

/**
 * 搜索阶段的超时
 *
 * 搜索是**一页几个源并发**跑完才回，所以整页的等待时间等于这一页里**最慢的那个源**：
 * 一个卡到 20 秒的源会把整页从 2 秒拖到 20 秒，而这 3 个源里另外两个早就回来了。
 * 对一个「点一次「继续加载」」的动作来说，超过 6 秒还没回来的源，用户已经当作它坏了 ——
 * 与其让整页陪着等，不如早点判定它失败（失败会被健康度记下来，往后排）。
 */
export const SEARCH_TIMEOUT_MS = 6_000

/** 超时与「连不上」要分开说：前者是站点慢，后者是站点没了/被墙，处理方式不同 */
function isTimeout(err: unknown): boolean {
    const name = (err as { name?: unknown } | null | undefined)?.name
    return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * 一次请求的完整结果
 *
 * 存在的理由是 `java.connect(...)`：它返回 Legado 的 `StrResponse`，书源会拿它做
 * `res.code() == 403`、`res.raw().headers('Set-Cookie')`、`res.raw().request().url()`
 * 这类判断与取值 —— 只给正文是不够的，而「不是 2xx 就抛错」恰恰把这类判断变成了异常。
 */
export interface FetchedResponse {
    /** 实际请求的地址（跟随重定向之后的那一个） */
    url: string
    status: number
    /** 响应头，名字已小写；同一个名字可能有多条（`Set-Cookie` 就靠这个） */
    headers: Record<string, string[]>
    body: string
    /**
     * 这次请求**自己**拿到的那一跳重定向（只有第一跳是 3xx 时才有）
     *
     * 为什么要留着它：我们自己替书源把重定向跟完了，但**那个 `Location` 是书源
     * 那次请求的真实响应头** —— 全丢了的话，靠它拿真地址的书源（线上 11 个：
     * 无忧书城 / 米读小说 / 天悦小说 等，写法都是 `java.post(u, body, {}).header('location')`）
     * 只会拿到空串，然后拿空地址去请求。丢掉的是信息，不是噪声。
     */
    redirectedFrom?: { status: number; location: string }
}

/** 把响应头收成「小写名 → 值数组」；`Set-Cookie` 单独取，避免被合并成一条 */
function collectHeaders(headers: Headers): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    headers.forEach((value, name) => {
        const key = name.toLowerCase()
        const list = out[key] ?? (out[key] = [])
        list.push(value)
    })
    const cookies = (headers as { getSetCookie?: () => string[] }).getSetCookie?.()
    if (Array.isArray(cookies) && cookies.length > 0) out['set-cookie'] = cookies
    return out
}

/**
 * 取回文本**与响应元信息**；HTTP 非 2xx **不抛错**，由调用方自己看 `status`
 *
 * 与 `fetchText` 的分工：搜索 / 目录 / 正文这些链路要的是「不是 2xx 就是失败」，
 * 所以 `fetchText` 仍然抛错；而 `java.connect` 要的是「把响应原样交给脚本」。
 *
 * **重定向是自己跟的**（`redirect: 'manual'` 加一个循环），不是交给 `fetch` 的
 * `follow`。两个理由，都不是风格问题：
 *
 *   1. **要看到每一跳的 `Set-Cookie`。** `follow` 会把中间响应整份吃掉，
 *      而站点常常正是用 302 下发会话 cookie（`/cookies/set` 那种）。第五十四轮
 *      把 cookie 罐接上之后，这一条就成了唯一的漏点。
 *   2. **书源要那个 `Location`。** 线上 11 个源的 `searchUrl` 写成
 *      `java.post(url, body, {}).header('location')` —— 它们拿 POST 的 302 去**找真正的
 *      搜索页地址**。`follow` 之后 `Location` 就没了，那些源只会拿到空串。
 *      所以第一跳的三要素留在 `redirectedFrom` 里（见 `FetchedResponse`）。
 *
 * 跟法照抄 `fetch` 的规矩，别自作聪明：301/302/303 上的 POST 退化成 GET 且**不再发 body**
 * （站点把「表单已提交」的那一次 302 指向结果页，再发一遍 body 就成了重复提交）；
 * 307/308 保留方法与 body。超时是**整条链**共享的一份预算。
 */
export async function fetchDetailed(plan: FetchPlan): Promise<FetchedResponse> {
    const timeoutMs = plan.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs

    let method = plan.method.toUpperCase()
    let body = isBodyless(method) ? undefined : plan.body
    let target = plan.url
    let redirectedFrom: FetchedResponse['redirectedFrom']
    let final: { response: Response; headers: Record<string, string[]> } | undefined

    for (let hop = 0; ; hop++) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
            throw new UpstreamError(`请求超时（>${timeoutMs}ms，含重定向）：${plan.url}`)
        }

        /**
         * 带上 cookie 罐里的 Cookie 头（按**这一跳**的地址取 —— 重定向可能换域，
         * 而换过去之后该带的就是那个域的 cookie）
         *
         * **书源自己声明了 `Cookie` 时不覆盖**：有些站点要的是一份专门的 cookie
         * （签名、风控令牌），而罐子里那一份是站点下发的会话 cookie，混在一起反而会挂。
         */
        const jarCookie = plan.cookieJar ? cookieHeaderFor(plan.cookieJar, target) : ''
        const headers =
            jarCookie !== '' && !hasHeader(plan.headers, 'cookie')
                ? { ...plan.headers, Cookie: jarCookie }
                : plan.headers

        let response: Response
        try {
            response = await fetch(target, {
                method,
                // 带 body 时必须自己声明 Content-Type，否则站点收不到参数（见 requestHeaders）
                headers: requestHeaders(method, body, headers),
                body,
                redirect: 'manual',
                signal: AbortSignal.timeout(remaining),
            })
        } catch (err) {
            if (isTimeout(err)) throw new UpstreamError(`请求超时（>${timeoutMs}ms）：${target}`)
            throw new UpstreamError(
                `请求失败：${target}（${err instanceof Error ? err.message : String(err)}）`,
            )
        }

        const collected = collectHeaders(response.headers)

        /**
         * 每一跳的 `Set-Cookie` 都收进罐子，变了就**立刻写回库**（写穿）
         *
         * 落库要等（`await`）：Worker 的响应一旦返回，还在飞的 promise 会被直接掐掉，
         * 而站点恰恰是在**搜索那一趟**（常常是那一趟里的 302）下发会话 cookie 的 ——
         * 不等它写完，「读目录」那一趟就带不上，表现是「搜得到、点进去 403」。
         */
        if (plan.cookieJar) {
            const changed = mergeSetCookie(
                plan.cookieJar,
                response.url || target,
                collected['set-cookie'] ?? [],
            )
            if (changed && plan.persistCookies) {
                try {
                    await plan.persistCookies()
                } catch {
                    /* 落库失败不该让这一次请求失败 —— cookie 丢了顶多少一次会话，正文还得给用户 */
                }
            }
        }

        const location = collected['location']?.[0]
        if (!isRedirectStatus(response.status) || location === undefined || hop >= MAX_REDIRECTS) {
            final = { response, headers: collected }
            break
        }

        if (redirectedFrom === undefined) {
            redirectedFrom = {
                status: response.status,
                location: resolveLocation(location, target),
            }
        }
        // 301/302/303 上的 POST 退化成 GET（别把 body 再发一遍 —— 那是重复提交）
        if (response.status === 301 || response.status === 302 || response.status === 303) {
            if (method === 'POST') {
                method = 'GET'
                body = undefined
            }
        }
        // 跟走的那一跳的正文不要了：省一次读取，也免得把 302 的错误页当成结果
        try {
            await response.body?.cancel()
        } catch {
            /* 已经读完或已关闭都无所谓 */
        }
        target = resolveLocation(location, target)
    }

    // 循环里一定会先赋值再 break（`hop >= MAX_REDIRECTS` 那一支兜底）
    const { response, headers: collected } = final!
    const buffer = await readBounded(response)

    let charset = normalizeCharset(plan.charset)
    if (!charset || charset === 'auto') {
        charset = normalizeCharset(
            /charset=([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1],
        )
    }
    if (!charset) {
        // 先按 UTF-8 试读一段，从 meta 里嗅探真实字符集
        const probe = new TextDecoder('utf-8').decode(buffer.slice(0, 4096))
        charset = normalizeCharset(sniffCharset(probe)) ?? 'utf-8'
    }

    return {
        url: response.url || target,
        status: response.status,
        headers: collected,
        body: decode(buffer, charset),
        ...(redirectedFrom ? { redirectedFrom } : {}),
    }
}

/** 按计划取回文本；非 2xx 抛错 */
export async function fetchText(plan: FetchPlan): Promise<string> {
    const { status, body, url } = await fetchDetailed(plan)
    if (status < 200 || status >= 300) {
        throw new UpstreamError(`上游返回 HTTP ${status}：${url}`, status)
    }
    return body
}
