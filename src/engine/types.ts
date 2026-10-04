/**
 * 规则引擎的公共类型
 *
 * 这里刻意不引入 cheerio 的类型：引擎对外的接口只用字符串与字符串数组，
 * 这样上层（书源链路）不需要知道底层用的是 cheerio 还是别的解析器，
 * 后续要换解析实现也不会波及调用方。
 */

/** 规则求值的结果：可能是单值，也可能是列表（列表规则一定返回数组） */
export type RuleResult = string | string[]

/**
 * 一次请求内的沙箱会话
 *
 * 只在这里声明一个**结构化**的类型，而不是从 `js.ts` import：
 * `types.ts` 是引擎的公共类型层，被 `data/` 与 `legado/` 广泛引用，
 * 让它去依赖那个把 QuickJS 的 WASM 一起拉进来的模块，会把 WASM 传染给所有引用方。
 * 形状与 `js.ts` 的 `SandboxSession` 一致，因此结构上兼容。
 */
export interface SandboxSession {
    /** 本会话的 QuickJS 模块实例 */
    module: Promise<unknown>
    /** 本会话内的串行链 */
    queue: Promise<unknown>
    /**
     * 会话变量：`java.put` / `java.get(键)` / `@put:{…}` / `@get:{键}` **共用这一张表**
     *
     * 这里只声明形状（可选），实体在 `js.ts` 的 `SandboxSession` 上 ——
     * 引擎这一层要能读写它（见 `infoVars.ts`），但不该为此把 WASM 拉进来。
     */
    vars?: Record<string, string>
    /** 书的变量（`book.putVariable` / `getVariable`），同样只声明形状 */
    bookVars?: Record<string, string>
}

/**
 * 规则用了本引擎尚未实现的能力时抛这个，好让上层把「不支持」和「没匹配到」区分开
 *
 * 放在这里而不是 `analyze.ts`：`jsonpath.ts` 也要用它（不支持的过滤器同属「不支持」），
 * 而从 `jsonpath.ts` 反向引 `analyze.ts` 会成环。
 */
export class UnsupportedRuleError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'UnsupportedRuleError'
    }
}

/**
 * 当前这本书（Legado 的 `Book`）。`@js:` 里是 `book`
 *
 * 字段名与 Legado 一致。`origin`（书源名）由引擎从实际用的书源补，
 * 其余来自调用方 —— 引擎在求值 `ruleBookInfo` 时**正是在算** name/author，
 * 所以它自己并不知道这两个值，得由客户端把它已经知道的那份带上来。
 */
export interface BookContext {
    name?: string
    author?: string
    bookUrl?: string
    /** 书源名（Legado 的 `book.origin`） */
    origin?: string
    kind?: string
    intro?: string
    /** 这份书源变量（`source.setVariable` 存的那一份） */
    variable?: string
    [key: string]: string | undefined
}

