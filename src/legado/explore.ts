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

import { analyzeSelections, rootSelection, type Selection } from '../engine/analyze'
import { sourceGlobals, sourceLimits } from '../engine/globals'
import { crossRequestInfoKeys } from '../engine/infoVars'
import {
    closeSandboxBatch,
    openSandboxBatch,
    runInSandbox,
    type SandboxSession,
} from '../engine/js'
import type { BookSource, RuleContext, SearchBook } from '../engine/types'
import { UpstreamError, fetchText } from '../lib/http'
import { parseExploreCategories, type ExploreCategory } from './exploreParse'
import {
    analyzeAddress,
    booksFromItems,
    resolveAddress,
    type BookListRule,
    type FieldWarning,
} from './ops'
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

    // 发现页脚本要 source.getVariable / source.bookSourceUrl，还有 jsLib 里的函数
    ctx.source ??= source

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
            ...sourceGlobals(ctx),
        },
        { http: sandboxHttp(source, source.bookSourceUrl), ...sourceLimits(ctx) },
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
    /** 展示用字段被容错掉的原因（与搜索那条路同一机制，见 ops.ts 的 tolerantField） */
    warnings: FieldWarning[]
}

/** 取一个分类下的书目 */
export async function exploreBooks(
    source: BookSource,
    categoryUrl: string,
    page: number,
    ctx: RuleContext,
): Promise<ExploreResult> {
    const rule = source.ruleExplore
    const warnings: FieldWarning[] = []
    if (!rule?.bookList) {
        throw new UpstreamError('这个书源没有配置发现页的书目规则（ruleExplore.bookList）')
    }
    if (categoryUrl.trim() === '') {
        throw new UpstreamError('分类地址是空的')
    }

    ctx.source ??= source

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
        /**
         * 发现页的逐条字段里也可能写跨请求变量（第七十八轮，TODO 第 8 条）
         *
         * 语料里 4 条源的 `ruleExplore` 写了 `java.put`（📂阿巴小说 / 🏷七猫小说 /
         * 📂乐乎文章 / 📂小米书城），读端在详情 / 目录那一趟 —— 与搜索那条路同一个形状。
         * 少了这一行，「读」的那一趟认得这个键（那边算出来的是「别的组读过」），
         * 而「写」的这一趟不落库，表现为「明明是同一套写法，搜索能用发现不能用」。
         *
         * 落库通道（`itemVarSink`）由调用方注入，与 `searchBooks` 一致 ——
         * 发现这一趟同样没有「这本书」，得等每一条的 `bookUrl` 算出来才知道挂给谁。
         */
        infoVarCrossKeys: crossRequestInfoKeys(source, 'ruleExplore'),
    }

    const sel = rootSelection(html)
    /**
     * 逐条字段也开一个批量求值会话（第六十一轮）
     *
     * 与搜索那条路同一个道理（见 `searchBooks`）：发现页一页也可能十几二十本书，
     * 每条几个 `@js:` 字段就是几十次求值。首页那几个推荐位是**几个源并发**取回来的，
     * 所以这里的批必须按 jsLib 分开才不会串味（见 `SandboxBatch.jsLib`）。
     */
    const session = listCtx.sandbox as SandboxSession | undefined
    const batchLimits = sourceLimits(listCtx)
    if (session) await openSandboxBatch(session, batchLimits)
    let items: Selection[]
    let books: SearchBook[]
    let nextRaw = ''
    try {
        items = await analyzeSelections(sel, rule.bookList, listCtx)
        books = await booksFromItems(source, items, rule as BookListRule, listCtx, base, warnings)

        if (rule.nextPageUrl) nextRaw = await analyzeAddress(sel, rule.nextPageUrl, listCtx)
    } finally {
        if (session) closeSandboxBatch(session, batchLimits)
    }

    let nextUrl: string | null = null
    if (nextRaw) {
        const resolved = resolveAddress(nextRaw, base)
        // 指向自己的「下一页」会被当成无底洞，挡掉
        if (resolved !== base) nextUrl = resolved
    }

    return {
        page: safePage,
        books,
        nextUrl,
        templated: categoryUrl.includes('{{page}}'),
        warnings,
    }
}
