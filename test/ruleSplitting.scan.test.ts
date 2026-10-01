/**
 * 用**真实书源集合**全量校验：连接符不会切进 JS 区域
 *
 * 为什么单靠 `ruleText.test.ts` 不够：那里面是几十条精选样例，能钉住已知形态，
 * 但说不出「线上 800 多条书源里还有没有漏网的」。这个扫描补的就是这一环 ——
 * 它把整个集合的每一条规则都过一遍。
 *
 * 它不是常规单测：需要一份书源集合，而**书源不进仓库**（见 README「关于书源」）。
 * 所以默认整组跳过，只在显式给环境变量时才跑：
 *
 *   # 先导出一份（wrangler --json 的原样输出即可，也接受裸数组）
 *   npx wrangler d1 execute reader-cloudflare --remote --json \
 *     --command "SELECT name, payload FROM sources" > sources.json
 *   SOURCES_DUMP=sources.json npx vitest run test/ruleSplitting.scan.test.ts
 *
 * 判据不是「有没有报错」—— 切碎经常**不报错**（切开的前半截往往仍是非空值，
 * 于是结果悄悄不对）。所以直接查**切点位置**：任何一个 JS 区域都必须完整落在
 * 某一个分片里。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findJsRegions, splitRuleText } from '../src/engine/ruleText'

const DUMP = process.env.SOURCES_DUMP ?? ''

const RULE_GROUPS = ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleExplore']
const URL_FIELDS = ['searchUrl', 'exploreUrl', 'header', 'jsLib', 'loginUrl']
const JOINERS = ['&&', '||', '%%'] as const

function rulesOf(source: Record<string, unknown>): string[] {
    const out: string[] = []
    for (const group of RULE_GROUPS) {
        const fields = source[group]
        if (fields && typeof fields === 'object') {
            for (const value of Object.values(fields))
                if (typeof value === 'string') out.push(value)
        }
    }
    for (const key of URL_FIELDS) {
        const value = source[key]
        if (typeof value === 'string' && value !== '') out.push(value)
    }
    return out
}

/** 兼容两种输入：`wrangler --json` 的原样输出，或书源数组本身 */
function loadSources(path: string): Record<string, unknown>[] {
    const raw = readFileSync(path, 'utf8')
    const json = JSON.parse(raw.slice(raw.indexOf('[')))
    const rows = Array.isArray(json) ? json : []
    if (
        rows.length > 0 &&
        typeof rows[0] === 'object' &&
        rows[0] !== null &&
        'payload' in rows[0]!
    ) {
        return rows.map((r) => JSON.parse(String((r as { payload: unknown }).payload)))
    }
    return json as Record<string, unknown>[]
}

describe.skipIf(DUMP === '')('真实书源全量扫描：连接符不切进 JS', () => {
    it('没有任何一个 JS 区域被连接符切开，也没有一条规则被过度保护', () => {
        const sources = loadSources(DUMP)

        let rules = 0
        let withJs = 0
        let connectorInsideJs = 0
        let splitRules = 0
        let splitWithJs = 0
        const cutInsideJs: string[] = []

        for (const source of sources) {
            const name = String(source.bookSourceName ?? '?')
            for (const rule of rulesOf(source)) {
                rules += 1
                const regions = findJsRegions(rule)
                if (regions.length > 0) withJs += 1

                // 「连接符落在 JS 区域内」的规则数 —— 修复真正保护的集合。
                // 不统计它的话，区域识别整个失效时下面的断言会**空过**。
                for (const joiner of JOINERS) {
                    const at = rule.indexOf(joiner)
                    if (at < 0) continue
                    if (regions.some((r) => at >= r.start && at < r.end)) {
                        connectorInsideJs += 1
                        break
                    }
                }

                for (const joiner of JOINERS) {
                    const parts = splitRuleText(rule, joiner)
                    if (!parts) continue
                    splitRules += 1
                    if (regions.length > 0) splitWithJs += 1

                    let offset = 0
                    const ranges = parts.map((part) => {
                        const start = offset
                        offset += part.length + joiner.length
                        return [start, start + part.length] as const
                    })
                    for (const region of regions) {
                        if (!ranges.some(([a, b]) => region.start >= a && region.end <= b)) {
                            cutInsideJs.push(
                                `${name} [${joiner}] ${rule.replace(/\s+/g, ' ').slice(0, 160)}`,
                            )
                        }
                    }
                }
            }
        }

        console.log(`书源 ${sources.length} 条 / 规则 ${rules} 处`)
        console.log(`  含 JS 区域的规则        ${withJs} 处`)
        console.log(`  连接符落在 JS 区域内的  ${connectorInsideJs} 处 ← 修复保护的集合`)
        console.log(
            `  会被切分的规则          ${splitRules} 处（其中 ${splitWithJs} 处同时含 JS 区域）`,
        )
        console.log(`  把 JS 区域切开的        ${cutInsideJs.length} 处`)
        for (const line of cutInsideJs.slice(0, 20)) console.log(`    ${line}`)

        // 扫描本身要有效：否则「0 处违规」可能只是因为一个区域都没识别出来
        expect(connectorInsideJs).toBeGreaterThan(0)
        expect(splitWithJs).toBeGreaterThan(0)
        expect(cutInsideJs).toEqual([])
    })
})