/** 当前这一章（Legado 的 `Chapter`）。`@js:` 里是 `chapter` */
export interface ChapterContext {
    /** 章节名（`chapter.title` 是语料里用得最多的那个） */
    title?: string
    /** 章节在目录里的序号 */
    index?: number
    url?: string
    [key: string]: string | number | undefined
}

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

    /**
     * 这次请求里**要落库**的变量键（`@put:` 写、**别的请求**的 `@get:` 读的那些）
     *
     * 会话变量只活一次请求，而搜索 / 详情 / 目录 / 正文是四次 —— `ruleBookInfo` 里
     * `@put:{bid:…}`、`ruleToc.chapterUrl` 里 `@get:{bid}` 这种写法（线上 8 处）就断了。
     * 由调用方按源算好放进来（见 `infoVars.ts` 的 `crossRequestInfoKeys`），
     * **只落这几个键**：全量落会把目录那种逐章求值的写法变成几百次 D1 写。
     */
    infoVarCrossKeys?: ReadonlySet<string>

    /**
     * 这次请求已经落过库的变量键（内部记账，调用方不用管）
     *
     * 只放在 `RuleContext` 上、不放会话表里：会话表会被整份注入沙箱的 `__sourceVars`
     * （见 `globals.ts`），把记账信息混进去会让脚本看见一堆莫名的键。
     */
    infoVarSaved?: Set<string>

    /**
     * 当前这本书。`@js:` 规则里以 `book` 暴露（`book.name` / `book.author` / …）
     *
     * 线上用得很多：`book.name` 54 处 / 39 源、`book.author` 27 处 / 18 源、
     * `book.bookUrl` 32 处 / 16 源、`book.origin` 13 处 / 10 源、`book.intro` 11 处 / 8 源。
     * 而 `book` 在 `baseGlobals` 里以前是 `ctx.book ?? {}` —— 也就是说**没人给它赋过值**，
     * 这些字段一直是 `undefined`：不报错，但 `'【' + book.name + '】'` 会拼出「【undefined】」。
     * 这类静默错值比抛异常难查得多。
     *
     * 由**调用方**（`index.ts` 的路由）从客户端带上来的 `book` 参数填 —— 取书接口是无状态的，
     * 引擎自己记不住「这一章属于哪本书」。
     */
    book?: BookContext

    /** 当前这一章（`chapter.title` 32 处 / 30 源、`chapter.index` 4 处 / 4 源） */
    chapter?: ChapterContext

    /**
     * 这本书已存的变量（`book.getVariable` 的初值，由上层从库里取）
     *
     * 与 `RuleContext.vars`（`java.put` / `java.get(k)` 那张按请求活的表）不是一回事，
     * 与 `BookSource.variable` 也不是一回事 —— 三者的作用域分别是「这本书 / 这次请求 / 这个源」。
     */
    bookVars?: Record<string, string>

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

    /**
     * 当前书源。
     *
     * 用途是给 `@js:` 规则里的 `source` 全局提供内容 —— 线上用它的规则非常多
     * （`source.getKey()` 413 次、`source.bookSourceUrl` 133 次、`source.getVariable()`
     * 126 次），没有它这些规则一律 ReferenceError，书源表现成「脚本执行出错」。
     *
     * 也顺带提供 `jsLib`（书源自带的 JS 库，35 条源在用）—— 那些源里的
     * `GetUL()`、`host()`、`QM_HEADERS` 之类**全是 jsLib 里定义的函数**，
     * 不先执行 jsLib，规则里的这些名字一个都不存在。
     */
    source?: BookSource

    /**
     * `source.setVariable(整串)` 的落库路径，由**上层注入**（只有它知道 db 与书源 id）
     *
     * 引擎自己不该碰数据库：这一层的职责是「把书源的意图表达清楚」，落哪儿是应用层的选择。
     * 不注入时 `setVariable` 只在本次请求里生效（与 `java.put` 一样），
     * 书源表现成「设置成功了，下次进来又没了」—— 所以真实调用路径都从 `index.ts` 注入。
     *
     * 调用方**应当等它写完**再返回响应：Worker 的响应一返回就掐掉还在飞的 promise。
     */
    persistSourceVariable?: (value: string) => void | Promise<void>

    /**
     * `book.putVariable(名字, 值)` / `chapter.putVariable(...)` 的落库路径
     *
     * 与书源变量是**两份不同的东西**，别合并：
     *   - 书源变量（`source.setVariable(整串)`）是一段**自由字符串**，作用域是「这个源」
     *   - 书的变量（`book.getVariable("custom")`）是**带名字的 map**，作用域是「这本书」
     *
     * 为什么书要留着自己那份：📂掌阅书城 / 📂就去看网 / 📂言情小说 的正文规则会
     * **探一次规则形状**（试到第 i 个能解析出来），然后 `book.putVariable("序", i)`
     * 记下来 —— 下一章再来时先读 `序`，就不必再探一遍。一章一次请求，所以它必须跨请求活着，
     * 否则每章都重探一次（结果仍然对，只是白花 CPU 与上游请求）。
     *
     * 不注入时只活在本次请求里 —— 对上面那种「探测结果」来说是可接受的降级，
     * 对 ⚡📂穿越小说 / ⚡📂小小阅读 那种**用户手填**的 `custom` 来说则本来就该是空串。
     */
    persistBookVariable?: (name: string, value: string) => void | Promise<void>

    /**
     * 发现页的筛选状态（Legado 的 `infoMap`）
     *
     * 书源的 exploreUrl 脚本会用 `infoMap["频道"] || "分类"` 读用户在筛选器里的选择。
     * 我们没有那套交互界面，所以传空对象 —— 表达式会落到书源自己写的默认值上，
     * 分类照常出得来（这正是 7 条源「缺少 infoMap」的表现）。
     */
    infoMap?: Record<string, string>

    /**
     * 本次请求的沙箱会话
     *
     * 一次请求内所有沙箱求值共用它：模块实例不能并发，跨请求又不能互相等
     * （Workers 禁止跨请求的 promise 链），所以只有「按请求隔离 + 请求内串行」这一条路。
     * 由路由层在每个请求入口创建一次，见 `engine/js.ts` 的 `SandboxSession`。
     */
    sandbox?: SandboxSession
}

