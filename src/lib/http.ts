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

/** 单次响应最多读取多少字节，超出直接截断并标记 */
const MAX_BYTES = 4 * 1024 * 1024

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

/** 按计划取回文本 */
export async function fetchText(plan: FetchPlan): Promise<string> {
  let response: Response
  try {
    response = await fetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: plan.method === 'GET' || plan.method === 'HEAD' ? undefined : plan.body,
      redirect: 'follow',
    })
  } catch (err) {
    throw new UpstreamError(
      `请求失败：${plan.url}（${err instanceof Error ? err.message : String(err)}）`,
    )
  }

  if (!response.ok) {
    throw new UpstreamError(`上游返回 HTTP ${response.status}：${plan.url}`, response.status)
  }

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

  return decode(buffer, charset)
}
