/**
 * 用**真实书源集合**全量校验：规则尾部的三种语义
 *
 * 这一轮修的是「规则尾巴」上的三件事，判据都来自同一份账本（594 条源）：
 *
 *   1. **`@js:` 是分界线**：两边的 `##` 链各归各自那一侧。旧实现先切 `##` 链、
 *      再在剩下的选择器里找 `@js:`，于是 `选择器##过滤##@js:代码` 里的脚本
 *      （线上 20 多处）被当成替换串的一部分、一次都不执行。
 *   2. **空选择器 = 当前原文**：`##正则##替换` 直接开头的规则靠这条从整页里抠字段
 *      （线上几十处）。之前落到空数组上，这些字段一律取不到值。
 *   3. **`###`（OnlyOne）= 取第一个匹配**：结果是**被匹配到的那一段**，不是整段文本。
 *      线上 112 处 `###` 规则全是这个意图 —— 约 30 条封面规则要从 href 里抠出数字
 *      再拼一条新地址，按「整段里替换第一处」会拼出 `/book//files/…jpg.html`。
 *
 * 书源不进仓库，dump 路径由环境变量给，所以整组默认跳过：
 *
 *   SOURCES_DUMP=live-explore-dump.json npx vitest run test/ruleTail.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { splitJsTail, splitRuleText } from '../src/engine/ruleText'
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

/**
 * 独立参照：**旧实现**的取法 —— 先切 `##` 链，再在剩下的选择器里找 `@js:`
 *
 * 不用 `splitRegexChain`，免得拿被测实现证明被测实现。
 */
function oldExtract(segment: string): { head: string; code: string } | null {
    const parts = splitRuleText(segment, '##', { skipJsBlocks: false, skipQuotes: false })
    const selector = parts ? (parts[0] ?? '') : segment
    const at = selector.search(/@js:/i)
    if (at < 0) return null
    return { head: selector.slice(0, at).replace(/@$/, ''), code: selector.slice(at + 4) }
}

interface Segment {
    source: string
    field: string
    seg: string
}

function allSegments(): Segment[] {
    const out: Segment[] = []
    for (const source of loadSourceDump(DUMP)) {
        const name = String(source.bookSourceName ?? '?')
        for (const { path, value } of ruleFieldsOf(source)) {
            for (const seg of segmentsOf(value)) out.push({ source: name, field: path, seg })
        }
    }
    return out
}

/**
 * 独立参照：把 `{{...}}` 整段挖掉
 *
 * 引擎是**先展开模板、再判规则**的，所以模板里的 `##` 不算链分隔符
 * （`{{$.tag[*].tagName##\n##,}}` 这种写法线上很多）。
 */
function withoutTemplates(text: string): string {
    return text.replace(/\{\{[\s\S]*?\}\}/g, '')
}