/** 沙箱可用的取网能力 */
export interface SandboxHttp {
    /** 取回文本；失败时抛错，错误信息会带回给脚本 */
    fetchText(
        url: string,
        options?: { method?: string; body?: string; headers?: Record<string, string> },
    ): Promise<string>
    /**
     * 取回**响应本身**（状态码 + 响应头 + 正文）；HTTP 非 2xx **不抛错**
     *
     * `java.connect(...)` 要的是这一份：书源拿它的 `code()` / `raw().headers(...)` 做判断，
     * 「不是 2xx 就抛错」会把判断变成异常。可选 —— 没接取的平台走不到这条路。
     */
    fetchResponse?(
        url: string,
        options?: { method?: string; body?: string; headers?: Record<string, string> },
    ): Promise<{
        url: string
        status: number
        headers: Record<string, string[]>
        body: string
    }>
    /**
     * 把一个（可能相对的、可能带 `,{...}` 请求选项的）地址解析成**绝对地址**
     *
     * 同步，不做网络请求。`java.connect(url).raw().request().url()` 要的就是它 ——
     * Legado 的 `AnalyzeUrl` 在发请求**之前**就把地址定下来了，所以这里不该为了拿一个
     * 地址去多打一次网络。
     */
    resolveUrl?(url: string): string
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

