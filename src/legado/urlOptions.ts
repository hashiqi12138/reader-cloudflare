/**
 * 书源 URL 的「地址 + 请求选项」紧凑写法
 *
 *   https://www.example.com/search?q={{key}}&p={{page}},{"charset":"gbk","method":"POST","body":"..."}
 *
 * 逗号前是地址、逗号后的 JSON 是请求选项。拆解看着简单，但它是**静默出错**的典型位置：
 * 拆错之后 `new URL()` 会把选项段百分号编码进路径，得到一个能请求、但请求错地方的地址
 * （症状是「搜不到书」而不是报错）。所以单独成模块，好把它按形态逐条钉住。
 */

import { parseLooseJson } from '../lib/json'
import { UpstreamError } from '../lib/http'

/** 书源 URL 尾部可带的请求选项 */
export interface UrlOptions {
    method: string
    charset: string
    headers: Record<string, string>
    /**
     * 请求体。书源可以写成**字符串**（`"searchkey={{key}}&page={{page}}"`），
     * 也可以写成**JSON 对象**（`"body": {"bookId": 123}`）—— 后者在
     * `splitUrlAndOptions` 里就被序列化成字符串，所以走到下游的**永远是字符串**。
     */
    body?: string
    /** 需要 WebView 渲染的站点本引擎不支持，必须显式拒绝 */
    webView: boolean
}

/** 请求头里有没有 Content-Type（大小写不敏感） */
function hasContentType(headers: Record<string, string> | undefined): boolean {
    return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'content-type')
}

/**
 * 把选项里的 `body` 规整成字符串
 *
 * 书源把 `body` 写成 **JSON 对象**是 Legado 支持的写法（`⚡📂新小书亭` 四个字段、
 * `📂全本小说` 的目录都是它），这时要按 JSON 发出去。不在这一层规整的话，对象会一路传到
 * `resolveOptionsTemplate` —— 那里写着 `out.body.includes('{{')`，整条源当场报
 * `out.body.includes is not a function`，一个指向引擎内部、与书源毫不相干的错。
 *
 * 顺便把 Content-Type 定成 `application/json`：字符串 body 的默认是表单
 * （见 `lib/http.ts` 的 requestHeaders），而 JSON 体配表单类型，PHP 之外的服务端多半不认。
 * 书源自己声明了 Content-Type 就不动它。
 *
 * 数字 / 布尔这种「不是字符串也不是对象」的写法同样按字面发出去，不留对象在下面。
 */
function normalizeBody(options: Partial<UrlOptions>): Partial<UrlOptions> {
    const body: unknown = options.body
    // 字符串照原样；`null` 与没写都当「没有请求体」—— 留着 `null` 会在下游
    // `body.includes(…)` 上炸，而它表达的意思本来就只是「没有体」
    if (typeof body === 'string' || body === undefined) return options
    if (body === null) return { ...options, body: undefined }

    const serialized = typeof body === 'object' ? JSON.stringify(body) : String(body)
    const headers = options.headers
    const nextHeaders =
        headers !== null && typeof headers === 'object' ? headers : ({} as Record<string, string>)

    return {
        ...options,
        body: serialized,
        headers: hasContentType(nextHeaders)
            ? nextHeaders
            : { ...nextHeaders, 'Content-Type': 'application/json' },
    }
}

/**
 * 拆出 URL 与请求选项
 *
 * 用第一个 `,{` 作为分界：真正的 URL 里出现 `,{` 是极罕见的，
 * 而选项段一定以 `{` 开头。解析失败时**抛错而不是降级**——
 * 把选项当 URL 用会得到一个看起来正常、实际请求错地方的 URL，那种错最难查。
 *
 * 逗号与 `{` 之间**允许空白**：书源里 `search.php, {` 这种写法有 407 处、31 个源
 * （⚡📂书趣阁、🏷书旗小说、⚡📂点众阅读 ……）。不认这些空白的话，整段选项会被当成
 * URL 的一部分，`new URL()` 再把花括号百分号编码进路径 —— 最后发出的地址长这样：
 *
 *   http://wap.xshuquge.net/search.php,%20%7B%22method%22%3A%20%22post%22…
 *
 * 它**不报错**，只是请求了一个不存在的页面（404 或者首页），症状是「搜不到书」。
 * Legado 那边是「逗号之后整段 trim 再 JSON.parse」，同样容得下空白。
 *
 * 有一个必须排除的例外：可选段 `<,{{page}}>` 里天然含有 `,`。
 * 不排除的话它会被当成选项段的开头，URL 被切成 `<` + `{{page}}>`，
 * 报出来的是「请求选项不是合法 JSON」—— 一个指向错误方向的错误信息。
 * 所以只认**前面不是 `<`** 的那个 `,`。
 *
 * 解析出来的 `body` 一律规整成字符串（见 `normalizeBody`）—— 下游只认字符串。
 */
export function splitUrlAndOptions(raw: string): { url: string; options: Partial<UrlOptions> } {
    const trimmed = raw.trim()
    const match = /(?<!<),\s*\{/.exec(trimmed)
    if (!match) return { url: trimmed, options: {} }

    const index = match.index
    const url = trimmed.slice(0, index).trim()
    const jsonText = trimmed.slice(index + 1).trim()
    try {
        const parsed = parseLooseJson<Partial<UrlOptions>>(jsonText)
        return { url, options: normalizeBody(parsed) }
    } catch {
        throw new UpstreamError(
            `书源 URL 的请求选项不是合法 JSON，无法确定该请求哪里：${jsonText.slice(0, 80)}`,
        )
    }
}
