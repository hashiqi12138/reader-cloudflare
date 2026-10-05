/**
 * 书源的四步链路：搜索 → 详情 → 目录 → 正文
 *
 * 每一步都是「拼 URL → 取回源码 → 按规则解析」这三拍的组合，
 * 差别只在用哪几条规则、以及上一步的结果怎么传下去。
 */

import {
    analyzeSelections,
    analyzeString,
    analyzeStrings,
    resolveInitSelection,
    rootSelection,
    type Selection,
} from '../engine/analyze'
import { ruleHasJs } from '../engine/directives'
import { sourceLimits } from '../engine/globals'
import { htmlToText, looksLikeHtml } from '../engine/htmlText'
import { closeSandboxBatch, openSandboxBatch, type SandboxSession } from '../engine/js'
import type { BookSource, Chapter, RuleContext, SearchBook } from '../engine/types'
import { SEARCH_TIMEOUT_MS, UpstreamError, fetchText } from '../lib/http'
import { tocFlag, tocText } from './chapterFields'
import { buildPlan, sandboxHttp } from './source'
import { crossRequestInfoKeys } from '../engine/infoVars'

/** 把规则取到的地址补全成绝对地址（书源里相对路径很常见） */
export function resolveUrl(value: string, base: string): string {
    const v = value.trim()
    if (!v) return ''
    try {
        return new URL(v, base).href
    } catch {
        return v
    }
}

/**
 * 地址尾部 `,{...}` 请求选项的起点；`(?<!<)` 是给 URL 里的可选段 `<,{{page}}>` 让路
 *
 * 判据与 `urlOptions.ts` 的 `splitUrlAndOptions` **必须一致** —— 两处认的不是同一个
 * `,` 时，一边拆开、另一边又拼回去，仍然是坏的。
 */