    /**
     * 书源变量（Legado 的 `BookSource.variable`）
     *
     * 书源自己的**一张便签**：`source.setVariable(整串)` 写、`source.getVariable()` 读，
     * 内容是一段自由字符串（书源往里塞 JSON：备用域名、开关、设备号、线路序号）。
     * 落库在 `sources.variable` 列上，起点是空串 —— 全量 816 条源里没有一条自带它。
     *
     * 与 `RuleContext.vars`（`java.put` / `java.get(k)` 那张**按请求**活的表）是
     * 两回事：这一条要跨请求活着，那一张只活一次请求。
     */
    variable?: string

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
        /**
         * **初始化规则**：求值一次、**只取其副作用**（`@put:{…}` / 脚本里的 `java.put`），
         * 其它字段再用 `@get:{键}` 读回来。
         *
         * 线上 116 处 / 109 个源，其中顶格 `@put:{…}` 23 处、`<js>` 脚本 29 处、
         * `@js:` 脚本 18 处。典型形状（⚡📂万象书城 / 📂夜伴书屋）：
         *
         *   init:   @put:{n:"[property$=book_name]@content", a:"[property$=author]@content", …}
         *   name:   @get:{n}
         *   author: @get:{a}
         *
         * 另有 42 处写的是选择器 / 路径（`$.data`、`data.book`），当「**换掉求值的根**」用 ——
         * 那要求 JSONPath 与裸字段名都能相对某个子树求值，是另一件事（见 README 的待办）。
         */
        init?: string
        name?: string
        author?: string
        kind?: string
        lastChapter?: string
        intro?: string
        coverUrl?: string
        tocUrl?: string
        wordCount?: string
        /**
         * 下载地址。**只有 bookSourceType=3（文件源）会用到**，
         * 文本/图片/音频源的正文走 ruleContent，这个字段留空。
         */
        downloadUrls?: string
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
        /**
         * 媒体地址嗅探正则。音频源常把章节地址标成 `{webView:true}`，
         * 再由 App 拦截 WebView 流量、用这条正则从里面挑出 mp3。
         * 本引擎没有 WebView，因此这条规则**只会被识别、不会被使用** ——
         * 遇到时明确报错，而不是把整页 HTML 当成音频地址返回。
         */
        sourceRegex?: string
    }

    /** 书源级请求头 */
    header?: string

    /**
     * 书源自带的 **JS 库**
     *
     * Legado 在执行这个书源的任何 `@js:` / `<js>` 规则之前，会先把这段脚本跑一遍，
     * 于是它里面声明的函数与常量对整条书源都可见。线上 35 条带发现页的书源用了它，
     * 而且**大部分「脚本缺少 XXX」其实缺的就是这里定义的名字**
     * （霹雳书屋的 `host()`、爱丽丝书屋的 `GetUL()`、禁漫天堂的 `jmg()`）。
     *
     * 它是不可信代码，照样进沙箱执行 —— 但只在求值规则之前跑一次，不额外增加取网权限。
     */
    jsLib?: string

    /**
     * 登录地址 / 登录界面
     *
     * 本引擎**没有登录能力**：需要登录的书源只能读到游客可见的部分。
     * 字段留着是为了让 `source.loginUrl` 有值可取，而不是 undefined ——
     * 有些脚本会先判断它是否存在，undefined 会让整段逻辑走错分支。
     */
    loginUrl?: string
    loginUi?: string

    /** 发现页的可交互筛选器定义（`infoMap` 的初值来源） */
    exploreScreen?: string

    /**
     * 发现页（「探索」）地址
     *
     * 三种写法都要认，线上三种都有：
     *   - 一串 `标题::地址`，按行排（最老的写法）
     *   - 整条 `@js:` / `<js>`：脚本返回分类数组，或返回上面那种文本
     *   - 一个普通地址（含 `{{page}}`）：整站就一个分类
     */
    exploreUrl?: string

    /** 发现页的书目规则，字段与 ruleSearch 同形，多一个 nextPageUrl */
    ruleExplore?: {
        bookList?: string
        name?: string
        author?: string
        kind?: string
        wordCount?: string
        lastChapter?: string
        intro?: string
        coverUrl?: string
        bookUrl?: string
        nextPageUrl?: string
    }

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

/**
 * 书源类型
 *
 * 取自 Legado 的 BookSourceType。类型决定「正文」到底是什么东西：
 * 文本源取回段落文字，图片源取回一串图片地址，音频源取回一条直链，
 * 文件源则根本不走正文规则、只给下载地址。用同一套逻辑处理这四种，
 * 结果必然是其中三种都读不了。
 */
export const SOURCE_TYPE = {
    text: 0,
    audio: 1,
    image: 2,
    file: 3,
} as const

/** 一条媒体地址（图片/音频/文件），name 只在文件源里有意义 */
export interface MediaLink {
    url: string
    name?: string
}

/**
 * 一章的正文，按书源类型分化
 *
 * 用可辨识联合而不是「一个 content 字符串 + 一个 type 字段」：
 * 后者允许出现「type 说这是图片、content 里却是普通文字」这种非法组合，
 * 而非法组合在读取端只会表现为「显示得很奇怪」，很难往回追。
 */
export type ChapterContent =
    | { kind: 'text'; text: string }
    | { kind: 'images'; images: MediaLink[] }
    | { kind: 'audio'; audio: MediaLink }
    | { kind: 'downloads'; downloads: MediaLink[] }

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
    /**
     * 这次请求的超时（毫秒），不写就用取网层的默认值
     *
     * 之所以放在计划里而不是写死：**搜索要单独收紧**。搜索是一页几个源并发跑的，
     * 整页的等待取决于最慢的那个源，所以它的超时该比「读一章正文」短得多。
     */
    timeoutMs?: number
}
