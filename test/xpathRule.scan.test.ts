/**
 * 用**真实书源集合**全量校验：XPath 规则都能被解析
 *
 * 为什么需要它：`xpathSuffix.test.ts` 钉的是几条真实形态，说不出
 * 「线上剩下的 XPath 规则会不会因为这次拆分而坏掉」。这次改动动的是
 * **所有 XPath 规则**（末尾取值后缀的切分），切错的后果是表达式语法错 → 整条规则报错，
 * 所以必须拿整份集合把「拆完之后每一段都还能解析」验一遍。
 *
 * 同时反向钉住最容易切错的那一类：`/a/@href` 这种**属性节点**不能被当成取值后缀。
 * 线上这类有 70 多处，切错的代价是「取到整段文本而不是属性值」—— 静默错值，不报错。
 *
 * **分段必须和引擎一致**，否则扫描出来的「失败」全是假阳性。第一版就栽在这里：
 * 它把 `@js:` 代码按连接符切开再看段首，于是 JS 里的行注释（`// let novel = {}`）
 * 被当成 XPath 表达式，一次报出 50 处「解析失败」。所以这里严格照引擎的顺序来：
 *
 *   1. `splitRuleText` 切连接符（它自己会跳过 `@js:` 与 `<js>` 区域）
 *   2. `@js:` 尾巴切掉，取它**前面**那段（引擎在 `evalSingleSegment` 里就是这么做的）
 *   3. `##` 正则链剥掉（`splitRegexChain`）
 *   4. 剩下的才按方言分派
 *
 * 与其它扫描一样，需要一份书源 dump，而书源不进仓库，所以默认整组跳过：
 *
 *   SOURCES_DUMP=sources.json npx vitest run test/xpathRule.scan.test.ts
 */

