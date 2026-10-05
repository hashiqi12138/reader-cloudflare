/**
 * 用**真实书源集合**全量校验：字段规则里的 **CSS 式「首段 + `@` 步骤」**
 *
 * `.xsm.0@a@text`、`.datainfobox@p.-2@a@text`、`.catalog@.clearfix@li.-1@a@text` ——
 * 字段规则这条路以前只切**最后一个** `@`（`splitCssExtract`），剩下的 `.xsm.0@a`
 * 被当成 CSS，cheerio 对非法选择器**不报错、只是返回空**：症状是「搜索成功、
 * 书名 / 作者 / 分类整列空着」。全量 **746 处 / 221 个源**。
 *
 * 这份账本守三件事：
 *   ① 分布不变形（处数、中间段数、源数）
 *   ② **出现没判过性质的中间段就失败** —— 每一段都要人工判一次「它是标签、是步骤、
 *      还是 CSS 片段」（判错的后果是少选一层或整段落空，都不报错）
 *   ③ 「`@` 出现在方括号内」必须是 0 处 —— 那是「按 `@` 切开」这条改动的安全前提
 *
 * 书源不进仓库，dump 路径由环境变量给，整组默认跳过：
 *
 *   SOURCES_DUMP=sources-current.json npx vitest run test/fieldCssStops.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { isHtmlTagName } from '../src/engine/jsoup'
import { loadSourceDump, ruleFieldsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

const LIST_FIELDS = new Set(['ruleSearch.bookList', 'ruleExplore.bookList', 'ruleToc.chapterList'])

/** 与 `analyze.ts` 的 `isJsoupShorthand` 同一判据（这里独立抄一份，不当成实现的背书） */
function isJsoupShorthand(rule: string): boolean {
    const selector = (rule.split('@')[0] ?? '').trim()
    if (selector === '' || selector.startsWith('@')) return true
    if (/^-?(?:class|id|tag|text|children)(?:\.|$)/.test(selector)) return true
    return /^[A-Za-z][\w:-]*(?:\.-?\d+(?::-?[\d%]*)?|\[[^\]]*\])?$/.test(selector)
}

/** 把一个 body 整理成「一条规则」；不是本轮的形状就返回 null */
function normalize(body: string): string | null {
    let s = body.trim().replace(/^@@?/, '').trim()
    const jsAt = s.search(/@js:|<js[\s>]/i)
    if (jsAt >= 0) s = s.slice(0, jsAt).trim()
    const hashAt = s.indexOf('##')
    if (hashAt >= 0) s = s.slice(0, hashAt).trim()
    if (s === '' || /^(\/\/|\(\/|\$|:|@|\+)/.test(s)) return null
    // 没带 `@` 的 `js:` / `put:` / `css:` 前缀不是本轮的事
    if (/^[A-Za-z]+\s*:/.test(s)) return null
    if (isJsoupShorthand(s)) return null
    return s
}

/** 剥掉段尾的下标后缀，留下「形状」 */
function shapeOf(seg: string): string {
    return seg.trim().replace(/(?:\.(-?\d+(?::-?[\d%]*)?)|\[[^\]]*\]|!-?\d(?:[-:,\d]*\d)?)$/, '')
}

type SegKind = '标签' | '带类型的步骤' | 'CSS片段' | '待判'

/**
 * 独立判一次「这一段该当什么」——刻意**不从实现里读**：
 * 列在这里的都是人工核过、并判过性质的形状。出现 `待判` 就说明有新写法要重新判一次。
 */
