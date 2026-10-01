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
    rootSelection,
    type Selection,
} from '../engine/analyze'
import type { BookSource, Chapter, RuleContext, SearchBook } from '../engine/types'
import { UpstreamError, fetchText } from '../lib/http'
import { buildPlan, sandboxHttp } from './source'

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
/** 地址类字段：一列候选里取**第一个非空行**，拼错一个字符就整条不可用，不能取整串 */
export async function analyzeAddress(
    item: Selection,
    rule: string,
    ctx: RuleContext,
): Promise<string> {
    if (rule.trim() === '') return ''
    const values = await analyzeStrings(item, rule, ctx)
    for (const value of values) {
        const line = value
            .split('\n')
            .map((part) => part.trim())
            .find((part) => part !== '')
        if (line) return line
    }
    return ''
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

/** 搜索：返回该书源上命中的书籍列表 */
export async function searchBooks(
    source: BookSource,
    keyword: string,
    ctx: RuleContext,
): Promise<SearchBook[]> {
    const rule = source.ruleSearch
    if (!source.searchUrl) throw new UpstreamError('书源未配置搜索地址（searchUrl）')
    if (!rule?.bookList) throw new UpstreamError('书源未配置书籍列表规则（ruleSearch.bookList）')

    const page = ctx.page ?? 1
    const plan = await buildPlan(source.searchUrl, source, { ...ctx, key: keyword, page })
    const html = await fetchText(plan)

    const base = plan.url
    // 把取网能力一并注入：书源脚本里的 java.ajax 需要它，缺了会明确报错
    const searchCtx: RuleContext = {
        ...ctx,
        key: keyword,
        page,
        baseUrl: base,
        http: sandboxHttp(source, base),
    }
    const sel = rootSelection(html)
    const items = await analyzeSelections(sel, rule.bookList, searchCtx)
    return booksFromItems(source, items, rule, searchCtx, base)
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
): Promise<SearchBook[]> {
    const books: SearchBook[] = []
    for (const item of items) {
        const name = await analyzeString(item, rule.name ?? 'text', ctx)
        if (!name) continue

        const bookUrlRaw = await analyzeAddress(item, rule.bookUrl ?? 'tag.a@href', ctx)
        books.push({
            name,
            author: await analyzeString(item, rule.author ?? '', ctx),
            kind: (await analyzeString(item, rule.kind ?? '', ctx)) || undefined,
            lastChapter: (await analyzeString(item, rule.lastChapter ?? '', ctx)) || undefined,
            intro: (await analyzeString(item, rule.intro ?? '', ctx)) || undefined,
            coverUrl:
                resolveUrl(await analyzeAddress(item, rule.coverUrl ?? '', ctx), base) || undefined,
            wordCount: (await analyzeString(item, rule.wordCount ?? '', ctx)) || undefined,
            bookUrl: resolveUrl(bookUrlRaw, base),
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
): Promise<{ tocUrl: string; name: string; author: string; intro: string; coverUrl: string }> {
    const rule = source.ruleBookInfo
    if (!rule) {
        // 没有详情页规则时，直接把书籍地址当作目录地址 —— 很多站是这样的
        return { tocUrl: bookUrl, name: '', author: '', intro: '', coverUrl: '' }
    }

    const plan = await buildPlan(bookUrl, source, { ...ctx, baseUrl: bookUrl })
    const html = await fetchText(plan)
    const sel = rootSelection(html)
    const infoCtx: RuleContext = {
        ...ctx,
        baseUrl: plan.url,
        http: sandboxHttp(source, plan.url),
    }

    const tocUrlRaw = await analyzeAddress(sel, rule.tocUrl ?? '', infoCtx)

    return {
        tocUrl: tocUrlRaw ? resolveUrl(tocUrlRaw, plan.url) : plan.url,
        name: await analyzeString(sel, rule.name ?? '', infoCtx),
        author: await analyzeString(sel, rule.author ?? '', infoCtx),
        intro: await analyzeString(sel, rule.intro ?? '', infoCtx),
        coverUrl: resolveUrl(await analyzeAddress(sel, rule.coverUrl ?? '', infoCtx), plan.url),
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

    const chapters: Chapter[] = []
    // 按地址去重：多页之间、以及站点的「最新章节」区块与完整目录之间都可能重复
    const seenChapterUrls = new Set<string>()
    const visitedTocUrls = new Set<string>()
    let warning: string | undefined

    let currentUrl = tocUrl
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
            warning = `翻页到第 ${page + 1} 页时中断：${err instanceof Error ? err.message : String(err)}`
            break
        }

        const sel = rootSelection(html)
        const tocCtx: RuleContext = {
            ...ctx,
            baseUrl: plan.url,
            http: sandboxHttp(source, plan.url),
        }

        const items = await analyzeSelections(sel, rule.chapterList, tocCtx)
        for (const item of items) {
            const name = await analyzeString(item, rule.chapterName ?? 'text', tocCtx)
            const urlRaw = await analyzeAddress(item, rule.chapterUrl ?? 'tag.a@href', tocCtx)
            if (!name || !urlRaw) continue
            const url = resolveUrl(urlRaw, plan.url)
            if (seenChapterUrls.has(url)) continue
            seenChapterUrls.add(url)
            chapters.push({ name, url })
        }

        // 没有 nextTocUrl 规则就是单页目录，到此为止
        if (!rule.nextTocUrl) break

        const nextRaw = await analyzeAddress(sel, rule.nextTocUrl, tocCtx)
        if (!nextRaw) break
        const nextUrl = resolveUrl(nextRaw, plan.url)
        // 指向自己或已经去过的页就停：写错规则的书源不该把 Worker 拖死
        if (nextUrl === currentUrl || visitedTocUrls.has(nextUrl)) break
        currentUrl = nextUrl
    }

    return warning ? { chapters, warning } : { chapters }
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
        }

        const values = await analyzeStrings(sel, rule.content, contentCtx)
        const raw = values.join('\n')
        if (raw.trim() !== '') pages.push({ raw, url: plan.url })

        // 没有 nextContentUrl 规则就是单页章节，到此为止
        if (!rule.nextContentUrl) break

        const nextRaw = await analyzeAddress(sel, rule.nextContentUrl, contentCtx)
        if (!nextRaw) break
        const nextUrl = resolveUrl(nextRaw, plan.url)
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
    return normalizeContent(applyReplaceRegex(source.ruleContent?.replaceRegex, text))
}

/** 供上层复用：把一个已取回的页面变成规则求值上下文 */
export function pageSelection(html: string): Selection {
    return rootSelection(html)
}