const ADDRESS_OPTIONS_AT = /(?<!<),\s*\{/

/** 地址字段里那一段请求选项（原样，含前导 `{`）；没有就是 '' */
function optionsPartOf(value: string): { url: string; options: string } {
    const match = ADDRESS_OPTIONS_AT.exec(value)
    if (!match) return { url: value.trim(), options: '' }
    return {
        url: value.slice(0, match.index).trim(),
        options: value.slice(match.index + 1).trim(),
    }
}

/**
 * 这条地址是不是带着请求选项（`,{...}`）
 *
 * 判据与 `optionsPartOf` / `splitUrlAndOptions` 同一条，三处认的必须是同一个 `,`。
 * 封面据它判断「要不要走代取」的一半理由（另一半见 `needsCoverProxy`）。
 */
export function hasAddressOptions(value: string): boolean {
    return ADDRESS_OPTIONS_AT.test(value)
}

/**
 * 一张封面要不要走 `/api/media` 代取
 *
 * 两种情况都会让浏览器**根本取不到**这张图：
 *
 *   1. **带请求选项**（书源给它写了 `Referer` / `User-Agent`）—— 浏览器既不带那个头、
 *      也不认 `,{...}` 这种写法（见 `resolveCoverAddress`；线上 8 处 / 4 源）
 *   2. **`http:` 地址** —— 本站是 https，http 子资源会被当成「混合内容」拦掉，
 *      浏览器连请求都不发出去（第四十八轮抽样：真实返回的封面里 **86%** 是 http）
 *
 * 其余（`https:` 且不带选项）浏览器直接就能加载，不为它多花一次签名与子请求 ——
 * 代取对每张封面都是「一次签名 + 一次子请求 + 一次读源」，代价要花在真的取不到的那些上。
 *
 * 为什么不干脆把 `http` 改写成 `https`（那样一次请求都不用花）：**改不动**。
 * 实测抽样里那些站点（`www.8xiaoshuo.net` 一族）根本没有 https，改写之后一律
 * `fetch failed` —— 老小说站大量是这种。
 */
export function needsCoverProxy(coverUrl: string): boolean {
    return hasAddressOptions(coverUrl) || /^http:\/\//i.test(coverUrl)
}

/**
 * 地址类字段：**先拆请求选项，再补全地址，然后把选项原样接回去**
 *
 * 顺序不能反，这是这一段的全部要点。`new URL()` 会把 `{` `"` 百分号编码，选项段一旦
 * 被编码，`splitUrlAndOptions` 就再也认不出那个 `,{` —— 选项于是变成地址的一部分被请求：
 *
 *   https://guiwb.nnmh.info/cover/1.jpg,%7B%22headers%22:%7B%22Referer%22:…%7D%7D
 *
 * 它**不报错**，只是请求了一个不存在的路径（404），症状是「搜不到书 / 目录空 / 封面挂」。
 * 线上这个形状共 **33 处 / 20 个源**：🎭🎬露西弗同人站 的目录与章节（`{"method":"POST"}`）、
 * 🏷纵横中文 的书籍地址、🔞书耽 的三个字段（`{"headers":…}`）、⚡📂丁丁小说 的搜索地址。
 *
 * 「原样接回去」而不是 `JSON.stringify`：选项里可能有 `{{}}` 模板（要在 `buildPlan`
 * 那一层展开），也可能有书源自己的写法。这里只负责**不破坏它**，解析与校验统一留在
 * `splitUrlAndOptions` —— 那才是唯一该判「选项合法不合法」的地方。
 */
export function resolveAddress(value: string, base: string): string {
    const { url, options } = optionsPartOf(value)
    const resolved = resolveUrl(url, base)
    return options === '' ? resolved : `${resolved},${options}`
}

/**
 * 封面地址：**保留**请求选项，由 `/api/media` 代取（第四十七轮改的）
 *
 * 第四十三轮这里把选项**丢掉**了，理由是封面由浏览器 `<img src>` 直接加载，
 * 浏览器既不带书源指定的 `Referer`、也不认 `,{...}` 这种写法。丢掉之后至少
 * 「是一个合法图片地址」—— 但对**防盗链**的封面没有用：地址是对的，图仍然 403。
 *
 * 现在改成与 `resolveAddress` 一样**保留**选项，因为真正的取图交给 `/api/media`
 * 代取 —— 那份选项里的 `Referer` 正是书源写它的目的。前端拿到的
 * `coverProxyUrl`（见 `index.ts` 的 `withCoverProxy`）优先于 `coverUrl`；
 * 不带选项的封面不签发代取地址，浏览器直接加载原图即可。
 * （线上带选项的封面共 8 处 / 4 源：📂品书斋、🎨楠楠漫画、🎨漫畫狗网、📷🔞美女图片网。）
 *
 * 所以这个函数保留下来只为**写明这一处的意图**（封面 vs 链路地址），
 * 行为与 `resolveAddress` 一致。
 */
export function resolveCoverAddress(value: string, base: string): string {
    return resolveAddress(value, base)
}

/**
 * 取**单值**，用于地址类字段
 *
 * `analyzeString` 会把所有匹配到的值用换行拼起来 —— 正文需要这个行为（多个段落要合起来），
 * 但地址字段拼起来就不再是地址了。更糟的是 URL 解析器会把换行当非法字符**直接删掉**，
 * 于是得到一个看不出问题的字符串：真源里踩到过，搜索结果一条里有三个 `<a>`，
 * 书籍地址变成 `https://m.jhsssd.com/77706//77706//77706/65031092.html`，
 * 而它既不报错、又永远打不开 —— 典型的静默错数据。
 *
 * 地址只可能是一个，所以这里取第一个非空值。
 *
 * 而且要取到「第一个非空**行**」而不只是「第一个非空值」：值本身可能就是多行的 ——
 * `@js:` 返回一个地址数组时，沙箱结果会按换行拼起来。整段拿去解析地址的话，
 * 换行会被 URL 解析器当成非法字符删掉，得到几条地址首尾相接的串：
 * 喜马拉雅的 nextTocUrl 正是这样拼出 9 条地址，然后请求一个必然 404 的怪地址。
 */
/** 地址类字段：一列候选里取**第一条地址**，拼错一个字符就整条不可用，不能取整串 */
export async function analyzeAddress(
    item: Selection,
    rule: string,
    ctx: RuleContext,
): Promise<string> {
    if (rule.trim() === '') return ''
    const values = await analyzeStrings(item, rule, ctx)
    for (const value of values) {
        const line = firstAddressOf(value)
        if (line) return line
    }
    return ''
}

/**
 * 从 `open` 处的 `{` 找到配对的那个 `}`（跳过 JSON 字符串里的括号）；找不到返回 -1
 *
 * 只做括号配平，不解析 JSON —— 这里要的只是「选项块到哪儿结束」，
 * 合法性仍然只由 `splitUrlAndOptions` 一个地方判。
 */
function matchingBrace(text: string, open: number): number {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = open; i < text.length; i += 1) {
        const ch = text[i]!
        if (inString) {
            if (escaped) escaped = false
            else if (ch === '\\') escaped = true
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') depth += 1
        else if (ch === '}') {
            depth -= 1
            if (depth === 0) return i
        }
    }
    return -1
}

/**
 * 一条规则值里的**第一条地址**
 *
 * 规则值可能是多行的，而两种多行要区别对待：
 *
 *   1. **多个并列候选**：沙箱把数组按 `\n` 拼起来 —— 喜马拉雅的 `nextTocUrl` 一次
 *      拼出 9 条地址。取第一条。
 *   2. **一条地址自带请求选项，而选项块是排版过的 JSON**：
 *
 *        http://app.1001p.com/api/book/bookDetail,{
 *          "body": { "bookId": 12345 },
 *          "method": "POST"
 *        }
 *
 *      （线上 `⚡📂新小书亭` 的 `bookUrl` / `tocUrl` / `chapterUrl`、`⚡📂米读小说`
 *      的 `bookUrl` 都是这么写的）—— 这是一个整体，按行切只会剩半截 `…getDetail,{`，
 *      下游报「书源 URL 的请求选项不是合法 JSON」，一个把方向指向书源、其实是我们的错。
 *
 * 所以有选项块时按**配平的花括号**取到它结束；没有选项块时维持「第一个非空行」。
 */
function firstAddressOf(value: string): string | null {
    const text = value.replace(/\r\n?/g, '\n').trim()
    if (text === '') return null

    const match = ADDRESS_OPTIONS_AT.exec(text)
    if (match) {
        const open = match.index + match[0].length - 1
        const close = matchingBrace(text, open)
        if (close >= 0) {
            const whole = text.slice(0, close + 1).trim()
            if (whole !== '') return whole
        }
    }

    const line = text
        .split('\n')
        .map((part) => part.trim())
        .find((part) => part !== '')
    return line ?? null
}

/**
 * 一条被「容错」掉的字段错误
 *
 * 展示用字段坏了不该连累链路，但也**绝不能悄悄咽掉** —— 那正是这个项目最反对的
 * 「静默」。所以吞下来的错误要原样带出去（`/api/search` 每个源一个 `warnings`、
 * `/api/book` 一个 `warnings`），界面可以据此提示「这个源的封面规则坏了」。
 */
export interface FieldWarning {
    field: string
    message: string
}

/**
 * 求值一个**展示用**字段：规则坏了只让这个字段为空，不连累整条链路
 *
 * 依据是第四十五轮抽样体检里的一条：`🎨拷贝漫画` 的 `coverUrl` 写着一个多了一个 `)`
 * 的 XPath（`(.//p[@class="mh-cover tip"])/@style`），求值抛错 —— 而这一抛会让**整条搜索**
 * 失败（`ok=false`）。用户连一本书都搜不到，尽管书名、作者、书籍地址、目录、正文全都好好的。
 *
 * 取舍与 `evalTemplate` 那条既有先例同源：**一个展示用的标签取不到，不该导致整本书打不开**
 * （见 README「字段规则里的 `{{...}}` 模板」）。这是第四十五轮对「字段出错就整个源失败」
 * 那条老规矩的**收窄**，不是取消：
 *
 *   - `bookUrl` / `tocUrl` / `chapterUrl` / `nextTocUrl` / `nextContentUrl` 是链路的必经之处，
 *     坏了必须响亮地报出来（吞掉就退化成「搜不到书、全程不报错」）
 *   - 展示用字段只是留空，但原因要进 `warnings` —— 诊断价值一点没丢
 */
async function tolerantField(
    field: string,
    evaluate: () => Promise<string>,
    warnings: FieldWarning[],
): Promise<string> {
    try {
        return await evaluate()
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // 同一个字段在 N 本书上会抛同样的错，只留第一条
        if (!warnings.some((w) => w.field === field)) warnings.push({ field, message })
        return ''
    }
}

/** 正文清洗：规整空白、去掉空行，但不动段落本身 */
export function normalizeContent(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[\t\u00a0\u3000]+/g, ' ').trim())
        .filter((line) => line !== '')
        .join('\n')
}

