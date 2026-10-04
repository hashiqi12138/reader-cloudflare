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
import { baseGlobals, sourceLimits } from '../engine/globals'
import type { BookSource, FetchPlan, RuleContext, SandboxHttp } from '../engine/types'
import { defaultHeaders, fetchDetailed, fetchText, UpstreamError } from '../lib/http'
import { parseLoginHeaders, parseSourceHeaders, requestHeadersFor } from './sourceHeaders'
import { applyOptionalSegments, findUrlJs } from './urlJs'
import { splitUrlAndOptions, type UrlOptions } from './urlOptions'

// 「地址 + 请求选项」的拆解与类型搬去了 `./urlOptions`：那是**纯函数**，
// 单独成模块才能被单测逐条钉住（这里会连带引入带 WASM 的沙箱，Node 里跑不起来）
export { splitUrlAndOptions, type UrlOptions }

/** 解析 `{{}}` 模板：里面是 JS 表达式，用沙箱求值 */
export async function resolveTemplate(template: string, ctx: RuleContext): Promise<string> {
    // 可选段先展开：第 1 页整段丢掉，段内的 `{{page}}` 也就没必要求值了
    const source = applyOptionalSegments(template, ctx.page ?? 1)
    const re = /\{\{([\s\S]*?)\}\}/g
    let out = ''
    let last = 0
    let match: RegExpExecArray | null

    while ((match = re.exec(source)) !== null) {
        out += source.slice(last, match.index)
        const expr = (match[1] ?? '').trim()
        if (expr === '') {
            out += ''
        } else {
            const value = await runInSandbox(
                expr,
                // 与规则求值共用同一份全局（含 source / jsLib / book / chapter）——
                // URL 模板里也会用 `Search_()`、`host()`、`book.name` 这些名字
                baseGlobals(ctx),
                { http: ctx.http, ...sourceLimits(ctx) },
            )
            out += sandboxResultToString(value)
        }
        last = re.lastIndex
    }
    out += source.slice(last)
    return out
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
        // 三层请求头（登录头 → 默认头 → 书源自己的 `header`，后面的盖前面的）：
        // 拆去 `./sourceHeaders` 那个纯函数模块，好让单测逐条钉住（见 test/login.test.ts）
        headers: requestHeadersFor(absolute, source),
        charset: 'auto',
        webView: false,
        // cookie 罐：书源开着 enabledCookieJar 时注册表才给它建（见 data/db.ts）。
        // 挂在这里就等于**所有**请求都走它 —— 链路请求与沙箱里的 java.ajax 都从这一个函数出。
        ...cookieJarOf(source),
    }
}

/** 把书源上的 cookie 罐挂进请求计划（没建罐子就什么都不加） */
function cookieJarOf(source: BookSource): Pick<FetchPlan, 'cookieJar' | 'persistCookies'> {
    if (!source.cookieJar) return {}
    return { cookieJar: source.cookieJar, persistCookies: source.persistCookies }
}

/**
 * 请求选项里的 `{{}}` 也要展开
 *
 * 这一条漏了很久：URL 段一直是展开的，选项段却没有。于是
 * `"body":"searchkey={{key}}&page={{page}}"` —— Legado「URL 参数详解」里 POST 的标准写法 ——
 * 会**原样把 `{{key}}` 这四个字符发给站点**。站点按关键字 `{{key}}` 去查，自然一条也没有，
 * 而引擎那侧是「跑通、0 条、不报错」：正好是「书源搜不到书」最常见的那个样子。
 *
 * 只处理字符串字段，而且**放在拆出选项之后**做：要做的是「让选项里的模板生效」，
 * 不是「把选项 JSON 整段丢进模板解析器」—— 关键字里出现一个 `,{` 就足以把选项切断。
 */
