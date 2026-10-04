/**
 * 用**真实书源集合**全量校验：列表规则**取值位**上的那些词
 *
 * 这一轮修的是「末尾那个词被当成属性名吃掉一层」：`class.chapters@li@a` 的 `a`、
 * `.book-list@li` 的 `li` 在书源本意里都是**标签**，引擎的 jsoup 文法却把它们读成
 * 取值名（属性），于是条目少选一层、`href` / `text` 全部落空。判据与实现见
 * `analyze.ts` 的 `selectNodesByKind`（只把**明确是 HTML 标签名**的挪回步骤位）。
 *
 * 这份账本要守两件事：
 *   ① 分布不变形（标签名那一类不能突然掉下去）
 *   ② **出现没分类过的词就失败** —— 新词意味着要重新判一次「它到底是标签还是属性」
 *
 * 书源不进仓库，dump 路径由环境变量给，整组默认跳过：
 *
 *   SOURCES_DUMP=sources-current.json npx vitest run test/listExtract.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { isHtmlTagName } from '../src/engine/jsoup'
import { EXTRACT_KINDS } from '../src/engine/types'
import { loadSourceDump, ruleFieldsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

const LIST_FIELDS = new Set(['ruleSearch.bookList', 'ruleExplore.bookList', 'ruleToc.chapterList'])

/**
 * 账本（816 条源的 dump，手工核对过）
 *
 * 刻意**不**从实现里读标签表：这里列的是「语料里实际出现过、并已人工判过性质」的词。
 * 出现新词 → 测试失败 → 人工判一次再登记，避免默默按错的性质跑。
 */
const KNOWN_EXTRACT = ['html'] // 列表规则里唯一出现过的已知取值名
const TAGS = [
    'a',
    'article',
    'body',
    'dd',
    'div',
    'dl',
    'h1',
    'h2',
    'li',
    'p',
    'tr',
    'ul',
    'table',
    'tbody',
    'td',
    'span',
    'option',
    'title',
    'data',
    'head',
    'i',
    'u',
] // 466 处
const OTHER = [
    'children', // 本来就是步骤（SELECT_KEYWORDS）
    'chapterList',
    'subject',
    'result',
    'list',
    'bookinfo',
    'search',
    'items',
    'mio-tile', // 自定义元素：不在标签表里，本轮**没覆盖**（线上 1 处）
] // 11 处

/** 取「取值位」上的那个词；不是裸词就返回 null（与实现的取法无关，只看规则文本） */
function tailWord(value: string): string | null {
    let s = value.split(/\|\||&&|%%/)[0]!.trim()
    const jsAt = s.search(/@js:|<js[\s>]/i)
    if (jsAt >= 0) s = s.slice(0, jsAt)
    const hashAt = s.indexOf('##')
    if (hashAt >= 0) s = s.slice(0, hashAt)
    s = s.trim().replace(/@+$/, '').trim()
    if (s === '') return null
    const segs = s
        .split('@')
        .map((x) => x.trim())
        .filter((x) => x !== '')
    if (segs.length === 0) return null
    const last = segs[segs.length - 1]!
    if (!/^[A-Za-z_][\w:-]*$/.test(last)) return null
    // 末段已经是「步骤」的写法（带点/方括号）不算取值位
    return last
}

const sources = DUMP === '' ? [] : loadSourceDump(DUMP)
const describeOrSkip = DUMP === '' ? describe.skip : describe

describeOrSkip('列表规则的取值位（全量账本）', () => {
    /** 所有列表规则里「取值位」上的词 */
    const words: Array<{ source: string; path: string; word: string }> = []
    for (const source of sources) {
        for (const field of ruleFieldsOf(source)) {
            if (!LIST_FIELDS.has(field.path)) continue
            const word = tailWord(field.value)
            if (word !== null) {
                words.push({ source: String(source.bookSourceName), path: field.path, word })
            }
        }
    }
    const countOf = (list: string[]) => words.filter((w) => list.includes(w.word)).length

    it('dump 读得进来', () => {
        expect(sources.length).toBeGreaterThan(100)
        expect(words.length).toBeGreaterThan(400)
    })

    it('每一处都被分类过：出现新词就失败（要人工判它是标签还是属性）', () => {
        const classified = new Set(
            [...KNOWN_EXTRACT, ...TAGS, ...OTHER, ...EXTRACT_KINDS].map((w) => w.toLowerCase()),
        )
        const unknown = words.filter((w) => !classified.has(w.word.toLowerCase()))
        expect(unknown.map((w) => `${w.source} ${w.path} :: ${w.word}`)).toEqual([])
    })

    it('标签名那一类占绝大多数（466 处），且实现认它们', () => {
        expect(countOf(TAGS)).toBeGreaterThanOrEqual(450)
        // 账本里的标签名，实现必须都认（不然那些源又少选一层）
        const missed = TAGS.filter((w) => !isHtmlTagName(w))
        expect(missed).toEqual([])
    })

    it('已知取值名只有个位数 —— 所以「末尾裸词多半是标签」这个前提成立', () => {
        expect(countOf(KNOWN_EXTRACT)).toBeLessThanOrEqual(5)
        for (const w of KNOWN_EXTRACT) expect(EXTRACT_KINDS).toContain(w)
    })

    it('不该动的那些词，实现确实没认成标签', () => {
        // `mio-tile`（自定义元素）本轮没覆盖；`list` / `items` 这些是 JSON 键名
        for (const w of OTHER.filter((x) => x !== 'children')) {
            expect(isHtmlTagName(w)).toBe(false)
        }
    })
})