/**
 * 搜索：返回该书源上命中的书籍列表
 *
 * `warnings` 是**收集器**：展示用字段的规则坏掉时，这里既让那一格留空、又把原因带出去
 * （见 `tolerantField`）。调用方自己给一个数组，函数往里塞。
 */
export async function searchBooks(
    source: BookSource,
    keyword: string,
    ctx: RuleContext,
    warnings: FieldWarning[] = [],
): Promise<SearchBook[]> {
    const rule = source.ruleSearch
    if (!source.searchUrl) throw new UpstreamError('书源未配置搜索地址（searchUrl）')
    if (!rule?.bookList) throw new UpstreamError('书源未配置书籍列表规则（ruleSearch.bookList）')

    // 让 `@js:` 里的 `source` 全局与 jsLib 生效（见 engine/globals.ts）
    ctx.source ??= source

    const page = ctx.page ?? 1
    /**
     * 搜索地址（`searchUrl`）本身就是一段模板，里面也可能有 `java.ajax` ——
     * 比如 📂新书本网 要先把首页抓回来读 `form[action]` 才知道真正的搜索页在哪。
     * 这一层也得按搜索的预算走：`buildPlan` 只在 `ctx.http` 缺位时才自己造一个
     * （那是**沙箱默认的 8 秒**），所以这里必须把预算先给它 —— 否则整页依旧要等 8 秒
     * （第六十轮体检里 📂新书本网 报的正是 `请求超时（>8000ms）`）。
     */
    const pageBudget = sandboxHttp(source, source.bookSourceUrl, SEARCH_TIMEOUT_MS)
    const plan = await buildPlan(source.searchUrl, source, {
        ...ctx,
        key: keyword,
        page,
        http: pageBudget,
    })
    // 搜索用更短的超时：一页几个源并发，整页的等待等于最慢的那个源（见 lib/http.ts）
    const html = await fetchText({ ...plan, timeoutMs: SEARCH_TIMEOUT_MS })

    const base = plan.url
    // 把取网能力一并注入：书源脚本里的 java.ajax 需要它，缺了会明确报错
    const searchCtx: RuleContext = {
        ...ctx,
        key: keyword,
        page,
        baseUrl: base,
        // 沙箱也按搜索的预算走：脚本里的 java.ajax 不该花掉沙箱默认的 8 秒
        //（一页几个源并发，整页的等待等于最慢的那个源 —— 见上面那行注释）
        http: sandboxHttp(source, base, SEARCH_TIMEOUT_MS),
        // 搜索里的 `@put:` 是**逐条**写同一个键（最后一条覆盖前面），本来就是有损的；
        // 而且搜索没有「这本书」可挂。所以这一组不落库 —— 见 `infoVars.writeInfoVar`
        infoVarCrossKeys: crossRequestInfoKeys(source, 'ruleSearch'),
    }
    const sel = rootSelection(html)
    /**
     * 逐条字段也开一个**批量求值会话**（第六十一轮）
     *
     * 搜索里「一页 N 本书 × 每条几个 `@js:` 字段」与目录里「一本书几千条」是同一种形状，
     * 代价也是实打实的：实测 200 本书 × 3 条 `@js:`（600 次求值）要 **7 秒** ——
     * 而搜索这一趟的预算（6 秒）只管取网与**单次**求值，管不到「一页几百次」的总量，
     * 于是它能悄悄超出自己那份预算。
     *
     * 键（`preludeJs`）交给 `sourceLimits`：一页三个源共享一个 session，而一份上下文
     * 只能给**同一份 jsLib** 的源用（见 `SandboxBatch.jsLib`）。
     */
    const session = searchCtx.sandbox as SandboxSession | undefined
    const batchLimits = sourceLimits(searchCtx)
    if (session) await openSandboxBatch(session, batchLimits)
    try {
        const items = await analyzeSelections(sel, rule.bookList, searchCtx)
        return await booksFromItems(source, items, rule, searchCtx, base, warnings)
    } finally {
        if (session) closeSandboxBatch(session, batchLimits)
    }
}

