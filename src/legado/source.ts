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
import type { BookSource, FetchPlan, RuleContext } from '../engine/types'
import { defaultHeaders, UpstreamError } from '../lib/http'

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
      const value = await runInSandbox(expr, {
        key: ctx.key ?? '',
        page: ctx.page ?? 1,
        book: ctx.book ?? {},
        baseUrl: ctx.baseUrl,
      })
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

  // 相对地址要拼到书源域名上
  const base = ctx.baseUrl || source.bookSourceUrl
  let absolute = resolved.trim()
  try {
    absolute = new URL(absolute, base).href
  } catch {
    throw new UpstreamError(`无法解析为合法地址：${resolved.slice(0, 120)}`)
  }

  if (options.webView) {
    throw new UpstreamError(`该规则要求 WebView 渲染（webView: true），本引擎不支持：${absolute}`)
  }

  const headers: Record<string, string> = {
    ...defaultHeaders(absolute),
    ...parseSourceHeaders(source.header),
    ...(options.headers ?? {}),
  }

  return {
    url: absolute,
    method: (options.method ?? 'GET').toUpperCase(),
    headers,
    body: options.body,
    charset: options.charset ?? 'auto',
    webView: Boolean(options.webView),
  }
}
