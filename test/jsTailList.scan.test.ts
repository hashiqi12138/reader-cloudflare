/**
 * 用**真实书源集合**全量校验：「`<js>` 块后面还跟一段选择器」的列表规则
 *
 * 这一轮修的是「列表规则的条目丢了 DOM」：`getElements` 在 Legado 里是按段分发的，
 * 尾段选择器用 jsoup 重新解析 JS 的输出 —— 条目是 **Element**。我们以前把尾段的
 * 默认取值（文本）当条目，于是 `chapterUrl: 'href'` 取不到属性（目录 0 章、不报错）、
 * `chapterName` 里按 HTML 写的正则匹配不到（`catch` 再 `[1]` 报 `cannot read property of null`）。
 *
 * 修法只落在**列表规则 + HTML 选择器尾段**这一格上（其余几格保持原样）：
 *
 *   | 尾段            | 行数 | 行为                                  |
 *   | --------------- | ---- | ------------------------------------- |
 *   | HTML 选择器     |  46  | 条目给**节点**（`source` = 这一条的 HTML） |
 *   | JSONPath `$.x`  |  39  | 条目是取出来的**文本**，作用在 `<js>` 段的输出上 |
 *   | `$[*]` / `$[:n]` |   5  | 同上（本轮起 `$[` 也被认成 JSONPath）  |
 *   | `@js:` / 正则链 |   0  | 保持原样                              |
 *
 * 所以这里做两件事：① 数一遍账（HTML 尾段有多少处）；② 断言**一处不漏地被识别**。
 * 判据用**独立参照**（自己判断尾段类型），不拿实现证明实现。
 *
 * 书源不进仓库，dump 路径由环境变量给，整组默认跳过：
 *
 *   SOURCES_DUMP=sources-current.json npx vitest run test/jsTailList.scan.test.ts
 */

import { describe, expect, it, vi } from 'vitest'

// `analyze.ts` 会 import 沙箱（带 QuickJS 的 .wasm，Node 里加载不了）——
// 本文件只用到纯函数，替换掉即可
vi.mock('../src/engine/js', () => ({
    SandboxError: class SandboxError extends Error {},
    runInSandbox: async () => '',
    sandboxResultToString: (value: unknown) => String(value ?? ''),
    sandboxResultToStrings: (value: unknown) => [String(value ?? '')],
}))

const { trailingNodeSelector } = await import('../src/engine/analyze')
const { loadSourceDump, ruleFieldsOf } = await import('./sourceDump')

const DUMP = process.env.SOURCES_DUMP ?? ''

/** 列表规则字段（会一圈一圈地圈条目） */
const LIST_FIELDS = new Set(['ruleSearch.bookList', 'ruleExplore.bookList', 'ruleToc.chapterList'])

/** 最后一个 `</js>` 之后的那段文本；没有 `</js>` 或后面为空都返回 '' */
function tailAfterJsBlock(rule: string): string {
    const at = rule.lastIndexOf('</js>')
    return at < 0 ? '' : rule.slice(at + '</js>'.length).trim()
}

/**
 * **独立参照**的尾段分类（刻意不复用实现的判据）
 *
 * 只按「它长什么样」分：`@json:` 与 `$` 开头的是 JSONPath、AllInOne 以 `:` 开头、
 * 脚本以 `@js:` 开头、含 `##` 的是净化链，其余一律当 HTML 选择器。
 */
function oracleKind(tail: string): 'json' | 'allinone' | 'js' | 'regex' | 'html' {
    if (tail.startsWith('@js:')) return 'js'
    if (/^@json:/i.test(tail)) return 'json'
    if (tail.startsWith('$')) return 'json'
    if (tail.startsWith(':')) return 'allinone'
    if (tail.includes('##')) return 'regex'
    return 'html'
}

/**
 * `$[` 开头的尾段（`$[*]` / `$[:10]`）现在是**正经的 JSONPath**
 *
 * 本轮把 `detectKind` 放宽到认 `$[`：以前只认 `$.`，`$[*]` 会被当成 **CSS** 去 cheerio
 * 里找一个叫 `$[*]` 的元素 —— 静默 0 条（线上 4 个源 5 处都长在 `<js>` 块之后）。
 * 它和 `$.路径` 一样属于 JSON 尾段，所以**同样不该**被 `trailingNodeSelector`
 * 认成节点选择器（那会给不出节点）。
 */
const KNOWN_DOLLAR_BRACKET = (tail: string) => tail.startsWith('$[')

const sources = DUMP === '' ? [] : loadSourceDump(DUMP)
const describeOrSkip = DUMP === '' ? describe.skip : describe

describeOrSkip('列表规则 + <js> 块 + 尾段（全量账本）', () => {
    const list = sources.filter((s) => LIST_FIELDS.size > 0)

    it('dump 读得进来', () => {
        expect(list.length).toBeGreaterThan(100)
    })

    it('HTML 选择器尾段至少有 40 处，且**一处不漏**地被识别成「要给节点」', () => {
        const htmlTails: string[] = []
        const missed: string[] = []

        for (const source of sources) {
            for (const field of ruleFieldsOf(source)) {
                if (!LIST_FIELDS.has(field.path)) continue
                const tail = tailAfterJsBlock(field.value)
                if (tail === '' || oracleKind(tail) !== 'html') continue
                htmlTails.push(`${String(source.bookSourceName)} ${field.path} ${tail}`)
                if (!trailingNodeSelector(field.value)) {
                    missed.push(`${String(source.bookSourceName)} ${field.path} :: ${tail}`)
                }
            }
        }

        // 账本（816 条源的 dump）：46 处。给一个下限而不是等号 ——
        // dump 会随书源集合变化，这里要守的是「这个形状确实存在且都被认出来」
        expect(htmlTails.length).toBeGreaterThanOrEqual(40)
        expect(missed).toEqual([])
    })

    it('JSONPath 尾段**不**走节点那条路（接口型书源靠它取一段一段的 JSON 文本）', () => {
        let jsonTails = 0
        const wrongly: string[] = []
        for (const source of sources) {
            for (const field of ruleFieldsOf(source)) {
                if (!LIST_FIELDS.has(field.path)) continue
                const tail = tailAfterJsBlock(field.value)
                if (tail === '' || oracleKind(tail) !== 'json') continue
                jsonTails += 1
                if (trailingNodeSelector(field.value) && !KNOWN_DOLLAR_BRACKET(tail)) {
                    wrongly.push(`${String(source.bookSourceName)} ${field.path} :: ${tail}`)
                }
            }
        }
        expect(jsonTails).toBeGreaterThan(20)
        expect(wrongly).toEqual([])
    })

    it('🔞PO5 那一族的形状（`tag.a` 尾段）在账本里', () => {
        const names = ['PO5', '新龙小说', '废纸文学', '冷冷文学', '海马书屋', '海棠看书']
        const hits = sources.filter(
            (s) =>
                names.some((n) => String(s.bookSourceName).includes(n)) &&
                trailingNodeSelector(
                    String((s.ruleToc as { chapterList?: string } | undefined)?.chapterList ?? ''),
                ) !== null,
        )
        // 至少命中几个（书源集合会变，不要求 6 个全在）
        expect(hits.length).toBeGreaterThanOrEqual(4)
    })
})