/** 搜索与「发现」用的是同一套字段规则，只是分组名不同 */
export interface BookListRule {
    name?: string
    author?: string
    kind?: string
    wordCount?: string
    lastChapter?: string
    intro?: string
    coverUrl?: string
    bookUrl?: string
}

/**
 * 把列表规则圈出的条目逐个读成书
 *
 * 抽出来是因为**搜索与发现必须给出同一本书**：两边各写一份字段读取逻辑，
 * 迟早会在某一边修好一个字段而另一边没跟上，表现为「搜得到但发现页里缺作者」这种
 * 很难归因的差异。
 */
export async function booksFromItems(
    source: BookSource,
    items: Selection[],
    rule: BookListRule,
    ctx: RuleContext,
    base: string,
    warnings: FieldWarning[] = [],
): Promise<SearchBook[]> {
    const books: SearchBook[] = []
    for (const item of items) {
        const name = await analyzeString(item, rule.name ?? 'text', ctx)
        if (!name) continue

        const bookUrlRaw = await analyzeAddress(item, rule.bookUrl ?? 'tag.a@href', ctx)
        const optional = (field: string, rule_: string) =>
            tolerantField(field, () => analyzeString(item, rule_, ctx), warnings)
        books.push({
            name,
            // 展示用字段一律走 tolerantField：一个坏规则不该让整条搜索失败（见该函数说明）
            author: await optional('author', rule.author ?? ''),
            kind: (await optional('kind', rule.kind ?? '')) || undefined,
            lastChapter: (await optional('lastChapter', rule.lastChapter ?? '')) || undefined,
            intro: (await optional('intro', rule.intro ?? '')) || undefined,
            coverUrl:
                (await tolerantField(
                    'coverUrl',
                    async () =>
                        resolveCoverAddress(
                            await analyzeAddress(item, rule.coverUrl ?? '', ctx),
                            base,
                        ),
                    warnings,
                )) || undefined,
            wordCount: (await optional('wordCount', rule.wordCount ?? '')) || undefined,
            bookUrl: resolveAddress(bookUrlRaw, base),
            sourceName: source.bookSourceName,
            sourceUrl: source.bookSourceUrl,
        })
    }
    return books
}

