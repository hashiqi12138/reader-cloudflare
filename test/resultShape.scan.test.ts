/**
 * 用**真实书源集合**全量校验：`选择器@js:` 里 `result` 的绑法判定
 *
 * 单测（`resultShape.test.ts`）钉的是已知形态；这个扫描回答的是「线上还有没有漏网的写法」。
 * 它不比对一份「期望值表」，而是盯住**两条会真出事的不变量**：
 *
 *   1. 脚本在 `result` 上调了**字符串专有方法**（`result.split(...)` 之类），
 *      判定结果**必须**是字符串。判成数组的后果是 `TypeError: result.split is not a function`
 *      —— 线上 🎨🔞鸟鸟韩漫 的正文就是这么整章读不出来的。
 *   2. 脚本对 `result` 做了**下标访问**（`result[0]`），判定结果**必须**是数组。
 *      判成字符串的后果更隐蔽：`result[0]` 变成第一个**字符**，不报错、只是值不对。
 *
 * 两条不变量都用**自己写的窄正则**当参照，不复用被测模块里的那些正则 ——
 * 复用就等于拿实现证明实现。
 *
 * 书源不进仓库，dump 路径由环境变量给，所以整组默认跳过：
 *
 *   SOURCES_DUMP=live-explore-dump.json npx vitest run test/resultShape.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { indexOfJsMarker, JS_MARKER } from '../src/engine/directives'
import { findJsRegions, splitRuleText } from '../src/engine/ruleText'
import { resultWantsArray } from '../src/engine/resultShape'
import { JOINERS, loadSourceDump, ruleFieldsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

/**
 * 独立参照：字符串专有方法
 *
 * 刻意写**窄** —— 只认 `result.方法(`。`String(result[i]).match(...)` 不是在 `result`
 * 上调字符串方法（它调的是 `String(...)` 的结果），写成 `result.*match` 就会把它误伤。
 */
