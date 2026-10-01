/**
 * Worker 入口与 API 路由
 *
 * 设计上刻意让**每个书源独立失败**：聚合搜索时挂掉两三个源是常态，
 * 不该让整次搜索返回错误。所以搜索接口按源返回结果，每个源自带 ok / error。
 */

import { Hono } from 'hono'

import { countUserSources, deleteUserSource, importSources, setSourceEnabled } from './data/db'
import { findSource, listEnabledSources, listSources } from './data/sources'
import type { RegistryOptions } from './data/sources'
import { addToShelf, getProgress, listShelf, removeFromShelf, saveProgress } from './data/library'
import type { AddToShelfInput, SaveProgressInput } from './data/library'
import { DataError, bookKey } from './data/types'
import { UnsupportedRuleError } from './engine/analyze'
import { SandboxError, runInSandbox } from './engine/js'
import { parseHtml } from './engine/select'
import { handleFixture } from './fixture'
import { fetchBookInfo, fetchChapters, fetchContent, searchBooks } from './legado/ops'
import { UpstreamError } from './lib/http'
import { USER_HEADER, parseUserToken } from './lib/identity'

const app = new Hono<{ Bindings: Env }>()

/**
 * 导入接口的请求体上限。
 *
 * 一份完整书源集合通常几百 KB；给到 4 MB 是留足余量，同时挡住
 * 「误把整个网站当书源贴进来」这种情况 —— 那种体积在 JSON.parse 阶段就会吃掉大量内存。
 */
const MAX_IMPORT_BODY_BYTES = 4 * 1024 * 1024

type ErrorStatus = 400 | 404 | 413 | 422 | 500 | 502