/** 详情页：主要目的是拿到目录地址（tocUrl） */
export async function fetchBookInfo(
    source: BookSource,
    bookUrl: string,
    ctx: RuleContext,
    warnings: FieldWarning[] = [],
): Promise<{
    tocUrl: string
    name: string
    author: string
    intro: string
    coverUrl: string
    warnings: FieldWarning[]
}> {
    const rule = source.ruleBookInfo
    if (!rule) {
        // 没有详情页规则时，直接把书籍地址当作目录地址 —— 很多站是这样的
        return { tocUrl: bookUrl, name: '', author: '', intro: '', coverUrl: '', warnings }
    }

    ctx.source ??= source
    const plan = await buildPlan(bookUrl, source, { ...ctx, baseUrl: bookUrl })
    const html = await fetchText(plan)
    const sel = rootSelection(html)
    const infoCtx: RuleContext = {
        ...ctx,
        baseUrl: plan.url,
        http: sandboxHttp(source, plan.url),
        // 详情页里写的变量，目录 / 正文那两次请求可能还要读（线上 8 处）——
        // 这类键才会落进「书的变量」，见 `infoVars.writeInfoVar`
        infoVarCrossKeys: crossRequestInfoKeys(source, 'ruleBookInfo'),
    }

    /**
     * **`init` 先跑，它决定两件事**
     *
     * 线上 116 处 / 109 个源的 `ruleBookInfo.init`，分两类：
     *
     *   1. **只取副作用**（70 处）：顶格 `@put:{…}`（23）或脚本里的 `java.put`（47）。
     *      「求值一次、把值写进变量表」，其余字段用 `@get:{键}` 读回来。`init` 不跑的话，
     *      这些源的 name / author / kind / intro … **整片空着**，而且不报错。
     *   2. **换掉求值的根**（42 处）：`$.data`、`data.book`、`class.menu`、`.book` 这类。
     *      `⚡📂米读小说` 的 init 是 `$.data`、字段是 `$.title` / `$.author`，接口返回的
     *      却是 `{code:0, data:{title:…}}` —— 不换根每条规则都差一层，全部取空。
     *
     * 两类的判定与求值都在 `resolveInitSelection` 里（一看形状就知道是哪一类）。
     * 返回非 null 时，后面所有字段都在**那个根**上求值。**只影响 `ruleBookInfo`**：
     * 同一个源里 `ruleToc` 的 `$.data.chapter_lists[*]` 是绝对路径，`⚡📂米读小说`
     * 的搜索规则 `$.data[*]` 也是绝对路径 —— 与 `init` 只挂在这个字段下正好一致。
     */
    const initSel = rule.init ? await resolveInitSelection(sel, rule.init, infoCtx) : null
    const infoSel = initSel ?? sel

    const tocUrlRaw = await analyzeAddress(infoSel, rule.tocUrl ?? '', infoCtx)

    return {
        tocUrl: tocUrlRaw ? resolveAddress(tocUrlRaw, plan.url) : plan.url,
        // 与搜索那条路同一条纪律：展示用字段坏了只让字段空着，`tocUrl` 坏了才报错
        name: await tolerantField(
            'name',
            () => analyzeString(infoSel, rule.name ?? '', infoCtx),
            warnings,
        ),
        author: await tolerantField(
            'author',
            () => analyzeString(infoSel, rule.author ?? '', infoCtx),
            warnings,
        ),
        intro: await tolerantField(
            'intro',
            () => analyzeString(infoSel, rule.intro ?? '', infoCtx),
            warnings,
        ),
        coverUrl: await tolerantField(
            'coverUrl',
            async () =>
                resolveCoverAddress(
                    await analyzeAddress(infoSel, rule.coverUrl ?? '', infoCtx),
                    plan.url,
                ),
            warnings,
        ),
        warnings,
    }
}

/**
 * 目录最多翻多少页
 *
 * 真实站点的目录常常分页（精华书阁一本 2226 章的书，每页 20 章 —— 要 112 页）。
 * 不翻页的话长书只能读到开头几十章，而翻页本身是有风险的：书源里的 nextTocUrl
 * 写错（比如永远指向当前页）就会变成一个无底洞。所以两道保险都上：
 * 访问过的地址记下来不放行重复访问，再加这个页数上限。
 *
 * 定 20 而不是更大，是因为**平台有硬限制**：Workers 每次调用能发起的子请求数
 * （免费版 50 个）与 CPU 时间都是有限的，而每翻一页就是一次请求外加一次解析。
 * 20 页约 400 章，留足了余量；要读更长的书得先上付费版再把这个数调大，
 * 而不是在这里赌平台会放过我们。
 */
const MAX_TOC_PAGES = 20

/**
 * 逐条标注（`isVip` / `isPay` / `isVolume` / `updateTime`）最多为多少条求值
 *
 * 只在这几条规则**真的要走沙箱**时才生效（判据是 `ruleHasJs`）—— 得分为两种情形：
 *
 *   - **纯选择器 / 裸字段名**（语料里 45 + 74 + 25 + 7 个源中，各自一半以上是这样）：
 *     一次求值就是一次 cheerio 查询，便宜得多，**不设上限**（📚企鹅阅读 的
 *     `.list@.lock@html` 就是这一类：1663 章全都标得出来）
 *   - **`@js:` / `{{}}`**：每一条都要进一次沙箱。量出来的代价是**一次 4～8ms**
 *     （冒烟第 43 段：300 条 × 三条 `@js:` 字段 ≈ 900 次求值，实测 7.1 秒）。
 *     一本书动辄上千章 —— 两千章就是上万次求值，整次目录请求必然超时
 *
 * 而它们都只是**标注**：没有它们目录照样能读，有它们更好。所以给一个上限，
 * 超过就停下、并在 `warning` 里说清楚（**不静默** —— 「少了一截」必须让用户看见）。
 *
 * **第五十九轮把这条上限按实测重定了：300 → 1200。** 根因查清并做掉了：一次求值
 * 5.64ms 里有 5.3ms 是**重新解析那 52KB 预置**（runtime + context 只要 0.34ms），
 * 而目录这一轮改成**批量求值**（同一个 context 里只重跑 PER_EVAL_PRELUDE，见
 * `openSandboxBatch`）。冒烟第 43 段实测同一件事：**900 次求值 7484ms → 805ms**，
 * 一次求值从 8.3ms 降到 0.9ms。
 *
 * 为什么不是彻底取消：剩下的开销与预置无关了（第六十轮量过：边界往返只占 0.08ms，
 * 其余是**内生的** —— 重新造那五个全局对象、解析规则里的动态脚本、`JSON.parse` 注入
 * 进来的数据），那个天花板不高。1200 条 × 四条逐条字段 ≈ 4800 次求值，这是当前愿意
 * 接受的单请求代价；而**纯选择器 / 裸字段名**那一类（语料里过半）依旧不设限。
 */