import { describe, expect, it } from 'vitest'
import { normalizeXPathFunctions, runXPath, splitXPathExtract } from '../src/engine/xpath'
import { splitRegexChain } from '../src/engine/regex'
import { findJsRegions, splitRuleText } from '../src/engine/ruleText'
import { parseHtml } from '../src/engine/select'
import { JOINERS, loadSourceDump, ruleFieldsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

/**
 * 把一条规则拆成「引擎真正会拿去分派」的那些选择器段
 *
 * 与引擎一致（见文件头说明），跳过 `@js:` / `<js>` 区域、切掉 `@js:` 尾巴、剥掉 `##` 链。
 */
function selectorSegments(rule: string): string[] {
    const out: string[] = []
    for (const joiner of JOINERS) {
        const parts = splitRuleText(rule, joiner)
        if (!parts) continue
        out.push(...parts)
    }
    // 没有连接符的规则，上面那一轮拿不到 —— 补上整条
    if (out.length === 0) out.push(rule)
    return out
}

/** 段 → XPath 表达式；不是 XPath 段返回 null */
function asXPathExpression(segment: string): string | null {
    // JS 之前那段才交给选择器：引擎对 `选择器@js:代码` 与 `选择器<js>代码</js>`
    // 两种写法都是这么做的（`evalSingleSegment` / `evalSelectorChain`）。
    // 不截断的话，`//@href<js>…</js>` 会整段丢给 XPath → 报语法错
    const regions = findJsRegions(segment)
    let t = (regions.length > 0 ? segment.slice(0, regions[0]!.start) : segment).trim()
    // `@js:` 的区域从**标记之后**开始，所以截断后末尾会剩下标记本身
    t = t.replace(/@js:$/i, '').replace(/@$/, '').trim()

    // `##正则##替换`：引擎在分派之前就剥掉了
    t = splitRegexChain(t).selector.trim()

    const directive = /^@xpath:/i.exec(t)
    if (directive) return t.slice(directive[0].length)
    if (t.startsWith('//') || t.startsWith('(/')) return t
    return null
}

describe.skipIf(DUMP === '')('真实书源全量扫描：XPath 规则都能解析', () => {
    it('拆掉取值后缀之后每一段都能解析；`/@属性` 一处都不能被当后缀', () => {
        const sources = loadSourceDump(DUMP)
        const $ = parseHtml(
            '<html><body><div id="x"><span class="y">文案</span></div></body></html>',
        )

        let segments = 0
        let withSuffix = 0
        let attributeSteps = 0
        const suffixNames = new Map<string, number>()
        const unparsable: string[] = []
        /** 明明是 `/@属性` 却被当成取值后缀 —— 静默取错值的那一类 */
        const misclassified: string[] = []

        for (const source of sources) {
            const name = String(source.bookSourceName ?? '?')
            for (const field of ruleFieldsOf(source)) {
                for (const segment of selectorSegments(field.value)) {
                    const expression = asXPathExpression(segment)
                    if (expression === null) continue
                    segments += 1

                    const { expression: xpath, extract } = splitXPathExtract(expression)
                    const hasAttributeStep = /\/@[A-Za-z_]/.test(expression)
                    if (hasAttributeStep) attributeSteps += 1

                    if (extract !== null) {
                        withSuffix += 1
                        suffixNames.set(extract, (suffixNames.get(extract) ?? 0) + 1)
                        if (hasAttributeStep) {
                            misclassified.push(
                                `${name} · ${field.path} · ${expression.slice(0, 110)}`,
                            )
                        }
                    }

                    try {
                        runXPath($, normalizeXPathFunctions(xpath))
                    } catch (err) {
                        unparsable.push(
                            `${name} · ${field.path} [${extract === null ? '无后缀' : `@${extract}`}] ${expression.slice(0, 110)} → ${
                                err instanceof Error ? err.message.slice(0, 70) : String(err)
                            }`,
                        )
                    }
                }
            }
        }

        console.log(`书源 ${sources.length} 条 / XPath 段 ${segments} 处`)
        console.log(
            `  带真取值后缀 ${withSuffix} 处：${
                [...suffixNames].map(([k, v]) => `@${k} ×${v}`).join('、') || '（无）'
            }`,
        )
        console.log(`  含 /@属性 的 ${attributeSteps} 处（这些不能被当后缀）`)
        console.log(`  解析失败 ${unparsable.length} 处`)
        for (const line of unparsable.slice(0, 12)) console.log(`    ${line}`)

        // 扫描要有效：集合里既有带后缀的、也有属性节点的，否则断言会空过
        expect(segments).toBeGreaterThan(0)
        expect(withSuffix).toBeGreaterThan(0)
        expect(attributeSteps).toBeGreaterThan(0)

        expect(misclassified).toEqual([])

        /**
         * 解析不了的**源侧笔误**，两处（都用「字段名 + 源名」精确指认）
         *
         *   1. 🔞永远的神小说 的 `ruleToc.isVolume`
         *      值是 `//javascript:gotochapter('2332','577419')` —— 看着像把站内的
         *      `javascript:` 链接粘错了字段。而这个字段（卷标记）本引擎不读，不影响功能
         *   2. 🎨拷贝漫画 的 `ruleSearch.coverUrl`（dump 长到 816 条源之后新出现的）
         *      值是 `//p[@class="mh-cover tip"])/@style` —— `]` 后面多了一个 `)`。
         *      本意显然是 `//p[@class="mh-cover tip"]/@style`（封面在 `style` 属性的
         *      `url(...)` 里），但**替书源猜它少写了一个括号**会掩盖真正的语法错，
         *      所以只登记、不兜底
         *
         * 显式列出来而不是放宽断言：这样**新增**的解析失败仍然会被拦住。
         */
        const KNOWN_BROKEN = ['isVolume', '🎨拷贝漫画']
        const unexpected = unparsable.filter((line) => !KNOWN_BROKEN.some((k) => line.includes(k)))
        expect(unexpected).toEqual([])
    })
})
