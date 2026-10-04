/**
 * 用**真实书源集合**全量校验：规则里的 `!` 排除下标
 *
 * `class.grid@tag.tr!0`（⚡📂笔趣阁）、`class.listmain@dd!0:1:…:11`（⚡📂鬼吹灯）、
 * `.txt-list li!0`（📂格格党）、`#chapterlist@a!0:-1`（📂言情小说#5）——
 * 书源把 JSOUP 的「排除」写法直接缀在步骤后面。以前 `tr!0` 被整段当成标签名交给 CSS，
 * cheerio 对非法选择器**不报错、静默返回空**，症状是「目录 0 条 / 搜索 0 条、不报错」。
 *
 * 这份账本守一件事：**每一处 `!` 都得被引擎解析得出来** ——
 * 出现新形状（引擎读不出来的）就失败，要人工判一次语义再登记。
 *
 * 判据的由来：`!` 后面读成「**一串要排除的下标**」而不是「区间取反」，
 * 依据是语料里的**非单调**写法（`!0:3:-1:-2`、`!0:-1:-2`）—— 当区间根本读不出来。
 *
 * 书源不进仓库，dump 路径由环境变量给，整组默认跳过：
 *
 *   SOURCES_DUMP=sources-current.json npx vitest run test/bangIndex.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { parseIndexExpr } from '../src/engine/jsoup'
import { loadSourceDump, ruleFieldsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

const LIST_FIELDS = new Set(['ruleSearch.bookList', 'ruleExplore.bookList', 'ruleToc.chapterList'])

/**
 * 抠出真正的「排除下标」：`!` 后面紧跟数字（可带 `-`），之后只允许 `-:,\d`
 *
 * 这个形状**故意**排掉了 JS 里的 `!=`、CSS 里的 `!important` —— 那些 `!` 后面不是数字。
 */
function bangsOf(text: string): string[] {
    const out: string[] = []
    const re = /[A-Za-z_\])](!-?\d(?:[-:,\d]*\d)?)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) out.push(m[1]!)
    return out
}

const sources = DUMP === '' ? [] : loadSourceDump(DUMP)
const describeOrSkip = DUMP === '' ? describe.skip : describe

describeOrSkip('规则里的 `!` 排除下标（全量账本）', () => {
    const all: Array<{ source: string; path: string; bang: string }> = []
    for (const source of sources) {
        for (const field of ruleFieldsOf(source)) {
            const list = LIST_FIELDS.has(field.path)
            for (const bang of bangsOf(field.value)) {
                all.push({
                    source: `${String(source.bookSourceName)}${list ? ' [列表]' : ''}`,
                    path: field.path,
                    bang,
                })
            }
        }
    }
    const listHits = all.filter((h) => h.source.endsWith('[列表]'))

    it('dump 读得进来', () => {
        expect(sources.length).toBeGreaterThan(100)
        expect(all.length).toBeGreaterThan(150)
        expect(listHits.length).toBeGreaterThan(100)
    })

    it('每一处 `!` 引擎都解析得出来：出现读不出的新形状就失败', () => {
        const missed = all.filter((h) => parseIndexExpr(h.bang) === null)
        expect(missed.map((h) => `${h.source} ${h.path} :: ${h.bang}`)).toEqual([])
    })

    it('`!` 那一支读成「排除一串下标」，不是区间取反', () => {
        // 非单调的写法只有「一串下标」读得出来 —— 这是判据的来源，钉住它
        expect(parseIndexExpr('!0:3:-1:-2')).toEqual({ excludes: [0, 3, -1, -2] })
        expect(parseIndexExpr('!0:-1:-2')).toEqual({ excludes: [0, -1, -2] })
        // `,` 与 `:` 都是分隔符（两种写法语料里都有）
        expect(parseIndexExpr('!1,3')).toEqual(parseIndexExpr('!1:3'))
    })

    it('列表规则上占大头（110 处），是本轮真正解掉的那一批', () => {
        expect(listHits.length).toBeGreaterThanOrEqual(105)
    })
})