const MAX_MARKED_CHAPTERS = 1200

/** 目录结果 */
export interface TocResult {
    chapters: Chapter[]
    /**
     * 翻页中途失败时的说明。**有值时章节列表是不完整的** ——
     * 与其让前端以为「这本书就这么长」，不如把「少了一截」说出来。
     */
    warning?: string
}

/** 目录页：返回章节列表。带 nextTocUrl 时会把后续页一并取回并合起来 */
export async function fetchChapters(
    source: BookSource,
    tocUrl: string,
    ctx: RuleContext,
): Promise<TocResult> {
    const rule = source.ruleToc
    if (!rule?.chapterList) throw new UpstreamError('书源未配置目录列表规则（ruleToc.chapterList）')

    ctx.source ??= source

    const chapters: Chapter[] = []
    // 按地址去重：多页之间、以及站点的「最新章节」区块与完整目录之间都可能重复
    const seenChapterUrls = new Set<string>()
    const visitedTocUrls = new Set<string>()
    const notes: string[] = []
    /**
     * 逐条标注的求值上限
     *
     * **只在真的要走沙箱时才设限**：纯选择器 / 裸字段名的规则便宜得多（一次 cheerio 查询），
     * 给它们也卡上限等于白白丢掉能拿到的标注 —— 📚企鹅阅读 的 1663 章全是这一类。
     */
    const markRules = [rule.isVip, rule.isPay, rule.isVolume, rule.updateTime].filter(
        (r): r is string => typeof r === 'string' && r.trim() !== '',
    )
    const markHasJs = markRules.some((r) => ruleHasJs(r))
    const markCap = markHasJs ? MAX_MARKED_CHAPTERS : Infinity
    /** 已经为多少条求过逐条标注了（跨页累计） */
    let markedCount = 0
    let marksTruncated = false

    /**
     * 要走沙箱的逐条字段 → 开一个**批量求值会话**（第五十九轮）
     *
     * 以前是「每条一次独立求值」，每次都要重新解析 52KB 预置（5.3ms）—— 上限就是这么来的。
     * 现在同一个 context 里只重跑 PER_EVAL_PRELUDE（0.01ms 量级），于是上限可以放开。
     *
     * 开在循环外、`finally` 里关掉：batch 占着 WASM 内存，绝不能留到请求之外。
     * `limits` 与求值那边用**同一份**（`sourceLimits(ctx)`）—— 批是按 jsLib 分的，
     * 给出同一份才找得回自己那一批（见 `SandboxBatch.jsLib`）。
     * 轮换（每 400 次换 context）第六十一轮搬进沙箱层了，这里不用管。
     */
    const session = ctx.sandbox as SandboxSession | undefined
    const batchLimits = sourceLimits(ctx)
    let batchOpen = false
    if (markHasJs && session) {
        await openSandboxBatch(session, batchLimits)
        batchOpen = true
    }

    let currentUrl = tocUrl
    // 目录这一组里写的跨请求键（比如 `🏛名著阅读` 的 `img`，正文那次请求要读）：
    // 在循环外算一次；`writeInfoVar` 每个键一次请求只落一次，所以逐页求值也不会写爆
    const crossKeys = crossRequestInfoKeys(source, 'ruleToc')
    try {
        for (let page = 0; page < MAX_TOC_PAGES; page += 1) {
            if (visitedTocUrls.has(currentUrl)) break
            visitedTocUrls.add(currentUrl)

            let plan
            let html: string
            try {
                plan = await buildPlan(currentUrl, source, { ...ctx, baseUrl: currentUrl })
                html = await fetchText(plan)
            } catch (err) {
                // 第一页就失败：手上没有任何章节，如实报错
                if (chapters.length === 0) throw err
                // 后续页失败：**保留已经拿到的章节**，只记一条说明。
                // 真实站点上这很常见 —— 最后一页被删、或书源的翻页地址算错，
                // 一次 404 就把前面几百章全丢掉，比「章节不全」更糟：
                // 用户看到的是一个错误页，而其实书是能读的。
                notes.push(
                    `翻页到第 ${page + 1} 页时中断：${err instanceof Error ? err.message : String(err)}`,
                )
                break
            }

            const sel = rootSelection(html)
            const tocCtx: RuleContext = {
                ...ctx,
                baseUrl: plan.url,
                http: sandboxHttp(source, plan.url),
                infoVarCrossKeys: crossKeys,
            }

            const items = await analyzeSelections(sel, rule.chapterList, tocCtx)
            for (const item of items) {
                const name = await analyzeString(item, rule.chapterName ?? 'text', tocCtx)
                if (!name) continue

                /**
                 * 与 `chapterName` 同层的四条逐条字段（第五十六轮开始取）
                 *
                 * 它们以前整片丢掉 —— 目录里于是看不出哪一章要钱、也看不到卷与更新时间。
                 * 判据（`tocFlag`）在 `chapterFields.ts` 里写清楚了：语料里既有
                 * 「取到标记文本就算」的写法，也有「脚本回 true / false」的写法，
                 * 只按非空判会把脚本回的 `false` 当成要付费。
                 *
                 * 超过 `MAX_MARKED_CHAPTERS` 之后不再求值（代价见那个常量的说明），
                 * 并在 warning 里说出来。
                 */
                const marked = markedCount < markCap
                const hasMarks = markRules.length > 0
                const isVolume =
                    rule.isVolume && marked
                        ? tocFlag(await analyzeString(item, rule.isVolume, tocCtx))
                        : false

                const urlRaw = await analyzeAddress(item, rule.chapterUrl ?? 'tag.a@href', tocCtx)
                const url = urlRaw ? resolveAddress(urlRaw, plan.url) : ''
                /**
                 * 卷标题通常**没有正文地址**（`chapterUrl` 在那一行取到的是卷名那段文本），
                 * 但它要留在列表里当分组标题 —— 所以判据从「没地址就丢」改成
                 * 「既没地址又不是卷，才丢」。
                 */
                if (url === '' && !isVolume) continue
                // 去重只在有地址时做：卷标题多半都是空地址，按空串去重会把它们合并成一条
                if (url !== '') {
                    if (seenChapterUrls.has(url)) continue
                    seenChapterUrls.add(url)
                }

                const chapter: Chapter = { name, url }
                if (isVolume) chapter.isVolume = true
                if (marked) {
                    if (rule.isVip)
                        chapter.isVip = tocFlag(await analyzeString(item, rule.isVip, tocCtx))
                    if (rule.isPay)
                        chapter.isPay = tocFlag(await analyzeString(item, rule.isPay, tocCtx))
                    if (rule.updateTime) {
                        chapter.updateTime = tocText(
                            await analyzeString(item, rule.updateTime, tocCtx),
                        )
                    }
                    markedCount += 1
                } else if (hasMarks) {
                    marksTruncated = true
                }
                chapters.push(chapter)
            }

            // 没有 nextTocUrl 规则就是单页目录，到此为止
            if (!rule.nextTocUrl) break

            const nextRaw = await analyzeAddress(sel, rule.nextTocUrl, tocCtx)
            if (!nextRaw) break
            const nextUrl = resolveAddress(nextRaw, plan.url)
            // 指向自己或已经去过的页就停：写错规则的书源不该把 Worker 拖死
            if (nextUrl === currentUrl || visitedTocUrls.has(nextUrl)) break
            currentUrl = nextUrl
        }
    } finally {
        // 批量会话必须在这里收掉：它占着 WASM 内存，留到请求之外就是漏
        if (batchOpen && session) closeSandboxBatch(session, batchLimits)
    }

    if (marksTruncated) {
        notes.push(
            `目录超过 ${MAX_MARKED_CHAPTERS} 条，后面那些章节的 isVip / isPay / isVolume / updateTime 没有取` +
                '（这几条规则要用脚本求值、每条一次，代价太大——不影响阅读，只是目录里没有那些标注）',
        )
    }

    return notes.length > 0 ? { chapters, warning: notes.join('；') } : { chapters }
}

