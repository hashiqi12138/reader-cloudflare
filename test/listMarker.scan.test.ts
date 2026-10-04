/**
 * 用**真实书源集合**全量校验：列表规则开头那个 `+`
 *
 * 这一轮把它从「一条明确报错」改成「剥掉、按后面的规则求值」，依据全在这份账本上：
 *
 *   1. **12 处**，全部落在**列表规则**字段上（10 处 `chapterList` + 2 处 `bookList`）——
 *      与社区文档说的「在搜索列表、发现列表和目录中使用」一致，没有一处落在字段规则上
 *   2. 剥掉 `+` 之后剩下的形态只有三种：`@js:`（6）、`<js>`（4）、CSS 选择器（2）
 *   3. **没有一处剩下的是 AllInOne**（`:` 开头）—— 这一条直接否掉了
 *      「`+` = AllInOne」那个读法：`+@css:.bookbox` 怎么读都读不成 AllInOne
 *
 * 原本记的是 8 处，dump 长到 816 条源之后变成 12 处（多出来的四处都是同一个形状：
 * `+@js:` / `+<js>` 的目录规则，`📂明月小说` 那两个源还**逐字相同**、只是站点不同）——
 * 与第 1、2 条的结论一致，所以只更新数字与清单，判据没动。
 *
 * 书源不进仓库，dump 路径由环境变量给，所以整组默认跳过：
 *
 *   SOURCES_DUMP=live-explore-dump.json npx vitest run test/listMarker.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { splitRuleText } from '../src/engine/ruleText'
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

/** 会写「列表」的字段：只有这几个字段的返回值是一串条目 */
const LIST_FIELDS = new Set(['bookList', 'chapterList'])

interface Hit {
    source: string
    field: string
    index: number
    seg: string
    rest: string
    shape: string
}

function collect(): Hit[] {
    const hits: Hit[] = []
    for (const source of loadSourceDump(DUMP)) {
        const name = String(source.bookSourceName ?? '?')
        for (const { path, value } of ruleFieldsOf(source)) {
            const segs = segmentsOf(value)
            for (let i = 0; i < segs.length; i += 1) {
                const seg = segs[i]!.trim()
                if (!seg.startsWith('+')) continue
                if (seg.startsWith('++')) continue
                const rest = seg.slice(1).trim()
                const shape = /^@js:/i.test(rest)
                    ? '@js:'
                    : /^<js/i.test(rest)
                      ? '<js>'
                      : rest === ''
                        ? '(空)'
                        : rest.startsWith(':')
                          ? 'AllInOne'
                          : '选择器'
                hits.push({ source: name, field: path, index: i, seg, rest, shape })
            }
        }
    }
    return hits
}

const describeOrSkip = DUMP === '' ? describe.skip : describe

describeOrSkip('全量扫描：列表规则开头的 `+`', () => {
    it('全部落在列表规则字段上，且没有一处剥完是 AllInOne', () => {
        const hits = collect()
        expect(hits.length).toBe(12)

        // 字段：只有 bookList / chapterList 两种
        const byField = new Map<string, number>()
        for (const hit of hits) byField.set(hit.field, (byField.get(hit.field) ?? 0) + 1)
        expect([...byField.keys()].sort()).toEqual(['ruleSearch.bookList', 'ruleToc.chapterList'])
        expect(byField.get('ruleToc.chapterList')).toBe(10)
        expect(byField.get('ruleSearch.bookList')).toBe(2)
        for (const hit of hits) {
            expect(LIST_FIELDS.has(hit.field.split('.').pop()!)).toBe(true)
        }

        // 形态：6 个 `@js:`、4 个 `<js>`、2 个选择器；**一个 AllInOne 都没有**
        const byShape = new Map<string, number>()
        for (const hit of hits) byShape.set(hit.shape, (byShape.get(hit.shape) ?? 0) + 1)
        expect([...byShape.entries()].sort()).toEqual([
            ['<js>', 4],
            ['@js:', 6],
            ['选择器', 2],
        ])
        expect(byShape.has('AllInOne')).toBe(false)
        expect(byShape.has('(空)')).toBe(false)
    })

    it('每一处剥掉 `+` 之后都还是一条像样的规则（不剩空串）', () => {
        for (const hit of collect()) {
            expect(hit.rest.length).toBeGreaterThan(0)
        }
    })

    it('账本：12 处的确切位置（对不上时这张表就是下一步要查的清单）', () => {
        const rows = collect()
            .map((h) => `${h.source} / ${h.field} [${h.shape}] 段#${h.index}`)
            .sort()
        expect(rows).toEqual([
            '⚡📂武道文学 / ruleToc.chapterList [@js:] 段#0',
            '⚡📂笔下文学 / ruleToc.chapterList [@js:] 段#0',
            '⚡📂️快眼小说 / ruleSearch.bookList [选择器] 段#0',
            '🎨🔞很色情的漫画 / ruleToc.chapterList [<js>] 段#0',
            '📂内裤奇缘小说 / ruleSearch.bookList [选择器] 段#0',
            // 两个同名不同站的源，规则**逐字相同** —— 所以清单里会出现两行一样的
            '📂明月小说 / ruleToc.chapterList [@js:] 段#0',
            '📂明月小说 / ruleToc.chapterList [@js:] 段#0',
            '📂趣书小说 / ruleToc.chapterList [<js>] 段#0',
            '📂️笔下文学 / ruleToc.chapterList [@js:] 段#0',
            '📚海棠/蓝海搜书 / ruleToc.chapterList [@js:] 段#0',
            '🔞po18城 / ruleToc.chapterList [<js>] 段#0',
            '🔞肉肉屋 / ruleToc.chapterList [<js>] 段#0',
        ])
        // 12 处**全在第一段**：`+` 是整条规则的标记，不是某个分支的
        for (const hit of collect()) expect(hit.index).toBe(0)
    })
})