const ORACLE_STRING_METHOD =
    /\bresult\s*\.\s*(split|substring|substr|charAt|replace|replaceAll|match|matchAll|toUpperCase|toLowerCase|trim|startsWith|endsWith|padStart|padEnd|search)\s*\(/

/** 独立参照：`result[` 下标访问 */
const ORACLE_INDEX = /\bresult\s*\[/

/** 引擎切连接符的顺序（`&&` → `||` → `%%`，取第一个切得动的） */
function segmentsOf(rule: string): string[] {
    for (const joiner of JOINERS) {
        const parts = splitRuleText(rule, joiner)
        if (parts) return parts
    }
    return [rule]
}

/** 第一个**不在 `<js>` 块里**的 `@js:` 位置（块里那段是 JS 代码，不是规则标记） */
function firstJsMarker(rule: string): number {
    const blocks = findJsRegions(rule).filter((region) => region.block)
    for (let from = 0; ;) {
        const at = indexOfJsMarker(rule, from)
        if (at < 0) return -1
        if (!blocks.some((block) => at >= block.start && at < block.end)) return at
        from = at + JS_MARKER.length
    }
}

interface Hit {
    source: string
    field: string
    head: string
    code: string
    array: boolean
}

/**
 * 取规则里每一处 `选择器@js:` 的 JS 代码
 *
 * **段首的 `@js:` 不算**：那时前面没有选择器，`result` 绑的是页面原文
 * （见 `analyze.ts` 的 `sourceResultGlobals`），与这次要判的东西无关。
 *
 * 取法比引擎实际走到的那部分**略宽**，这是有意为之：
 *   - 引擎是「先切 `##` 净化链、再在剩下的选择器里找 `@js:`」，于是
 *     `选择器##正则##替换@js:代码` 这种把 JS 写在净化链**之后**的规则，
 *     JS 会被当成替换文本、**根本不执行**（线上有十几处，已记进 README 待办）。
 *     这里照样把那段代码取来判 —— 判据本身该对，而且那批规则修好之后就会执行。
 *   - 引擎会先把 `{{模板}}` 展开再判规则，这里不展开。模板里的 `##` 会被当成
 *     净化链分隔符，于是 `{{...##...}}@js:代码` 的 JS 也被一并取到 —— 同样只多不少。
 */
function collectHits(dump: string): Hit[] {
    const hits: Hit[] = []
    for (const source of loadSourceDump(dump)) {
        const name = String(source.bookSourceName ?? '?')
        for (const { path, value } of ruleFieldsOf(source)) {
            for (const segment of segmentsOf(value)) {
                if (firstJsMarker(segment) < 0) continue
                // JS 代码在第一个 `##` 处结束（后面是净化链，不是代码）。
                // 用引擎自己的切法，免得两边对「哪个 `##` 算分隔符」有不同看法
                const parts = splitRuleText(segment, '##', {
                    skipJsBlocks: false,
                    skipQuotes: false,
                }) ?? [segment]
                const part = parts.find((piece) => indexOfJsMarker(piece) >= 0)
                if (part === undefined) continue
                const at = indexOfJsMarker(part)
                const head = part.slice(0, at).replace(/@$/, '')
                if (head.trim() === '') continue
                const code = part.slice(at + JS_MARKER.length)
                hits.push({
                    source: name,
                    field: path,
                    head: head.trim(),
                    code,
                    array: resultWantsArray(code),
                })
            }
        }
    }
    return hits
}

describe.skipIf(DUMP === '')('真实书源全量扫描：`选择器@js:` 的 result 绑法', () => {
    /**
     * 参照的**已知例外**（人工判过，就一条）
     *
     * `⚡📂米读小说 (http://m.miduxs.com)` 的 `ruleContent.nextContentUrl` 里两种形态同时出现：
     * 开头 `var go=result[0];`（下标访问 → 该绑数组）、结尾 `result.replace(/__/,'_')`
     * （字符串方法 → 参照要字符串）。但那是脚本**自己把 `result` 重新赋成了字符串**
     * （`result=next` / `result=""`）之后再调的 —— 参照的前提是「`result` 全程是同一样东西」，
     * 这里不成立。引擎按「有下标访问 → 绑数组」判是**对的**：绑字符串的话
     * `result[0]` 只会取到第一个**字符**。
     */
    const STRING_OP_EXCEPTIONS = ['⚡📂米读小说 / ruleContent.nextContentUrl']

    it('字符串专有方法必须判成字符串；下标访问必须判成数组', () => {
        const hits = collectHits(DUMP)

        const stringOpWrong: string[] = []
        const indexWrong: string[] = []
        let stringOpSeen = 0
        let indexSeen = 0

        for (const hit of hits) {
            // 判数组还是字符串，要看**剥掉字面量之后**的代码吗？不 ——
            // 参照是独立的：只要 `result.方法(` 这个形态出现，就不该判数组。
            // 语料里没有把 `result.xxx(` 写在字符串里的规则（已用带/不带字面量剥离
            // 两种判法对比过：差异只有 1 处，且是正则字面量里的引号造成的，
            // 见 resultShape.ts 的 stripJsLiterals）。
            if (ORACLE_STRING_METHOD.test(hit.code)) {
                stringOpSeen += 1
                const label = `${hit.source} / ${hit.field}`
                if (hit.array && !STRING_OP_EXCEPTIONS.includes(label))
                    stringOpWrong.push(`${hit.source} / ${hit.field} :: ${hit.code.slice(0, 160)}`)
            }
            if (ORACLE_INDEX.test(hit.code)) {
                indexSeen += 1
                if (!hit.array)
                    indexWrong.push(`${hit.source} / ${hit.field} :: ${hit.code.slice(0, 160)}`)
            }
        }

        const byField = new Map<string, number>()
        for (const hit of hits)
            if (hit.array) byField.set(hit.field, (byField.get(hit.field) ?? 0) + 1)

        console.log(`书源 ${String(loadSourceDump(DUMP).length)} 条 / 选择器@js: ${hits.length} 处`)
        console.log(
            `  判数组 ${hits.filter((h) => h.array).length} 处 / 判字符串 ${hits.filter((h) => !h.array).length} 处`,
        )
        console.log(
            `  判数组的字段分布：${
                [...byField]
                    .sort((a, b) => b[1] - a[1])
                    .map(([field, count]) => `${field} ${count}`)
                    .join(' / ') || '（无）'
            }`,
        )
        console.log(`  参照命中：字符串专有方法 ${stringOpSeen} 处 / 下标访问 ${indexSeen} 处`)
        for (const line of stringOpWrong.slice(0, 10)) console.log(`    误判成数组：${line}`)
        for (const line of indexWrong.slice(0, 10)) console.log(`    误判成字符串：${line}`)

        expect(stringOpWrong).toEqual([])
        expect(indexWrong).toEqual([])

        // 扫描要有效：两个方向在集合里都真实存在
        expect(stringOpSeen).toBeGreaterThan(0)
        expect(indexSeen).toBeGreaterThan(0)
    })

    it('默认是字符串 —— 按数组写的只是少数，否则「简单改成一律数组」就够用了', () => {
        const hits = collectHits(DUMP)
        const array = hits.filter((h) => h.array).length

        console.log(`  数组 ${array} / 字符串 ${hits.length - array}`)
        expect(array).toBeGreaterThan(0)
        expect(array).toBeLessThan(hits.length / 2)
    })

    it('判数组的规则集中在少数几个字段上 —— 判据没有「到处都判数组」', () => {
        const hits = collectHits(DUMP)
        const fields = [...new Set(hits.filter((hit) => hit.array).map((hit) => hit.field))].sort()

        console.log(`  判数组涉及到的字段（${fields.length} 个）：${fields.join(' / ')}`)

        // 判据写歪（比如把「原样返回」当成所有情况的数组）会立刻让这个集合铺开：
        // `选择器@js:` 里只有「结果是一列东西」的那几个字段会用到数组语义。
        //
        // 上限从 8 放到 12：dump 从 594 条源（260 处 `选择器@js:`）长到 816 条（337 处）之后，
        // 涉及到的字段到了 **10** 个。要守的是「**没有到处都判数组**」，不是一个具体的数字 ——
        // 判据写歪的话这个集合会铺到二三十个字段上去
        expect(fields.length).toBeLessThanOrEqual(12)
        // 两个主力字段必须在名单里 —— 少了它们说明判据收得太紧，翻页会退回半截地址
        expect(fields).toContain('ruleToc.nextTocUrl')
        expect(fields).toContain('ruleToc.chapterList')
    })
})