/**
 * 一章正文最多翻多少页
 *
 * 不少站点把一章切成好几页（精华书阁的那本 2226 章的书，一章就分 3 页以上，
 * 每页结尾都写着「本章未完，请点击下一页继续阅读」）。不翻页的话读到的就是半截内容 ——
 * 而「内容不全」比「报错」更难发现：页面看起来是正常的，只是少了一半。
 *
 * 上限与目录分页同理，受 Workers 子请求数（免费版 50 个）约束；
 * 一章通常也就 2～4 页，10 页留足了余量。
 */
const MAX_CONTENT_PAGES = 10

/** 取回的一页正文 */
export interface ContentPage {
    /** 该页规则取到的原始文本：未清洗、未拼净化正则 */
    raw: string
    /** 该页的真实地址。图片/音频的相对地址要按**自己那一页**补全，不能按第一章的地址 */
    url: string
}

/**
 * 按 `nextContentUrl` 逐页取回正文，返回每一页的原始文本与地址
 *
 * 文本、图片、音频三种类型共用这一段翻页逻辑，各自的差异放在下游处理：
 * 翻页是站点结构的事，与「这一页取回来的是什么」无关。分成两份实现的话，
 * 一边修好的翻页 bug，另一边还会留着。
 */
export async function collectContentPages(
    source: BookSource,
    chapterUrl: string,
    ctx: RuleContext,
): Promise<ContentPage[]> {
    const rule = source.ruleContent
    if (!rule?.content) throw new UpstreamError('书源未配置正文规则（ruleContent.content）')

    const pages: ContentPage[] = []
    const visitedUrls = new Set<string>()

    let currentUrl = chapterUrl
    for (let page = 0; page < MAX_CONTENT_PAGES; page += 1) {
        if (visitedUrls.has(currentUrl)) break
        visitedUrls.add(currentUrl)

        const plan = await buildPlan(currentUrl, source, { ...ctx, baseUrl: currentUrl })
        const html = await fetchText(plan)
        const sel = rootSelection(html)
        const contentCtx: RuleContext = {
            ...ctx,
            baseUrl: plan.url,
            http: sandboxHttp(source, plan.url),
            infoVarCrossKeys: crossRequestInfoKeys(source, 'ruleContent'),
        }

        const values = await analyzeStrings(sel, rule.content, contentCtx)
        const raw = values.join('\n')
        if (raw.trim() !== '') pages.push({ raw, url: plan.url })

        // 没有 nextContentUrl 规则就是单页章节，到此为止
        if (!rule.nextContentUrl) break

        const nextRaw = await analyzeAddress(sel, rule.nextContentUrl, contentCtx)
        if (!nextRaw) break
        const nextUrl = resolveAddress(nextRaw, plan.url)
        // 指向自己或已经取过的页就停
        if (nextUrl === currentUrl || visitedUrls.has(nextUrl)) break
        currentUrl = nextUrl
    }

    return pages
}

