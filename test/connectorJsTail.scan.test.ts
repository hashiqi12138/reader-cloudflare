/**
 * 用**真实书源集合**全量扫描：连接符 + `@js:` 尾段的配合
 *
 * 要回答的问题（TODO 第 10 条）
 * --------------------------
 * `A && B@js:代码` 这种规则，引擎先把 `&&` 切开（`analyzeSelections` / `evalRule`），
 * 再让**最后一段**（`B` + 脚本）去跑脚本 —— 所以脚本里的 `result` 只有 `B` 的结果，
 * 看不到 `A`。
 *
 * 于是有个诱人的改法：「把连接符的合并结果也交给那段脚本」。这一轮先把它**量清楚**，
 * 再决定改不改 —— 上一轮（第七十四轮）已经吃过一次「凭直觉归因」的亏。
 *
 * 量三件事：
 *   1. 这种形状一共有多少处（按组分布）
 *   2. 其中脚本把 `result` 当**标量字符串**用的有多少 —— 那一批一旦改成合并，
 *      前面几段的值会**拼进字符串**（`'更新时间：'+result` 变成 `更新时间：a,b`），
 *      必然出错
 *   3. 其中脚本按**元素集合**用 `result` 的有多少 —— 只有这一批才「可能」受益
 *
 * 书源不进仓库，dump 路径由环境变量给，所以整组默认跳过：
 *
 *   SOURCES_DUMP=sources-current.json npx vitest run test/connectorJsTail.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { JS_MARKER } from '../src/engine/directives'
import { findJsRegions, splitRuleText } from '../src/engine/ruleText'
import { JOINERS, loadSourceDump, ruleFieldsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

/** 「列表规则」那两个字段：它们的 `result` 是一批节点，与字段规则不是一回事 */
const LIST_FIELDS = new Set(['ruleToc.chapterList', 'ruleSearch.bookList', 'ruleExplore.bookList'])

/**
 * 独立参照：脚本把 `result` 当**一个字符串**用
 *
 * 这一批是「改成合并就会坏」的那个集合：合并之后 `result` 里会多出前面几段的值，
 * 而它们全都指望 `result` 只有最后那一段。
 */
const ORACLE_SCALAR =
    /String\s*\(\s*result\s*\)|\+\s*result\b|\bresult\s*\+|'\s*\+\s*result|result\s*\.\s*(?:replace|split|match|matchAll|indexOf|slice|substring|substr|trim|startsWith|endsWith|charAt|toUpperCase|toLowerCase)|\$result/

/**
 * 独立参照：脚本按**元素集合**用 `result`
 *
 * 只有这一批「有可能」是想把前后几段合起来看的（🎨漫画搬运 就是这一批里的一个）。
 */
