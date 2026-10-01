/**
 * 「发现」（书源探索）
 *
 * Legado 的 exploreUrl + ruleExplore：书源自己声明一组分类，每个分类是一个地址，
 * 那个地址上的书目由 ruleExplore 解析。这是「打开 App 就有书看」的来源，
 * 也是本项目原先完全没实现的一块（线上 816 条源里 60 多处写了 exploreUrl）。
 *
 * exploreUrl 有三种写法，线上三种都存在：
 *   1. 一串 `标题::地址`，按行排 —— 最老也最常见
 *   2. 整条 `@js:` / `<js>`：脚本返回分类数组（`[{title, url}]`），或返回上面那种文本
 *   3. 一个普通地址（可带 `{{page}}`）：整站就一个分类
 *
 * 分类地址本身继续走 `buildPlan`，所以它也能写 `@js:`、也能带请求选项 ——
 * 与 searchUrl 完全同一套处理，不另开一条路。
 */

import { analyzeSelections, rootSelection } from '../engine/analyze'
import { runInSandbox } from '../engine/js'
import type { BookSource, RuleContext, SearchBook } from '../engine/types'
import { UpstreamError, fetchText } from '../lib/http'
import { parseExploreCategories, type ExploreCategory } from './exploreParse'
import { analyzeAddress, booksFromItems, resolveUrl, type BookListRule } from './ops'
import { buildPlan, sandboxHttp } from './source'
import { findUrlJs } from './urlJs'

export type { ExploreCategory }

/** 翻页上限。发现页是「逛逛」，不该被一个写错的分页规则拖成无底洞 */
export const MAX_EXPLORE_PAGE = 50

/** 读出书源的发现分类。没有 exploreUrl 时明确报错，而不是回一个空列表 */
export async function listExploreCategories(
    source: BookSource,
    ctx: RuleContext,
): Promise<ExploreCategory[]> {
    const raw = (source.exploreUrl ?? '').trim()
    if (raw === '') {
        throw new UpstreamError('这个书源没有配置发现地址（exploreUrl）')
    }

    const js = findUrlJs(raw)
    if (!js) return parseExploreCategories(raw, source)

    const value = await runInSandbox(
        js.code,
        {
            key: ctx.key ?? '',
            page: 1,
            book: ctx.book ?? {},
            baseUrl: source.bookSourceUrl,
            result: js.prefix,
        },
        { http: sandboxHttp(source, source.bookSourceUrl) },
    )
    return parseExploreCategories(value, source)
}

export interface ExploreResult {
    page: number
    books: SearchBook[]
    /** 下一页地址；null 表示没有更多 */
    nextUrl: string | null
    /** 分类地址里带 `{{page}}` 时，说明分页由模板自己表达 */
    templated: boolean
}

/** 取一个分类下的书目 */
export async function exploreBooks(
    source: BookSource,
    categoryUrl: string,
    page: number,
    ctx: RuleContext,
): Promise<ExploreResult> {
    const rule = source.ruleExplore
    if (!rule?.bookList) {
        throw new UpstreamError('这个书源没有配置发现页的书目规则（ruleExplore.bookList）')
    }
    if (categoryUrl.trim() === '') {
        throw new UpstreamError('分类地址是空的')
    }

    const safePage = Math.min(Math.max(Math.trunc(page) || 1, 1), MAX_EXPLORE_PAGE)
    const plan = await buildPlan(categoryUrl, source, {
        ...ctx,
        page: safePage,
        baseUrl: source.bookSourceUrl,
    })
    const html = await fetchText(plan)
    const base = plan.url
    const listCtx: RuleContext = {
        ...ctx,
        page: safePage,
        baseUrl: base,
        http: sandboxHttp(source, base),
    }

    const sel = rootSelection(html)
    const items = await analyzeSelections(sel, rule.bookList, listCtx)
    const books = await booksFromItems(source, items, rule as BookListRule, listCtx, base)

    let nextUrl: string | null = null
    if (rule.nextPageUrl) {
        const rawNext = await analyzeAddress(sel, rule.nextPageUrl, listCtx)
        if (rawNext) {
            const resolved = resolveUrl(rawNext, base)
            // 指向自己的「下一页」会被当成无底洞，挡掉
            if (resolved !== base) nextUrl = resolved
        }
    }

    return {
        page: safePage,
        books,
        nextUrl,
        templated: categoryUrl.includes('{{page}}'),
    }
}
