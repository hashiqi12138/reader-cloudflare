/**
 * 用**真实书源集合**全量校验：CSS 式首段里的 JSOUP 位置后缀
 *
 * `.book-dir.1@li`、`.chapter[1]@a`、`.row[-1]@a`、`#list dd[12:-1]` —— 书源把 JSOUP 的
 * 位置写法直接缀在 CSS 选择器后面，线上 **46 处 / 42 个源**。整段交给 CSS 的话
 * `.book-dir.1` 不是合法选择器，目录一律 0 条（⚡📂企鹅阅读、📂冰清阁小说 就是这么躺着的）。
 *
 * 判据与实现见 `analyze.ts` 的 `selectNodesByKind`、`jsoup.ts` 的 `splitCssIndex`。
 * 这份账本要守两件事：
 *   ① 能当序号的都拆得出来（`splitCssIndex` 必须给出 index）
 *   ② **出现没判过的后缀就失败** —— 「序号 / 不是序号」要人工判一次
 *
 * 书源不进仓库，dump 路径由环境变量给，整组默认跳过：
 *
 *   SOURCES_DUMP=sources-current.json npx vitest run test/listCssHeadIndex.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { splitCssIndex } from '../src/engine/jsoup'
import { loadSourceDump, ruleFieldsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

const LIST_FIELDS = new Set(['ruleSearch.bookList', 'ruleExplore.bookList', 'ruleToc.chapterList'])

/** 规则的第一个分支是不是 JSOUP 简写（是就说明不是 CSS 式，这一轮与它无关） */
function isJsoupShorthand(rule: string): boolean {
    const selector = (rule.split('@')[0] ?? '').trim()
    if (selector === '' || selector.startsWith('@')) return true
    if (/^-?(?:class|id|tag|text|children)(?:\.|$)/.test(selector)) return true
    return /^[A-Za-z][\w:-]*(?:\.-?\d+(?::-?[\d%]*)?|\[[^\]]*\])?$/.test(selector)
}

/** 取「CSS 式首段」：第一个 `@` 之前的那一段（不是 CSS 式就返回 null） */
function cssHeadOf(value: string): string | null {
    const first = value.split(/\|\||&&|%%/)[0]!.trim()
    if (first === '') return null
    if (first.includes('<js') || /@js:/i.test(first)) return null
    if (/^(\/\/|\(\/|\$|:|@)/.test(first) || first.startsWith('+')) return null
    if (isJsoupShorthand(first)) return null
    const at = first.indexOf('@')
    return (at > 0 ? first.slice(0, at) : first).trim()
}

/** 首段末尾的后缀原文（取法与实现无关，只看规则文本的形状） */
function tailIndexText(head: string): string | null {
    const m = /^(.*?)(?:\.(-?\d+(?::-?[\d%]*)?)|\[([^\]]*)\])$/.exec(head)
    if (!m) return null
    const css = (m[1] ?? '').trim()
    if (css === '' || css.includes('@')) return null
    return m[2] ?? m[3] ?? ''
}

/** 这段后缀能不能当位置用 —— 独立于实现的判据（实现里是 `parseIndexExpr`） */
function looksLikeIndex(text: string): boolean {
    return /^-?\d+(?::-?[\d%]*)?$/.test(text)
}

/**
 * 账本（816 条源的 dump，手工核对过）
 *
 * 刻意不从实现里读：列的是「语料里实际出现过、并已人工判过性质」的后缀。
 */
const POSITION = ['1', '-1', '1:-1', '12:-1', '0:-1', '8:', '0:4', '0'] // 37 处
/**
 * **不是**位置、但形状像的三种（9 处）：
 * `[*]` 是 JSONPath 过滤、`[href*='.html']` / `[class="block"]` 是属性选择器。
 * 这些必须**原样交给 CSS**，一个字都不能动。
 */
const NOT_POSITION = ['*', "href*='.html'", 'class="block"']

const sources = DUMP === '' ? [] : loadSourceDump(DUMP)
const describeOrSkip = DUMP === '' ? describe.skip : describe

describeOrSkip('CSS 式首段的位置后缀（全量账本）', () => {
    const hits: Array<{ source: string; path: string; head: string; tail: string }> = []
    for (const source of sources) {
        for (const field of ruleFieldsOf(source)) {
            if (!LIST_FIELDS.has(field.path)) continue
            const head = cssHeadOf(field.value)
            if (head === null) continue
            const tail = tailIndexText(head)
            if (tail === null) continue
            hits.push({ source: String(source.bookSourceName), path: field.path, head, tail })
        }
    }
    const tailsOf = (list: string[]) => hits.filter((h) => list.includes(h.tail))

    it('dump 读得进来', () => {
        expect(sources.length).toBeGreaterThan(100)
        expect(hits.length).toBeGreaterThanOrEqual(40)
    })

    it('每一处都被判过：出现新后缀就失败（要人工判它是不是位置）', () => {
        const known = new Set([...POSITION, ...NOT_POSITION])
        const unknown = hits.filter((h) => !known.has(h.tail))
        expect(unknown.map((h) => `${h.source} ${h.path} :: ${h.head}`)).toEqual([])
    })

    it('能当序号的（37 处），实现必须都拆得出来', () => {
        const positions = tailsOf(POSITION)
        expect(positions).toHaveLength(37)
        // 账本里的每一条都真的像序号（用独立判据复核一遍账本自己）
        expect(positions.every((h) => looksLikeIndex(h.tail))).toBe(true)
        const missed = positions.filter((h) => splitCssIndex(h.head).index === null)
        expect(missed.map((h) => `${h.source} :: ${h.head}`)).toEqual([])
    })

    it('形状像位置但其实不是的（9 处）：实现原样返回，一个字不动', () => {
        const others = tailsOf(NOT_POSITION)
        expect(others).toHaveLength(9)
        expect(others.every((h) => !looksLikeIndex(h.tail))).toBe(true)
        for (const h of others) {
            const split = splitCssIndex(h.head)
            expect(split.index).toBeNull()
            expect(split.css).toBe(h.head)
        }
    })
})