const ORACLE_ELEMENTS =
    /Array\s*\.\s*from\s*\(\s*result\s*\)|\[\s*\.\.\.\s*result\s*\]|\bresult\s*\[|for\s*\(\s*(?:let|var|const)\s+\w+\s+in\s+result|result\s*\.\s*(?:toArray|size|select|selectFirst|attr|map|forEach|filter|length|children|first|last)/

interface Hit {
    source: string
    field: string
    joiner: string
    /** 脚本前面那几段（连接符左边的），脚本看不到的那些 */
    head: string
    code: string
    list: boolean
    scalar: boolean
    elements: boolean
}

/** 一条规则里「连接符 + 最后一段带 JS」的形状；不是就返回 null */
function hitOf(rule: string): Omit<Hit, 'source' | 'field'> | null {
    for (const joiner of JOINERS) {
        const parts = splitRuleText(rule, joiner)
        if (!parts || parts.length < 2) continue
        const last = parts[parts.length - 1]!
        const regions = findJsRegions(last)
        if (regions.length === 0) continue
        // 取最后一段里**最靠前**的 JS 区域：`result` 绑什么由它与前面那段选择器决定
        const region = regions.reduce((a, b) => (b.start < a.start ? b : a))
        const code = region.block
            ? last
                  .slice(region.start, region.end)
                  .replace(/^<js(?:\s[^>]*)?>/i, '')
                  .replace(/<\/js>\s*$/i, '')
            : last.slice(region.start, region.end)
        const headOfLast = (
            region.block
                ? last.slice(0, region.start)
                : last.slice(0, region.start - JS_MARKER.length)
        )
            .replace(/@$/, '')
            .trim()
        // 最后一段自己前面没有选择器（顶格 `@js:`）就不是这个形状：那时 `result` 是**页面原文**
        if (headOfLast === '') continue
        return {
            joiner,
            head: parts.slice(0, -1).join(joiner).trim(),
            code,
            list: false,
            scalar: ORACLE_SCALAR.test(code),
            elements: ORACLE_ELEMENTS.test(code),
        }
    }
    return null
}

function collectHits(dump: string): Hit[] {
    const hits: Hit[] = []
    for (const source of loadSourceDump(dump)) {
        const name = String(source.bookSourceName ?? '?')
        for (const { path, value } of ruleFieldsOf(source)) {
            const found = hitOf(value)
            if (found)
                hits.push({ ...found, source: name, field: path, list: LIST_FIELDS.has(path) })
        }
    }
    return hits
}

describe.skipIf(DUMP === '')('真实书源全量扫描：连接符 + @js: 尾段', () => {
    it('量出「改成合并会坏多少」与「可能受益多少」，并给出改不动的结论', () => {
        const hits = collectHits(DUMP)
        const list = hits.filter((hit) => hit.list)
        const field = hits.filter((hit) => !hit.list)
        const scalar = hits.filter((hit) => hit.scalar)
        const elements = hits.filter((hit) => hit.elements)

        const byField = new Map<string, number>()
        for (const hit of hits) byField.set(hit.field, (byField.get(hit.field) ?? 0) + 1)
        const byJoiner = new Map<string, number>()
        for (const hit of hits) byJoiner.set(hit.joiner, (byJoiner.get(hit.joiner) ?? 0) + 1)

        console.log(
            `书源 ${String(loadSourceDump(DUMP).length)} 条 / 「连接符 + 最后一段带 JS」${hits.length} 处`,
        )
        console.log(
            `  按连接符：${[...byJoiner].map(([j, n]) => `${j} ${n}`).join(' / ') || '（无）'}`,
        )
        console.log(
            `  按字段：${
                [...byField]
                    .sort((a, b) => b[1] - a[1])
                    .map(([f, n]) => `${f} ${n}`)
                    .join(' / ') || '（无）'
            }`,
        )
        console.log(
            `  列表规则（result 是一批节点）${list.length} 处 / 字段规则 ${field.length} 处`,
        )
        console.log(
            `  脚本把 result 当**标量字符串**用 ${scalar.length} 处 ← 改成合并必然出错的那一批`,
        )
        console.log(`  脚本按**元素集合**用 result ${elements.length} 处 ← 只有这一批可能受益`)
        for (const hit of hits) {
            const kind = hit.scalar ? '标量' : hit.elements ? '集合' : '其它'
            console.log(
                `    [${kind}] ${hit.source} / ${hit.field} (${hit.joiner}) :: ${hit.code.replace(/\s+/g, ' ').slice(0, 90)}`,
            )
        }

        /**
         * 结论（这一条就是本轮要立的据）
         *
         * 「把合并结果交给脚本」会同时动到**标量那一批**，而它们全都指望
         * `result` 只有最后那一段（`'更新时间：'+result` → 多接一个值就变成 `更新时间：a,b`）。
         * 标量批与集合批的比例就是这笔账：只要标量批不是 0，这个改法就不安全。
         */
        expect(hits.length).toBeGreaterThan(0)
        expect(scalar.length).toBeGreaterThan(0)
        // 换句话：受益面（集合批）**不可能**覆盖受损面（标量批）—— 除非两者都是空的
        expect(elements.length).toBeLessThan(hits.length)
        // 这个形状以**字段规则**为主（列表规则只占个位数）
        expect(field.length).toBeGreaterThan(list.length * 3)
    })
})