async function resolveOptionsTemplate(
    options: Partial<UrlOptions>,
    ctx: RuleContext,
): Promise<Partial<UrlOptions>> {
    let out = options

    if (out.body !== undefined && out.body.includes('{{')) {
        out = { ...out, body: await resolveTemplate(out.body, ctx) }
    }

    if (out.headers) {
        const headers = out.headers
        if (Object.keys(headers).some((name) => headers[name]!.includes('{{'))) {
            const resolved: Record<string, string> = {}
            for (const name of Object.keys(headers)) {
                resolved[name] = await resolveTemplate(headers[name]!, ctx)
            }
            out = { ...out, headers: resolved }
        }
    }

    return out
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
    // 模板里的 baseUrl 同样应该是书源地址，而不是请求来源
    const templateCtx: RuleContext = {
        ...ctx,
        baseUrl: source.bookSourceUrl,
        // `@js:` 里的 source 全局与 jsLib 都从这里来
        source,
        /**
         * 取网能力必须给进去：URL 字段里的脚本经常要**自己先发一次请求**
         * 才知道真正的地址在哪（米读小说要跟一次 302 拿新域名、小书本网要先把
         * 搜索页抓回来读 `form[action]`、夜寒书库要先过一遍 cookie）。
         * 缺了它脚本会报「java.ajax 不可用」—— 一个看起来与书源无关的错，
         * 而书源本身完全没问题。
         *
         * 这里用 `bookSourceUrl` 当脚本内取网的相对基准：书源写 searchUrl 时的
         * 参照物就是自己的站点地址。
         */
        http: ctx.http ?? sandboxHttp(source, source.bookSourceUrl),
    }

    const js = findUrlJs(rawUrl)
    let resolvedUrl: string
    let options: Partial<UrlOptions>

    if (js) {
        /**
         * 顺序很关键，尤其是**请求选项要在 JS 跑完之后再拆**：
         * 脚本本身就可能写出 `,{...}`（露西弗、少年梦阅读都是自己拼选项的），
         * 先拆选项会把脚本代码从中间切断，得到一个「合法但完全不是那个地址」的 URL。
         *
         * 反过来，脚本的输入 `result` 是**没展开过 `{{}}` 的原文**：
         * `全本同人小说网` 的脚本里就有 `String(result).replace("{{key}}", key)`，
         * 说明它拿到的确实是带模板的原样文本；而脚本的输出里还可能有 `{{page-1}}`
         * 这种表达式，所以展开要放在脚本之后再做一次。
         */
        const value = await runInSandbox(
            js.code,
            {
                ...baseGlobals(templateCtx),
                // URL 脚本的 `result` 是**没展开过 `{{}}` 的原文**（见上）
                result: js.prefix,
            },
            { http: templateCtx.http, ...sourceLimits(templateCtx) },
        )
        const produced = sandboxResultToString(value)
        const split = splitUrlAndOptions(await resolveTemplate(produced, templateCtx))
        resolvedUrl = split.url
        options = split.options
    } else {
        const split = splitUrlAndOptions(rawUrl)
        resolvedUrl = await resolveTemplate(split.url, templateCtx)
        // 选项里的 `{{}}` 同样要展开：POST 的关键字基本都写在 body 里（见上面的说明）
        options = await resolveOptionsTemplate(split.options, templateCtx)
    }

    const plan = planFromResolvedUrl(resolvedUrl, source, source.bookSourceUrl)

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
    // 媒体也要带登录头：不少站点的图片/音频是登录后才给取的（与页面请求同一套三层）
    const headers: Record<string, string> = {
        ...parseLoginHeaders(source.loginHeader),
        ...defaultHeaders(mediaUrl),
        ...fromSource,
    }

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
 * 请求次数与总时限的上限由沙箱统一控制（见 engine/js.ts）—— 但**总时限可以在这里调紧**：
 * 搜索那一趟自己的预算是 6 秒（见 `SEARCH_TIMEOUT_MS`），沙箱里的 `java.ajax` 就该在这 6 秒
 * 里跑完，而不是花掉沙箱默认的 8 秒（`budgetMs`）。
 */
export function sandboxHttp(
    source: BookSource,
    baseUrl: string,
    /**
     * 整次求值的总时限（毫秒）—— 就是 `SandboxHttp.totalTimeoutMs`
     *
     * 不传时用沙箱的默认值（8 秒）。调用方**有**自己的预算时应该传进来：
     * 搜索是 6 秒（一页几个源并发，整页的等待等于最慢的那个源）。
     */
    budgetMs?: number,
): SandboxHttp {
    /** 「地址（可能带 `,{...}` 选项）+ 调用方选项」→ 一份取网计划 */
    function buildPlan(
        url: string,
        options: {
            method?: string
            body?: string
            headers?: Record<string, string>
            timeoutMs?: number
        } = {},
    ): FetchPlan {
        const { url: rawTarget, options: urlOptions } = splitUrlAndOptions(url)
        const plan = planFromResolvedUrl(rawTarget, source, baseUrl)
        return {
            ...plan,
            method: (options.method ?? urlOptions.method ?? 'GET').toUpperCase(),
            body: options.body ?? urlOptions.body,
            /**
             * 这一次取网的时限由沙箱传下来（「整次求值还剩多少」）——
             * 不接住它的话，沙箱里一次 `java.ajax` 会用 20 秒的默认值，
             * 而整次求值的预算（默认 8 秒）只在**发请求之前**被看过一眼（见第六十轮）。
             */
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            // 书源里 `,{"charset":"gbk"}` 指的是**响应编码**（见 Legado 的「URL 参数详解」），
            // 这里以前漏掉了它，凡是走 java.ajax/java.post 的 GBK 站点都会拿到乱码
            charset: urlOptions.charset ?? plan.charset,
            headers: {
                ...plan.headers,
                ...(urlOptions.headers ?? {}),
                ...(options.headers ?? {}),
            },
        }
    }

    return {
        async fetchText(url, options = {}) {
            return fetchText(buildPlan(url, options))
        },
        // java.connect(...) 要「把响应原样交给脚本」，所以非 2xx 不抛错（见 fetchDetailed）
        async fetchResponse(url, options = {}) {
            return fetchDetailed(buildPlan(url, options))
        },
        // java.connect(url).raw().request().url()：只解析地址，不发请求
        resolveUrl(url) {
            try {
                const { url: rawTarget } = splitUrlAndOptions(String(url))
                if (rawTarget.trim() === '') return ''
                return planFromResolvedUrl(rawTarget, source, baseUrl).url
            } catch {
                return String(url)
            }
        },
        // 调用方给了预算就用它的（沙箱每次取网都会按「还剩多少」传 timeoutMs，见 engine/js.ts）
        ...(budgetMs !== undefined ? { totalTimeoutMs: budgetMs } : {}),
    }
}
