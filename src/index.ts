/**
 * Worker 入口与 API 路由
 *
 * 设计上刻意让**每个书源独立失败**：聚合搜索时挂掉两三个源是常态，
 * 不该让整次搜索返回错误。所以搜索接口按源返回结果，每个源自带 ok / error。
 */

import { Hono } from 'hono'

import { listSources, findSource } from './data/sources'
import { UnsupportedRuleError } from './engine/analyze'
import { SandboxError, runInSandbox } from './engine/js'
import { parseHtml } from './engine/select'
import { handleFixture } from './fixture'
import { fetchBookInfo, fetchChapters, fetchContent, searchBooks } from './legado/ops'
import { UpstreamError } from './lib/http'

const app = new Hono<{ Bindings: Env }>()

/** 把各类失败映射成明确的 HTTP 状态，而不是一律 500 */
function statusFor(err: unknown): { status: number; code: string } {
  if (err instanceof UnsupportedRuleError) return { status: 422, code: 'unsupported_rule' }
  if (err instanceof SandboxError) return { status: 422, code: 'sandbox_error' }
  if (err instanceof UpstreamError) return { status: 502, code: 'upstream_error' }
  return { status: 500, code: 'internal_error' }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 运行时自检
 *
 * 回答本项目的两个底层不确定性：cheerio 能否在 workerd 里解析 HTML、
 * QuickJS 的 WASM 能否在 workerd 里加载并执行脚本。固定成可回归的探针。
 */
app.get('/api/probe', async (c) => {
  const $ = parseHtml('<div class="title"><a href="/book/1">斗破苍穹</a></div>')

  const cheerioText = $('div.title a').text()
  const cheerioHref = $('div.title a').attr('href') ?? ''

  let quickjsValue = ''
  let quickjsError = ''
  try {
    quickjsValue = String(
      await runInSandbox(
        `result.replace(/[\\s\\S]/, function (m) { return m + '（经 QuickJS 处理）' })`,
        {
          result: cheerioText,
        },
      ),
    )
  } catch (err) {
    quickjsError = describe(err)
  }

  return c.json({
    cheerio: { text: cheerioText, href: cheerioHref },
    quickjs: { value: quickjsValue, error: quickjsError },
    version: c.env.ENGINE_VERSION ?? 'unknown',
  })
})

app.get('/api/health', (c) => c.json({ ok: true }))

/** 当前可用的书源 */
app.get('/api/sources', (c) => {
  const origin = new URL(c.req.url).origin
  return c.json({
    sources: listSources(origin).map((s) => ({
      id: s.id,
      name: s.bookSourceName,
      group: s.bookSourceGroup ?? '',
      builtin: s.builtin,
      hasSearch: Boolean(s.searchUrl && s.ruleSearch?.bookList),
    })),
  })
})

/**
 * 聚合搜索
 *
 * 书源之间并发请求，单个源失败只影响它自己那一条结果。
 */
app.post('/api/search', async (c) => {
  let body: { keyword?: string; sourceIds?: string[] }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: '请求体必须是 JSON，形如 {"keyword":"..."}' }, 400)
  }

  const keyword = (body.keyword ?? '').trim()
  if (keyword === '') return c.json({ error: 'keyword 不能为空' }, 400)

  const origin = new URL(c.req.url).origin
  const all = listSources(origin)
  const wanted = body.sourceIds?.length ? all.filter((s) => body.sourceIds!.includes(s.id)) : all

  const results = await Promise.all(
    wanted.map(async (source) => {
      const started = Date.now()
      try {
        const books = await searchBooks(source, keyword, { baseUrl: origin, key: keyword })
        return {
          sourceId: source.id,
          sourceName: source.bookSourceName,
          ok: true,
          count: books.length,
          elapsedMs: Date.now() - started,
          books,
        }
      } catch (err) {
        return {
          sourceId: source.id,
          sourceName: source.bookSourceName,
          ok: false,
          count: 0,
          elapsedMs: Date.now() - started,
          error: describe(err),
          errorCode: statusFor(err).code,
        }
      }
    }),
  )

  return c.json({
    keyword,
    totalBooks: results.reduce((sum, r) => sum + r.count, 0),
    sources: results,
  })
})

/** 书籍详情（主要为了拿目录地址） */
app.get('/api/book', async (c) => {
  const sourceId = c.req.query('sourceId') ?? ''
  const target = c.req.query('url') ?? ''
  const origin = new URL(c.req.url).origin
  const source = findSource(origin, sourceId)
  if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)
  if (!target) return c.json({ error: '缺少 url 参数' }, 400)

  try {
    const info = await fetchBookInfo(source, target, { baseUrl: origin })
    return c.json({ sourceId: source.id, ...info })
  } catch (err) {
    return c.json({ error: describe(err), code: statusFor(err).code }, statusFor(err).status as 422)
  }
})

/** 目录 */
app.get('/api/toc', async (c) => {
  const sourceId = c.req.query('sourceId') ?? ''
  const target = c.req.query('url') ?? ''
  const origin = new URL(c.req.url).origin
  const source = findSource(origin, sourceId)
  if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)
  if (!target) return c.json({ error: '缺少 url 参数' }, 400)

  try {
    const chapters = await fetchChapters(source, target, { baseUrl: origin })
    return c.json({ sourceId: source.id, count: chapters.length, chapters })
  } catch (err) {
    return c.json({ error: describe(err), code: statusFor(err).code }, statusFor(err).status as 422)
  }
})

/** 正文 */
app.get('/api/content', async (c) => {
  const sourceId = c.req.query('sourceId') ?? ''
  const target = c.req.query('url') ?? ''
  const origin = new URL(c.req.url).origin
  const source = findSource(origin, sourceId)
  if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)
  if (!target) return c.json({ error: '缺少 url 参数' }, 400)

  try {
    const content = await fetchContent(source, target, { baseUrl: origin })
    return c.json({ sourceId: source.id, url: target, length: content.length, content })
  } catch (err) {
    return c.json({ error: describe(err), code: statusFor(err).code }, statusFor(err).status as 422)
  }
})

/** 其余路径交给静态资源（含 SPA 回退） */
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw))

app.notFound((c) => c.json({ error: '接口不存在', path: new URL(c.req.url).pathname }, 404))

app.onError((err, c) => {
  const { status, code } = statusFor(err)
  return c.json({ error: describe(err), code }, status as 422)
})

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // 内置测试站点：默认关闭，只在本地开发与 CI 里打开
    if (env.ENABLE_FIXTURE === 'true') {
      const handled = handleFixture(url.pathname, url)
      if (handled) return handled
    }

    return app.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