/** 书源自带的净化正则。单条写坏不影响正文本身 */
function applyReplaceRegex(replaceRegex: string | undefined, text: string): string {
    if (!replaceRegex) return text
    let out = text
    for (const part of replaceRegex.split('\n')) {
        const line = part.trim()
        if (!line) continue
        const m = /^(.*?)##(.*?)##(.*)$/.exec(line)
        if (!m) continue
        try {
            out = out.replace(new RegExp(m[1]!, 'g'), m[3] ?? '')
        } catch {
            /* 忽略写坏的净化规则 */
        }
    }
    return out
}

/**
 * 正文（文本源）：返回清洗后的文本
 *
 * 带 `nextContentUrl` 时会把后续页也取回并接在正文后面 —— 顺序很重要，
 * 页与页之间不加分隔符以外的任何东西，否则段落会被拼错。
 *
 * 最后一步是**把还带着 HTML 的正文摊平成文本**（见下面 `toContentText`）。
 */
export async function fetchContent(
    source: BookSource,
    chapterUrl: string,
    ctx: RuleContext,
): Promise<string> {
    const pages = await collectContentPages(source, chapterUrl, ctx)

    // 净化正则作用于**整章**而不是单页：书源里那些跨段的规则（`[\s\S]*` 之类）
    // 只有拿到完整正文才成立
    const text = pages.map((p) => p.raw).join('\n')
    const cleaned = applyReplaceRegex(source.ruleContent?.replaceRegex, text)
    return normalizeContent(toContentText(cleaned))
}

/**
 * 正文最后一道：规则值里还带着 HTML 时，把它摊平成**带段落的纯文本**
 *
 * 为什么非做不可：正文取值方式里 `@html` 占一半以上（线上 816 条启用源里 440 条，54%），
 * 那一路取回来的是原样的 HTML，而阅读界面是把正文当纯文本渲染的（按 `\n` 切段、
 * 每段 textContent）—— 于是用户看到的是字面的 `<p>` / `</p>` / `<br>`，段落还全糊在一起。
 * 细节与线上实测数据见 `src/engine/htmlText.ts` 的文件头。
 *
 * **放在净化正则之后**，两个理由：
 *
 * 1. 书源的 `replaceRegex` 是照着**取值方式的输出**写的。`@html` 那一族的正则里
 *    有不少是冲标记去的（线上 35 条的 `replaceRegex` 里含 `<`），先摊平它们就失效了。
 * 2. 顺序反过来还有个副作用：正则删掉文字后留下的**空标签**（线上那条
 *    `id.rtext@html##↑返回顶部↑` 就会剩一个 `<a href="javascript:...">`）在摊平时
 *    自然消失，不会把一段空壳留在正文里。
 *
 * 判据是「这段像不像 HTML」而不是「规则写了什么取值」：`@js:` 那 176 条（22%）里
 * 也有一大半是脚本自己拼出来的 HTML，静态看不出取值方式，但**看得出来**是不是 HTML。
 */
function toContentText(text: string): string {
    return looksLikeHtml(text) ? htmlToText(text) : text
}

/** 供上层复用：把一个已取回的页面变成规则求值上下文 */
export function pageSelection(html: string): Selection {
    return rootSelection(html)
}