describe.skipIf(DUMP === '')('真实书源全量扫描：规则尾部的三种语义', () => {
    it('`@js:` 一定是分界线；链在它之前的那些，旧实现看不到脚本', () => {
        const segments = allSegments()

        let withSelector = 0
        let chainBeforeJs = 0
        let chainAfterJs = 0
        let bareJs = 0
        let oldSawJs = 0
        const headChanged: string[] = []
        const codeShortened: string[] = []
        const samples: string[] = []

        for (const { source, field, seg } of segments) {
            const tail = splitJsTail(seg)
            if (tail === null) continue
            if (tail.before.trim() === '') {
                bareJs += 1
                continue
            }
            withSelector += 1

            const old = oldExtract(seg)
            if (old === null) {
                // 旧实现在选择器那一半里找不到 `@js:` → 脚本一次都不执行
                chainBeforeJs += 1
                if (samples.length < 8) samples.push(`${source} / ${field}`)
            } else {
                oldSawJs += 1
                // 只比**去掉首尾空白**之后的形状：`选择器 @js:` 里那个空格
                // 两条路都会在 `detectKind` 里被 trim 掉，不构成差异
                if (old.head.trim() !== tail.before.trim()) {
                    headChanged.push(`${source} / ${field} :: ${old.head} ≠ ${tail.before}`)
                }
                // 新代码只会比旧代码**长**：旧实现切 `##` 时不看引号，
                // 代码里写 `"##"` 会被它从中间截断
                if (!tail.code.startsWith(old.code)) {
                    codeShortened.push(`${source} / ${field} :: ${old.code} → ${tail.code}`)
                }
            }
            if (tail.after !== '') chainAfterJs += 1
        }

        console.log(
            `带选择器的 \`@js:\`：${withSelector} 处（另有整条以 \`@js:\` 开头的 ${bareJs} 处）`,
        )
        console.log(`  链在 JS 之后：${chainAfterJs} 处（主线写法）`)
        console.log(`  链在 JS 之前：${chainBeforeJs} 处 ← 这一轮修好的（旧实现看不到脚本）`)
        console.log(`  旧实现能看到脚本的：${oldSawJs} 处 ← 断言它们没被改坏`)
        for (const line of samples) console.log(`    ${line}`)
        for (const line of headChanged.slice(0, 10)) console.log(`  改动到前置选择器：${line}`)
        for (const line of codeShortened.slice(0, 10)) console.log(`  code 变短：${line}`)

        // 扫描要有效：两种写法在集合里都真实存在
        expect(chainBeforeJs).toBeGreaterThan(0)
        expect(chainAfterJs).toBeGreaterThan(0)
        expect(oldSawJs).toBeGreaterThan(0)
        // 前置选择器一个都不能变（换了就等于换了条规则）
        expect(headChanged).toEqual([])
        // 脚本代码不能被截短（只允许变长，即把引号里的 `##` 还回来）
        expect(codeShortened).toEqual([])
    })

    it('空选择器的规则确实存在，而且大多带 `###`（两件事必须一起做）', () => {
        const empty = allSegments().filter(({ seg }) => {
            // 带 `{{}}` 的不算：`{{baseUrl}}##/book/##/chapter/` 展开之后选择器是**地址字面量**，
            // 走的是骨架那条路（`skeletonSelector` 为空 → 直接当结果），不是空选择器
            if (seg.includes('{{')) return false
            const trimmed = withoutTemplates(seg).trim()
            return trimmed.startsWith('##') && trimmed.length > 3
        })
        const withOnlyOne = empty.filter(({ seg }) => seg.trimEnd().endsWith('###'))

        console.log(`  空选择器的规则：${empty.length} 处，其中带 ###：${withOnlyOne.length} 处`)
        for (const e of empty.filter(({ seg }) => !seg.trimEnd().endsWith('###')).slice(0, 8)) {
            console.log(`    不带 ###：${e.source} / ${e.field} :: ${e.seg.slice(0, 90)}`)
        }

        expect(empty.length).toBeGreaterThan(0)
        // 「空选择器 = 当前原文」与「`###` 取第一个匹配」是**同一批规则**上的两件事：
        // 只做前者的话，`##总字数：…##$1###` 会拿整页去替换、取值变成整页
        expect(withOnlyOne.length).toBeGreaterThan(0)
    })

    it('`###` 的分布与形状（给下一次改动留一份账本）', () => {
        const onlyOne = allSegments().filter(({ seg }) => seg.trimEnd().endsWith('###'))

        let inert = 0
        let withSelector = 0
        let emptySelector = 0
        const noGroupRef: string[] = []

        for (const { source, field, seg } of onlyOne) {
            const body = withoutTemplates(seg).trimEnd().replace(/###$/, '')
            const firstHash = body.search(/##/)
            const lastHash = body.lastIndexOf('##')
            if (firstHash < 0 || lastHash < 0) {
                // `###` 没跟链（`…<js>…</js>###` 或链写在 `{{}}` 里），不生效
                inert += 1
                continue
            }
            const selector = body.slice(0, firstHash).trim()
            if (selector === '') emptySelector += 1
            else withSelector += 1

            const replacement = body.slice(lastHash + 2)
            // 替换串里引用捕获组 = 「从匹配到的那一段里取值」的写法
            if (selector !== '' && !/\$\d|\$&/.test(replacement)) {
                noGroupRef.push(`${source} / ${field} :: ${seg.slice(0, 120)}`)
            }
        }

        console.log(
            `  ### 规则：${onlyOne.length} 处（空选择器 ${emptySelector} / 有选择器 ${withSelector} / 不生效 ${inert}）`,
        )
        for (const line of noGroupRef) console.log(`    有选择器但不引用捕获组：${line}`)

        expect(onlyOne.length).toBeGreaterThan(0)
        // 这条不设硬断言：`###` 到底是「取第一个匹配」还是「整段里替换第一处」，
        // 只能靠逐条读替换串的意图来判（线上 56 条有选择器的全是前者：约 30 条封面规则
        // 要从 href 里抠数字拼新地址、`##(\d+)##$1章###`、`##url\('(.*?)'\)##$1###` …）。
        // 这里只把「有选择器但不引用捕获组」的少数几条列出来，方便下次复核
    })
})
