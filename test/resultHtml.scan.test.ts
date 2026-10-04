/**
 * 用**真实书源集合**全量扫描：交给脚本的 `result` 该是 HTML 还是文本
 *
 * 背景是一条必须在整份集合上量、不能靠想象的取舍：
 *
 *   脚本里同时出现「字符串写法」与「节点方法」时（`String(result)` + `result.toArray()`），
 *   `result` 绑成**盒装字符串**（两种写法都能满足）。但那份字符串的**内容**可以是
 *   `选择器` 默认取到的**文本**，也可以是节点的 **HTML** —— 这两种在旧实现里是文本，
 *   于是 `result.toArray()` 只能解析一堆纯文本，得到**空数组**（不报错，只是东西没了）。
 *
 * 现在改成：只要脚本调了「只有节点才有的方法」（`usesJsoupOnResult`），就给它 HTML。
 * 这个改动**会改变一批规则拿到的内容**，所以这里量三件事：
 *
 *   1. 有多少处规则真的会拿到 HTML（而不是文本）—— 这是改动的全部影响面
 *   2. 其中有多少处同时按字符串用（即内容从文本变成 HTML 的那一批）—— 这才是**风险面**
 *   3. 风险面里的每一处，是否都真的需要标记（调了 `attr` / `select` / `toArray` / `text`）
 *
 * 书源不进仓库，dump 路径由环境变量给，所以整组默认跳过：
 *
 *   SOURCES_DUMP=sources-current.json npx vitest run test/resultHtml.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { JS_MARKER } from '../src/engine/directives'
import { findJsRegions, splitRuleText } from '../src/engine/ruleText'
import { usesJsoupOnResult } from '../src/engine/resultShape'
import { JOINERS, loadSourceDump, ruleFieldsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

/** 引擎切连接符的顺序（`&&` → `||` → `%%`，取第一个切得动的） */
function segmentsOf(rule: string): string[] {
    for (const joiner of JOINERS) {
        const parts = splitRuleText(rule, joiner)
        if (parts) return parts
    }
    return [rule]
}

interface Hit {
    source: string
    field: string
    head: string
    code: string
    /** 脚本里有「只有节点才有」的方法 → 现在会拿到 HTML */
    jsoup: boolean
    /** 独立参照：脚本也在 `result` 上当字符串用 */
    stringy: boolean
}

/**
 * 独立参照：脚本在 `result` 上当字符串用
 *
 * 刻意**不复用** `resultShape.ts` 的 `resultWantsString` —— 复用等于拿实现证明实现。
 * 这一条尤其重要：`stripJsLiterals` 处理不了「正则字面量里带引号」的代码
 * （`/<li.*?"\d+" .*?-[^"]+="\d+">/` 这种引号个数为偶数的），会把两个引号之间的
 * **真代码**当成字符串剥掉 —— 📂海马书屋 的 `String(result)` 正好落在被剥掉的那一段里，
 * 于是引擎判它「没按字符串用」。参照用原文判，量出来的风险面才是真的。
 */
