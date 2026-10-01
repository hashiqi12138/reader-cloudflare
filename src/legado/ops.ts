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
function resolveUrl(value: string, base: string): string {
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
 */
async function analyzeAddress(item: Selection, rule: string, ctx: RuleContext): Promise<string> {
    if (rule.trim() === '') return ''
    const values = await analyzeStrings(item, rule, ctx)
    return values.find((v) => v.trim() !== '') ?? ''
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

    const books: SearchBook[] = []
    for (const item of items) {
        const name = await analyzeString(item, rule.name ?? 'text', searchCtx)
        if (!name) continue

        const bookUrlRaw = await analyzeAddress(item, rule.bookUrl ?? 'tag.a@href', searchCtx)
        books.push({
            name,
            author: await analyzeString(item, rule.author ?? '', searchCtx),
            kind: (await analyzeString(item, rule.kind ?? '', searchCtx)) || undefined,
            lastChapter:
                (await analyzeString(item, rule.lastChapter ?? '', searchCtx)) || undefined,
            intro: (await analyzeString(item, rule.intro ?? '', searchCtx)) || undefined,
            coverUrl:
                resolveUrl(await analyzeAddress(item, rule.coverUrl ?? '', searchCtx), base) ||
                undefined,
            wordCount: (await analyzeString(item, rule.wordCount ?? '', searchCtx)) || undefined,
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

/** 目录页：返回章节列表。带 nextTocUrl 时会把后续页一并取回并合起来 */
export async function fetchChapters(
    source: BookSource,
    tocUrl: string,
    ctx: RuleContext,
): Promise<Chapter[]> {
    const rule = source.ruleToc
    if (!rule?.chapterList) throw new UpstreamError('书源未配置目录列表规则（ruleToc.chapterList）')

    const chapters: Chapter[] = []
    // 按地址去重：多页之间、以及站点的「最新章节」区块与完整目录之间都可能重复
    const seenChapterUrls = new Set<string>()
    const visitedTocUrls = new Set<string>()

    let currentUrl = tocUrl
    for (let page = 0; page < MAX_TOC_PAGES; page += 1) {
        if (visitedTocUrls.has(currentUrl)) break
        visitedTocUrls.add(currentUrl)

        const plan = await buildPlan(currentUrl, source, { ...ctx, baseUrl: currentUrl })
        const html = await fetchText(plan)
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

    return chapters
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

/**
 * 正文：返回清洗后的文本
 *
 * 带 `nextContentUrl` 时会把后续页也取回并接在正文后面 —— 顺序很重要，
 * 页与页之间不加分隔符以外的任何东西，否则段落会被拼错。
 */
export async function fetchContent(
    source: BookSource,
    chapterUrl: string,
    ctx: RuleContext,
): Promise<string> {
    const rule = source.ruleContent
    if (!rule?.content) throw new UpstreamError('书源未配置正文规则（ruleContent.content）')

    const pageTexts: string[] = []
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
        const pageText = values.join('\n')
        if (pageText.trim() !== '') pageTexts.push(pageText)

        // 没有 nextContentUrl 规则就是单页章节，到此为止
        if (!rule.nextContentUrl) break

        const nextRaw = await analyzeAddress(sel, rule.nextContentUrl, contentCtx)
        if (!nextRaw) break
        const nextUrl = resolveUrl(nextRaw, plan.url)
        // 指向自己或已经取过的页就停
        if (nextUrl === currentUrl || visitedUrls.has(nextUrl)) break
        currentUrl = nextUrl
    }

    // 净化正则作用于**整章**而不是单页：书源里那些跨段的规则（`[\s\S]*` 之类）
    // 只有拿到完整正文才成立
    let text = pageTexts.join('\n')

    // 书源自带的净化正则
    if (rule.replaceRegex) {
        for (const part of rule.replaceRegex.split('\n')) {
            const line = part.trim()
            if (!line) continue
            const m = /^(.*?)##(.*?)##(.*)$/.exec(line)
            if (!m) continue
            try {
                text = text.replace(new RegExp(m[1]!, 'g'), m[3] ?? '')
            } catch {
                /* 单条净化规则写坏不影响正文本身 */
            }
        }
    }

    return normalizeContent(text)
}

/** 供上层复用：把一个已取回的页面变成规则求值上下文 */
export function pageSelection(html: string): Selection {
    return rootSelection(html)
}