/** 把各类失败映射成明确的 HTTP 状态，而不是一律 500 */
function statusFor(err: unknown): { status: ErrorStatus; code: string } {
    if (err instanceof UnsupportedRuleError) return { status: 422, code: 'unsupported_rule' }
    if (err instanceof SandboxError) return { status: 422, code: 'sandbox_error' }
    if (err instanceof UpstreamError) return { status: 502, code: 'upstream_error' }
    if (err instanceof DataError) return { status: err.status as ErrorStatus, code: err.code }
    return { status: 500, code: 'internal_error' }
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

/** 统一的失败响应 */
function fail(
    c: { json: (body: unknown, status: ErrorStatus) => Response },
    err: unknown,
): Response {
    const { status, code } = statusFor(err)
    return c.json({ error: describe(err), code }, status)
}

/** 本次请求的注册表选项 */
function registryOf(env: Env): RegistryOptions {
    return { includeFixture: env.ENABLE_FIXTURE === 'true' }
}

/**
 * 取出本次请求的身份
 *
 * 书架与阅读进度按身份隔离；**书源不隔离** ——
 * 书源是「这份实例怎么取网」的配置，属于部署者；书架是使用者自己的数据。
 * 两者混在一起管，只会让「换个浏览器书架空了、书源却还在」这种预期外的行为变多。
 */
function ownerOf(c: { req: { header: (name: string) => string | undefined } }): string {
    try {
        return parseUserToken(c.req.header(USER_HEADER))
    } catch (err) {
        throw new DataError(describe(err), 400, 'missing_identity')
    }
}

/**
 * 运行时自检
 *
 * 回答本项目的三个底层不确定性：cheerio 能否在 workerd 里解析 HTML、
 * QuickJS 的 WASM 能否在 workerd 里加载并执行脚本、D1 绑定是否真的连上了。
 * 固定成可回归的探针。
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

    let sourceCount: number | null = null
    let dbError = ''
    try {
        sourceCount = await countUserSources(c.env.DB)
    } catch (err) {
        dbError = describe(err)
    }

    return c.json({
        cheerio: { text: cheerioText, href: cheerioHref },
        quickjs: { value: quickjsValue, error: quickjsError },
        d1: { userSourceCount: sourceCount, error: dbError },
        version: c.env.ENGINE_VERSION ?? 'unknown',
    })
})

app.get('/api/health', (c) => c.json({ ok: true }))

/** 当前可用的书源 */
app.get('/api/sources', async (c) => {
    const origin = new URL(c.req.url).origin
    const sources = await listSources(c.env.DB, origin, registryOf(c.env))
    return c.json({
        sources: sources.map((s) => ({
            id: s.id,
            name: s.bookSourceName,
            group: s.bookSourceGroup ?? '',
            type: s.bookSourceType ?? 0,
            builtin: s.builtin,
            enabled: s.enabled !== false,
            hasSearch: Boolean(s.searchUrl && s.ruleSearch?.bookList),
        })),
    })
})

/**
 * 导入书源
 *
 * 请求体就是 Legado 书源 JSON 原文：既可以是裸数组，也可以是 `{"sources":[...]}`。
 * 直接吃原文而不是先解析成对象，是为了让「从文件导入」和「粘贴文本」走同一条路 ——
 * 用户从别处复制的书源就是一坨 JSON，多一层包装只会多一处出错的地方。
 */
app.post('/api/sources', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_IMPORT_BODY_BYTES) {
        return c.json(
            {
                error: `请求体 ${Math.round(declared / 1024 / 1024)} MB，超过上限 ${MAX_IMPORT_BODY_BYTES / 1024 / 1024} MB`,
                code: 'body_too_large',
            },
            413,
        )
    }

    const text = await c.req.text()
    if (text.trim() === '') {
        return c.json({ error: '请求体是空的，没有可导入的内容' }, 400)
    }

    try {
        const report = await importSources(c.env.DB, text)
        return c.json({
            ...report,
            total: await countUserSources(c.env.DB),
        })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 启用 / 停用书源
 *
 * id 走请求体而不是路径参数：用户书源的 id 里嵌着站点 URL（`user:https://...`），
 * 放进路径就要处理 `%2F` 这类转义，而中间层（代理、CDN、日志）对编码路径的
 * 处理并不一致，很容易在某一跳被拆开。放进 body 就没有这个问题。
 */
app.patch('/api/sources', async (c) => {
    let body: { id?: unknown; enabled?: unknown }
    try {
        body = await c.req.json()
    } catch {
        return c.json(
            { error: '请求体必须是 JSON，形如 {"id":"user:https://...","enabled":false}' },
            400,
        )
    }

    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') return c.json({ error: '缺少 id' }, 400)
    if (typeof body.enabled !== 'boolean') {
        return c.json({ error: 'enabled 必须是布尔值' }, 400)
    }

    try {
        await setSourceEnabled(c.env.DB, id, body.enabled)
        return c.json({ id, enabled: body.enabled })
    } catch (err) {
        return fail(c, err)
    }
})

/** 删除书源。内置源不可删 */
app.delete('/api/sources', async (c) => {
    const id = c.req.query('id') ?? ''
    if (id === '') return c.json({ error: '缺少 id 参数' }, 400)

    try {
        await deleteUserSource(c.env.DB, id)
        return c.json({ id, deleted: true, total: await countUserSources(c.env.DB) })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 书架
 *
 * 与搜索一样，书架条目本身不在这里校验书源是否存在 —— 书源是可增删的，
 * 书架记的是「这本书来自哪个源、地址是什么」。源被删掉之后书架条目还在，
 * 打开时由前端按源是否可用给出提示，而不是让书架悄悄少几本。
 *
 * 这几个接口都要求带身份头（见 ownerOf）。
 */
app.get('/api/shelf', async (c) => {
    const entries = await listShelf(c.env.DB, ownerOf(c))
    return c.json({ count: entries.length, entries })
})

app.post('/api/shelf', async (c) => {
    const owner = ownerOf(c)

    let body: AddToShelfInput
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const { entry, created } = await addToShelf(c.env.DB, owner, body)
        return c.json({ entry, created }, created ? 201 : 200)
    } catch (err) {
        return fail(c, err)
    }
})

app.delete('/api/shelf', async (c) => {
    const owner = ownerOf(c)
    const key = c.req.query('key') ?? ''
    if (key === '') return c.json({ error: '缺少 key 参数' }, 400)

    try {
        const removed = await removeFromShelf(c.env.DB, owner, key)
        return c.json({ removed: removed.bookKey, name: removed.name })
    } catch (err) {
        return fail(c, err)
    }
})

/** 阅读位置。不在书架里的书也记 —— 否则「读了两章再搜回来」就得从头翻 */
app.get('/api/progress', async (c) => {
    const owner = ownerOf(c)
    const sourceId = c.req.query('sourceId') ?? ''
    const bookUrl = c.req.query('bookUrl') ?? ''
    if (sourceId === '' || bookUrl === '') {
        return c.json({ error: '缺少 sourceId 或 bookUrl 参数' }, 400)
    }

    const progress = await getProgress(c.env.DB, owner, bookKey(sourceId, bookUrl))
    return c.json({ progress: progress ?? null })
})

app.put('/api/progress', async (c) => {
    const owner = ownerOf(c)

    let body: SaveProgressInput
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const progress = await saveProgress(c.env.DB, owner, body)
        return c.json({ progress })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 聚合搜索
 *
 * 书源之间并发请求，单个源失败只影响它自己那一条结果。
 * 只搜**启用的**书源；一个都没有时照样返回 200，
 * 但把 sourceCount 一起给出去，前端才能区分「没有书源」和「没搜到」。
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
    const all = await listEnabledSources(c.env.DB, origin, registryOf(c.env))
    const wanted = body.sourceIds?.length ? all.filter((s) => body.sourceIds!.includes(s.id)) : all

    const results = await Promise.all(
        wanted.map(async (source) => {
            const started = Date.now()
            try {
                const books = await searchBooks(source, keyword, {
                    baseUrl: source.bookSourceUrl,
                    key: keyword,
                })
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
        sourceCount: results.length,
        totalBooks: results.reduce((sum, r) => sum + r.count, 0),
        sources: results,
    })
})

/** 书籍详情（主要为了拿目录地址） */
app.get('/api/book', async (c) => {
    const sourceId = c.req.query('sourceId') ?? ''
    const target = c.req.query('url') ?? ''
    const origin = new URL(c.req.url).origin
    const source = await findSource(c.env.DB, origin, sourceId, registryOf(c.env))
    if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)
    if (!target) return c.json({ error: '缺少 url 参数' }, 400)

    try {
        const info = await fetchBookInfo(source, target, { baseUrl: source.bookSourceUrl })
        return c.json({ sourceId: source.id, ...info })
    } catch (err) {
        return fail(c, err)
    }
})

/** 目录 */
app.get('/api/toc', async (c) => {
    const sourceId = c.req.query('sourceId') ?? ''
    const target = c.req.query('url') ?? ''
    const origin = new URL(c.req.url).origin
    const source = await findSource(c.env.DB, origin, sourceId, registryOf(c.env))
    if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)
    if (!target) return c.json({ error: '缺少 url 参数' }, 400)

    try {
        const chapters = await fetchChapters(source, target, { baseUrl: source.bookSourceUrl })
        return c.json({ sourceId: source.id, count: chapters.length, chapters })
    } catch (err) {
        return fail(c, err)
    }
})

/** 正文 */
app.get('/api/content', async (c) => {
    const sourceId = c.req.query('sourceId') ?? ''
    const target = c.req.query('url') ?? ''
    const origin = new URL(c.req.url).origin
    const source = await findSource(c.env.DB, origin, sourceId, registryOf(c.env))
    if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)
    if (!target) return c.json({ error: '缺少 url 参数' }, 400)

    try {
        const content = await fetchContent(source, target, { baseUrl: source.bookSourceUrl })
        return c.json({ sourceId: source.id, url: target, length: content.length, content })
    } catch (err) {
        return fail(c, err)
    }
})

/** 其余路径交给静态资源（含 SPA 回退） */
app.get('*', async (c) => {
    const path = new URL(c.req.url).pathname

    // 未命中的接口必须回 JSON 404，**不能**被 SPA 回退喂成 index.html。
    // 后者状态码是 200、内容是 HTML，前端拿到会 JSON.parse 失败，
    // 报出来的是「解析出错」而不是「接口不存在」，排查方向直接被带偏。
    if (path.startsWith('/api/')) {
        return c.json({ error: '接口不存在', path }, 404)
    }

    return c.env.ASSETS.fetch(c.req.raw)
})

/** 非 GET 方法命中不了的路径走这里 */
app.notFound((c) => {
    const path = new URL(c.req.url).pathname
    return c.json({ error: '接口不存在', path }, 404)
})

app.onError((err, c) => fail(c, err))

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
