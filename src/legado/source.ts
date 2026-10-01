/**
 * Legado 书源的模型与 URL 解析
 *
 * 书源里的 URL 不是纯 URL，而是一段「URL + 请求选项」的紧凑写法：
 *
 *   https://www.example.com/search?q={{key}}&p={{page}},{"charset":"gbk","method":"POST","body":"..."}
 *
 * 逗号后面那段是 JSON 形式的请求选项。URL 里的 `{{}}` 是 JS 表达式
 * （`{{key}}`、`{{page}}`、`{{java.base64Encode(key)}}` 都是这么写的），
 * 因此解析它必须走沙箱。
 */

import { runInSandbox, sandboxResultToString } from '../engine/js'
import type { BookSource, FetchPlan, RuleContext, SandboxHttp } from '../engine/types'
import { parseLooseJson } from '../lib/json'
import { defaultHeaders, fetchText, UpstreamError } from '../lib/http'

/** 书源 URL 尾部可带的请求选项 */
export interface UrlOptions {
    method: string
    charset: string
    headers: Record<string, string>
    body?: string
    /** 需要 WebView 渲染的站点本引擎不支持，必须显式拒绝 */
    webView: boolean
}

/**
 * 拆出 URL 与请求选项
 *
 * 用第一个 `,{` 作为分界：真正的 URL 里出现 `,{` 是极罕见的，
 * 而选项段一定以 `{` 开头。解析失败时**抛错而不是降级**——
 * 把选项当 URL 用会得到一个看起来正常、实际请求错地方的 URL，那种错最难查。
 */
export function splitUrlAndOptions(raw: string): { url: string; options: Partial<UrlOptions> } {
    const trimmed = raw.trim()
    const index = trimmed.indexOf(',{')
    if (index === -1) return { url: trimmed, options: {} }

    const url = trimmed.slice(0, index).trim()
    const jsonText = trimmed.slice(index + 1).trim()
    try {
        const parsed = parseLooseJson<Partial<UrlOptions>>(jsonText)
        return { url, options: parsed }
    } catch {
        throw new UpstreamError(
            `书源 URL 的请求选项不是合法 JSON，无法确定该请求哪里：${jsonText.slice(0, 80)}`,
        )
    }
}

/** 解析 `{{}}` 模板：里面是 JS 表达式，用沙箱求值 */
export async function resolveTemplate(template: string, ctx: RuleContext): Promise<string> {
    const re = /\{\{([\s\S]*?)\}\}/g
    let out = ''
    let last = 0
    let match: RegExpExecArray | null

    while ((match = re.exec(template)) !== null) {
        out += template.slice(last, match.index)
        const expr = (match[1] ?? '').trim()
        if (expr === '') {
            out += ''
        } else {
            const value = await runInSandbox(
                expr,
                {
                    key: ctx.key ?? '',
                    page: ctx.page ?? 1,
                    book: ctx.book ?? {},
                    baseUrl: ctx.baseUrl,
                },
                { http: ctx.http },
            )
            out += sandboxResultToString(value)
        }
        last = re.lastIndex
    }
    out += template.slice(last)
    return out
}

/**
 * 把书源级别的请求头解析出来
 *
 * 注意这里**只认 JSON**：书源里 `header` 也可以写成 `<js>...</js>` 让脚本动态生成，
 * 那种情况目前会被当作「没有请求头」静默丢掉（见 README 的「已知缺口」）。
 * 丢请求头会让站点返回不同版本甚至拒绝服务，症状是「搜不到书」而不是报错 ——
 * 这是当前实现里的一处已知短板，不是有意设计。
 */
function parseSourceHeaders(raw: string | undefined): Record<string, string> {
    if (!raw) return {}
    try {
        const parsed = parseLooseJson<unknown>(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const out: Record<string, string> = {}
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                out[k] = String(v)
            }
            return out
        }
    } catch {
        /* 书源里的 header 写坏很常见，忽略即可 */
    }
    return {}
}

/**
 * 由**已解析**的地址构造请求计划
 *
 * 不含 `{{}}` 模板求值与 URL 选项解析 —— 供沙箱内的 `java.ajax` 复用，
 * 那里必须避开模板，否则会绕成递归（见 sandboxHttp 的说明）。
 */
export function planFromResolvedUrl(
    resolvedUrl: string,
    source: BookSource,
    baseUrl: string,
): FetchPlan {
    let absolute = resolvedUrl.trim()
    try {
        absolute = new URL(absolute, baseUrl || source.bookSourceUrl).href
    } catch {
        throw new UpstreamError(`无法解析为合法地址：${resolvedUrl.slice(0, 120)}`)
    }

    return {
        url: absolute,
        method: 'GET',
        headers: { ...defaultHeaders(absolute), ...parseSourceHeaders(source.header) },
        charset: 'auto',
        webView: false,
    }
}

