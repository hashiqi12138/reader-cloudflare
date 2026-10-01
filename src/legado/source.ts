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
        const parsed = JSON.parse(jsonText) as Partial<UrlOptions>
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

/** 把书源级别的请求头（JSON 字符串）解析出来；写坏了就当作没有，不影响主流程 */
function parseSourceHeaders(raw: string | undefined): Record<string, string> {
    if (!raw) return {}
    try {
        const parsed = JSON.parse(raw) as unknown
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
 */
export async function buildPlan(
    rawUrl: string,
    source: BookSource,
    ctx: RuleContext,
): Promise<FetchPlan> {
    const { url: rawTarget, options } = splitUrlAndOptions(rawUrl)
    const resolved = await resolveTemplate(rawTarget, ctx)
    const plan = planFromResolvedUrl(resolved, source, ctx.baseUrl)

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