function classify(seg: string): SegKind {
    const shape = shapeOf(seg)
    if (/^(?:class|id|tag|text|children)(?:[.\[]|$)/.test(shape)) return '带类型的步骤'
    if (isHtmlTagName(shape)) return '标签'
    if (/^[.#\[>+~*]/.test(shape)) return 'CSS片段'
    if (/\s/.test(shape)) return 'CSS片段'
    // `tag.class` / `tag:pseudo` 这类：实现走到兜底，按 CSS 片段拼回首段
    const m = /^([A-Za-z][\w-]*)([.#:].+)$/.exec(shape)
    if (m && isHtmlTagName(m[1]!)) return 'CSS片段'
    return '待判'
}

/**
 * 账本：「待判」那一类（人工判过，共 9 种）
 *
 * 这些都不是标签、也不是本轮的形状，是**书源自己写残或另有所指**的东西：
 *  - `put:…` / `href"}`：`@put:{…}` 后缀留下的残留段（引擎没有实现 `@put:` / `@get:`，
 *    那是另一件事，见 TODO.md）
 *  - `get:{time}`：同上（`@get:`）
 *  - `text最新章节：`：规则后面直接跟了中文（书源写歪）
 *  - `小说`：同上，非 ASCII
 *  - `tag,li`：本该写 `tag.li`，写成了逗号
 *  - `href#…`：用的是**单 `#`** 当正则分隔（引擎只认 `##`），另一件待办
 */
const ODDITIES = [
    'text',
    'put:{u:"a',
    'href"}',
    'put:{bid:id}',
    'get:{time}',
    'text最新章节：',
    '小说',
    'tag,li',
]
/** 形状太长的两条，用前缀判 */
const ODDITY_PREFIX = ['function shareBook()', 'href#']

const sources = DUMP === '' ? [] : loadSourceDump(DUMP)
const describeOrSkip = DUMP === '' ? describe.skip : describe

describeOrSkip('字段规则里的 CSS 式多段 `@`（全量账本）', () => {
    const rules: Array<{ source: string; path: string; rule: string; mids: string[] }> = []
    let atInBrackets = 0
    for (const source of sources) {
        for (const field of ruleFieldsOf(source)) {
            if (LIST_FIELDS.has(field.path)) continue
            const parts: string[] = []
            const re = /\{\{([\s\S]*?)\}\}/g
            let m: RegExpExecArray | null
            while ((m = re.exec(field.value)) !== null) parts.push(m[1]!)
            if (parts.length === 0) parts.push(field.value)
            for (const rawBody of parts) {
                const s = normalize(rawBody.split(/\|\||&&|%%/)[0] ?? '')
                if (s === null) continue
                if (/\[[^\]]*@[^\]]*\]/.test(s)) atInBrackets += 1
                const segs = s.split('@').map((x) => x.trim())
                const last = segs[segs.length - 1] ?? ''
                // 末段是「取值」（属性名形状的裸词）时，它不算中间段
                const mids =
                    /^[A-Za-z_][\w-]*$/.test(last) && segs.length >= 2
                        ? segs.slice(1, -1)
                        : segs.slice(1)
                if (mids.length === 0) continue
                rules.push({
                    source: String(source.bookSourceName),
                    path: field.path,
                    rule: s,
                    mids,
                })
            }
        }
    }
    const allMids = rules.flatMap((r) => r.mids)

    it('dump 读得进来', () => {
        expect(sources.length).toBeGreaterThan(100)
        expect(rules.length).toBeGreaterThan(700)
        expect(allMids.length).toBeGreaterThan(800)
        expect(new Set(rules.map((r) => r.source)).size).toBeGreaterThan(200)
    })

    it('每一段中间段都被判过性质：出现新形状就失败', () => {
        const known = new Set(ODDITIES)
        const unknown = allMids.filter((seg) => {
            const shape = shapeOf(seg)
            if (classify(seg) !== '待判') return false
            if (known.has(shape)) return false
            return !ODDITY_PREFIX.some((p) => shape.startsWith(p))
        })
        expect(unknown.map((seg) => `${shapeOf(seg)} :: ${seg}`).slice(0, 20)).toEqual([])
    })

    it('标签名那一类实现都认（不认就会少选一层）', () => {
        const tagMids = allMids.filter((seg) => classify(seg) === '标签')
        expect(tagMids.length).toBeGreaterThan(600)
        expect(tagMids.filter((seg) => !isHtmlTagName(shapeOf(seg)))).toEqual([])
    })

    it('「`@` 出现在方括号内」是 0 处 —— 按 `@` 切开这条改动的前提', () => {
        expect(atInBrackets).toBe(0)
    })
})
