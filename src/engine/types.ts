/**
 * 规则引擎的公共类型
 *
 * 这里刻意不引入 cheerio 的类型：引擎对外的接口只用字符串与字符串数组，
 * 这样上层（书源链路）不需要知道底层用的是 cheerio 还是别的解析器，
 * 后续要换解析实现也不会波及调用方。
 */

/** 规则求值的结果：可能是单值，也可能是列表（列表规则一定返回数组） */
export type RuleResult = string | string[]

/** 求值上下文，对应 Legado 在 js 里暴露的那些全局变量 */
export interface RuleContext {
    /**
     * 当前页面的地址。
     *
     * 三个用途：拼接规则里出现的相对路径；作为默认 Referer
     * —— 不少书源站点会校验 Referer，不带就返回错误页；
     * 以及在 `@js:` 里作为 `baseUrl` 暴露给脚本。
     */
    baseUrl: string

    /** 上一步的结果。`@js:` 规则里以 `result` 暴露 */
    result?: unknown

    /** 当前源码。`@js:` 规则里以 `src` 暴露 */
    src?: string

    /** `@put` / `@get` 的变量表，跨规则传递 */
    vars?: Record<string, string>

    /** 书籍信息，供 `{{book.xxx}}` 这类模板引用 */
    book?: Record<string, string>

    /** 当前页码，模板 `{{page}}` 用 */
    page?: number

    /** 搜索关键字，模板 `{{key}}` 用 */
    key?: string

    /**
     * 沙箱里 `java.ajax` 等函数的取网能力，由**上层注入**。
     *
     * 引擎本身不碰网络也不决定请求策略（请求头、字符集、超时、限流都属于应用层的选择），
     * 这里只声明一个能力接口。不注入时 `java.ajax` 会明确报错，
     * 而不是悄悄返回空字符串 —— 后者会让书源表现成「取不到正文」。
     */
    http?: SandboxHttp
}

/** 沙箱可用的取网能力 */
export interface SandboxHttp {
    /** 取回文本；失败时抛错，错误信息会带回给脚本 */
    fetchText(
        url: string,
        options?: { method?: string; body?: string; headers?: Record<string, string> },
    ): Promise<string>
    /** 单次规则求值里最多允许几次网络请求，防止脚本把一只 Worker 拖死 */
    maxCalls?: number
    /** 整次求值的总时限（毫秒），超出后连网络请求一起中止 */
    totalTimeoutMs?: number
}

/** 取值步骤的名称。除这些固定项外，任何其它名字都当作取同名属性处理 */
export const EXTRACT_KINDS = [
    'text',
    'textNodes',
    'ownText',
    'html',
    'outerHtml',
    'all',
    'href',
    'src',
] as const

export type ExtractKind = (typeof EXTRACT_KINDS)[number]

/** 一个书源里所有规则的集合，字段名与 Legado 书源 JSON 一一对应 */
export interface BookSource {
    bookSourceName: string
    bookSourceUrl: string
    bookSourceGroup?: string
    bookSourceType?: number
    bookSourceComment?: string
    enabled?: boolean

    /** 搜索地址模板，含 {{key}} / {{page}} */
    searchUrl?: string
    /** 搜索请求选项：charset / headers / method / body */
    searchUrlOptions?: string

    ruleSearch?: {
        bookList?: string
        name?: string
        author?: string
        kind?: string
        wordCount?: string
        lastChapter?: string
        intro?: string
        coverUrl?: string
        bookUrl?: string
    }

    ruleBookInfo?: {
        name?: string
        author?: string
        kind?: string
        lastChapter?: string
        intro?: string
        coverUrl?: string
        tocUrl?: string
        wordCount?: string
    }

    ruleToc?: {
        chapterList?: string
        chapterName?: string
        chapterUrl?: string
        nextTocUrl?: string
    }

    ruleContent?: {
        content?: string
        nextContentUrl?: string
        replaceRegex?: string
    }

    /** 书源级请求头 */
    header?: string

    /** 书籍详情页 URL 的识别正则 */
    bookUrlPattern?: string
}

/** 搜索或目录里的一条书籍/章节 */
export interface SearchBook {
    name: string
    author: string
    bookUrl: string
    coverUrl?: string
    intro?: string
    kind?: string
    lastChapter?: string
    wordCount?: string
    /** 来源书源名，聚合搜索时用来区分 */
    sourceName: string
    sourceUrl: string
}

export interface Chapter {
    name: string
    url: string
}

/** 一次 HTTP 请求的计划，由 URL 规则和选项解析而来 */
export interface FetchPlan {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
    /** 非 utf-8 的站点很常见（GBK/GB2312），必须按它解码 */
    charset: string
    /** 需要 WebView 渲染的站点，本引擎不支持，会明确报错而不是静默返回空 */
    webView: boolean
}