const ORACLE_STRING_USE =
    /String\s*\(\s*result\s*\)|JSON\.parse\s*\(\s*result\b|\+\s*result\b|\bresult\s*\+|\bresult\s*\.\s*(?:split|replace|replaceAll|match|matchAll|substring|substr|trim|toUpperCase|toLowerCase|startsWith|endsWith|charAt|indexOf|padStart|repeat)\s*\(/

/** 独立参照：脚本在 `result` 上要的是**元素** */
const ORACLE_NEEDS_MARKUP =
    /result\s*\.\s*(?:toArray|select|attr|children|first|last|get|eq|size|html|outerHtml|textNodes|eachText|tagName|hasClass|not|filter|matches|matchesOwn|isEmpty|ownText)\s*\(|\bresult\s*\.\s*(?:map|forEach|filter|find|some|every|flatMap|reduce)\s*\(/

/** 取规则里每一处「选择器 + JS」的代码
 *
 * 两种 JS 写法都要认，因为它们走的是**两条不同的代码路径**，而线上两边的例子都有：
 *   - `选择器@js:代码`  —— 在 `evalRule` 里由 `splitJsTail` 切出来
 *   - `选择器<js>代码</js>选择器` —— 在 `evalSelectorChain` 里按 `<js>` 块迭代
 * 片面的扫描会得出「只有 3 处受影响」这种结论（第一版就是），
 * 而 6 条「海马书屋」形状的目录规则全在 `<js>` 那条路上。
 *
 * 段首的 `@js:` / `<js>`（前面没有选择器）**不算**：那时 `result` 绑的是页面原文
 * （见 `sourceResultGlobals`），与这次要判的东西无关。
 */
function collectHits(dump: string): Hit[] {
    const hits: Hit[] = []
    for (const source of loadSourceDump(dump)) {
        const name = String(source.bookSourceName ?? '?')
        for (const { path, value } of ruleFieldsOf(source)) {
            for (const segment of segmentsOf(value)) {
                const regions = findJsRegions(segment)
                if (regions.length === 0) continue
                // 取**最靠前**的那一段：`result` 的形态由它与它前面那段选择器决定
                const region = regions.reduce((a, b) => (b.start < a.start ? b : a))
                let head: string
                let code: string
                if (region.block) {
                    // 块区域：`start` 是 `<js` 的位置，`end` 是 `</js>` 之后
                    const raw = segment.slice(region.start, region.end)
                    head = segment.slice(0, region.start)
                    code = raw.replace(/^<js(?:\s[^>]*)?>/i, '').replace(/<\/js>\s*$/i, '')
                } else {
                    // `@js:` 区域：`start` 已经是**代码**的起点（见 findJsRegions）
                    head = segment.slice(0, region.start - JS_MARKER.length)
                    code = segment.slice(region.start, region.end)
                }
                head = head.replace(/@$/, '').trim()
                if (head === '') continue
                hits.push({
                    source: name,
                    field: path,
                    head,
                    code,
                    jsoup: usesJsoupOnResult(code),
                    stringy: ORACLE_STRING_USE.test(code),
                })
            }
        }
    }
    return hits
}

describe.skipIf(DUMP === '')('真实书源全量扫描：result 给 HTML 还是文本', () => {
    it('影响面与风险面都要量出来，且风险面里每一处都真的需要标记', () => {
        const hits = collectHits(DUMP)
        const jsoup = hits.filter((hit) => hit.jsoup)
        const risky = jsoup.filter((hit) => hit.stringy)

        const byField = new Map<string, number>()
        for (const hit of risky) byField.set(hit.field, (byField.get(hit.field) ?? 0) + 1)

        console.log(`书源 ${String(loadSourceDump(DUMP).length)} 条 / 选择器+JS ${hits.length} 处`)
        console.log(`  调到节点方法（改用 HTML）${jsoup.length} 处 ← 影响面`)
        console.log(`  其中同时按字符串用（内容由文本变 HTML）${risky.length} 处 ← 风险面`)
        console.log(
            `  风险面的字段分布：${
                [...byField]
                    .sort((a, b) => b[1] - a[1])
                    .map(([field, count]) => `${field} ${count}`)
                    .join(' / ') || '（无）'
            }`,
        )
        for (const hit of risky.slice(0, 12)) {
            console.log(
                `    ${hit.source} / ${hit.field} :: ${hit.code.replace(/\s+/g, ' ').slice(0, 110)}`,
            )
        }

        // 风险面里的每一处，都得能指出它要的是元素（否则就是被误伤的字符串规则）
        const suspects = risky.filter((hit) => !ORACLE_NEEDS_MARKUP.test(hit.code))
        for (const hit of suspects.slice(0, 10)) {
            console.log(`    需要人工看一眼（没认出它要标记）：${hit.source} / ${hit.field}`)
        }

        expect(suspects).toEqual([])
        // 影响面不能悄悄铺开：调节点方法的规则本来就只有这一小撮
        expect(jsoup.length).toBeGreaterThan(0)
        expect(jsoup.length).toBeLessThanOrEqual(40)
        // 风险面（内容由文本变 HTML 的那一批）必须小；它一旦变大就说明判据被放宽了
        expect(risky.length).toBeGreaterThan(0)
        expect(risky.length).toBeLessThanOrEqual(12)
    })
})