/**
 * 把一条书源 URL 变成可直接执行的请求计划
 *
 * @param rawUrl 书源里的原始 URL 文本（可能带 `{{}}` 与请求选项）
 * @param source 所属书源，用来取默认请求头
 * @param ctx 求值上下文，提供 key / page / book
 *
 * **相对地址一律以 `bookSourceUrl` 为基准**，绝不能拿「当前请求的来源」当基准：
 * 真实书源里 searchUrl 写成 `/search.html?word={{key}}` 这种相对路径很常见，
 * 而书源指向的站点与我们部署的域名毫无关系。用请求来源去解析会得到一个指向**我们自己**
 * 的地址 —— 更糟的是 SPA 回退还会回 200 + 首页 HTML，规则照样能从首页里抠出东西，
 * 于是「搜索成功了」，但结果是本站首页里的链接。这条路径不会报任何错。
 *
 * 字段规则（bookUrl / tocUrl / chapterUrl 这类）里的相对地址是另一回事，
 * 它们以**当前页地址**为基准，由 `ops.ts` 用 resolveUrl 处理。
 */
export async function buildPlan(
    rawUrl: string,
    source: BookSource,
    ctx: RuleContext,
): Promise<FetchPlan> {
    const { url: rawTarget, options } = splitUrlAndOptions(rawUrl)
    // 模板里的 baseUrl 同样应该是书源地址，而不是请求来源
    const templateCtx: RuleContext = { ...ctx, baseUrl: source.bookSourceUrl }
    const resolved = await resolveTemplate(rawTarget, templateCtx)
    const plan = planFromResolvedUrl(resolved, source, source.bookSourceUrl)

    if (options.webView) {
        throw new UpstreamError(
            `该规则要求 WebView 渲染（webView: true），本引擎不支持：${plan.url}`,
        )
    }

    return {
        ...plan,
        method: (options.method ?? 'GET').toUpperCase(),
        headers: { ...plan.headers, ...(options.headers ?? {}) },
        body: options.body,
        charset: options.charset ?? 'auto',
    }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
    const target = name.toLowerCase()
    return Object.keys(headers).some((key) => key.toLowerCase() === target)
}

/**
 * 取媒体（图片/音频/文件）用的请求头
 *
 * 与页面请求只差两处，但这两处决定媒体能不能取回来：
 *
 *   1. **Referer 要用书源站点的地址**。防盗链校验的正是它，而图片 CDN 的域名
 *      通常与站点域名完全不同 —— 拿媒体地址自己的 origin 当 Referer 一定过不了。
 *   2. **Accept 放宽成通配**。默认头声明只要 html，部分 CDN 会照此直接返回 406。
 *
 * 书源自己配了 Referer 时以书源为准：有些站点的媒体确实要专门的 Referer 或 Cookie。
 */
export function mediaRequestHeaders(source: BookSource, mediaUrl: string): Record<string, string> {
    const fromSource = parseSourceHeaders(source.header)
    const headers: Record<string, string> = { ...defaultHeaders(mediaUrl), ...fromSource }

    headers.Accept = '*/*'

    if (!hasHeader(fromSource, 'referer')) {
        try {
            headers.Referer = new URL(source.bookSourceUrl).origin + '/'
        } catch {
            /* bookSourceUrl 不是合法地址就保持默认 */
        }
    }
    return headers
}

/**
 * 构造沙箱内 `java.ajax` / `java.get` / `java.post` 用的取网能力
 *
 * 刻意**不复用 buildPlan**：那个函数会解析 `{{}}` 模板，而模板求值本身要进沙箱，
 * 沙箱里的 java.ajax 又回头取网 —— 一条 `{{java.ajax(...)}}` 就能把自己绕成递归。
 * 这里只处理「地址 + 可选的请求选项」，不碰模板。
 *
 * 请求次数与总时限的上限由沙箱统一控制（见 engine/js.ts）。
 */
export function sandboxHttp(source: BookSource, baseUrl: string): SandboxHttp {
    return {
        async fetchText(url, options = {}) {
            const { url: rawTarget, options: urlOptions } = splitUrlAndOptions(url)
            const plan = planFromResolvedUrl(rawTarget, source, baseUrl)
            return fetchText({
                ...plan,
                method: (options.method ?? urlOptions.method ?? 'GET').toUpperCase(),
                body: options.body ?? urlOptions.body,
                headers: {
                    ...plan.headers,
                    ...(urlOptions.headers ?? {}),
                    ...(options.headers ?? {}),
                },
            })
        },
    }
}
