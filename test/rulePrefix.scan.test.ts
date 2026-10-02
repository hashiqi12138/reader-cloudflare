/**
 * 用**真实书源集合**全量校验：规则前缀的识别
 *
 * 单测（`directives.test.ts` / `rulePrefix.test.ts`）钉的是已知形态，
 * 说不出「线上还有没有别的写法漏网」。这个扫描把整个集合的每条规则都过一遍，
 * 断言两件事：
 *
 *   1. **规则开头/连接符段首**出现的 `@css:` / `@json:` / `@js:` / `@xpath:`
 *      不管大小写，都必须被 `matchDirective` 认出来。认不出来的后果是**静默返回空**
 *      （会被当成 JSOUP 简写去解析），线上 61 处规则开头就是这么坏掉的。
 *   2. 认出来的**只有**这四个指令：多认一个（比如把 `@get:` 当指令）就会改掉
 *      URL 字段的语义。所以顺带把出现的指令名全列出来人工过目。
 *
 * 与连接符那个扫描一样，它需要一份书源 dump，而书源不进仓库，所以默认整组跳过：
 *
 *   SOURCES_DUMP=sources.json npx vitest run test/rulePrefix.scan.test.ts
 */

import { describe, expect, it } from 'vitest'
import { indexOfJsMarker, JS_MARKER, matchDirective, ruleHasJs } from '../src/engine/directives'
import { JOINERS, loadSourceDump, rulesOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

/** 规则里出现的 `@xxx:` 的统称形态（不限于我们认的那四个） */
const ANY_DIRECTIVE_LIKE = /^@[A-Za-z]+:/

describe.skipIf(DUMP === '')('真实书源全量扫描：规则前缀的大小写与集合', () => {
    it('四个指令的大小写写法全部认出来，且不会误认别的 @xxx:', () => {
        const sources = loadSourceDump(DUMP)

        const headNames = new Map<string, number>()
        const unmatched: string[] = []
        /** 规则里出现、但我们**不**认成指令的 `@xxx:`（URL 字段的方法标记等） */
        const notDirective = new Map<string, number>()

        let ruleHeads = 0
        let nonLowercase = 0

        for (const source of sources) {
            const name = String(source.bookSourceName ?? '?')
            for (const rule of rulesOf(source)) {
                // 连接符两边各是一段独立的规则，段首才是分派看的位置
                const segments = JOINERS.reduce<string[]>(
                    (acc, joiner) => acc.flatMap((part) => part.split(joiner)),
                    [rule],
                )
                for (const segment of segments) {
                    const head = segment.trim().match(ANY_DIRECTIVE_LIKE)
                    if (!head) continue
                    ruleHeads += 1

                    const token = head[0]
                    if (token !== token.toLowerCase()) nonLowercase += 1

                    const matched = matchDirective(segment.trim())
                    if (!matched) {
                        notDirective.set(token, (notDirective.get(token) ?? 0) + 1)
                        continue
                    }
                    headNames.set(matched.name, (headNames.get(matched.name) ?? 0) + 1)
                    // 认出来之后必须真的能取到指令名（防止「匹配上了却解析出空」）
                    expect(matched.name).toBe(token.slice(1, -1).toLowerCase())
                }
            }
        }

        // 认不出来的那些只允许是「本来就不是选择器指令」的写法
        const KNOWN_NON_SELECTOR = ['@get:', '@post:', '@put:', '@head:', '@webjs:', '@regex:']
        const unexpected = [...notDirective].filter(
            ([token]) => !KNOWN_NON_SELECTOR.includes(token),
        )

        console.log(
            `书源 ${sources.length} 条 / 段首指令 ${ruleHeads} 处（非小写 ${nonLowercase} 处）`,
        )
        console.log(
            `  认出的指令：${[...headNames]
                .sort((a, b) => b[1] - a[1])
                .map(([key, count]) => `${key} ${count}`)
                .join(' / ')}`,
        )
        console.log(
            `  不认的 @xxx:：${
                [...notDirective].map(([key, count]) => `${key} ${count}`).join(' / ') || '（无）'
            }`,
        )

        expect(unexpected.map(([token]) => token)).toEqual([])
        // 扫描要有效：集合里确实存在非小写写法，否则这个测试会空过
        expect(nonLowercase).toBeGreaterThan(0)
        // 四个指令在集合里都出现过
        expect([...headNames.keys()].sort()).toEqual(['css', 'js', 'json', 'xpath'])
    })

    it('规则中间所有 `@js:` 标记都能找出来（选择器后面的 JS 尾巴）', () => {
        const sources = loadSourceDump(DUMP)

        let rulesWithMarker = 0
        let checked = 0
        let skipped = 0
        const mismatches: string[] = []

        for (const source of sources) {
            const name = String(source.bookSourceName ?? '?')
            for (const rule of rulesOf(source)) {
                const lower = rule.toLowerCase()
                // 参照实现：在小写副本上扫一遍。只在两者等长时用 ——
                // 个别 Unicode 字符转小写会变长（`'İ'.toLowerCase()` 是两个字符），下标就对不上了
                if (lower.length !== rule.length) {
                    skipped += 1
                    continue
                }
                const oracle = [...lower.matchAll(/@js:/g)].map((m) => m.index!)
                if (oracle.length === 0) continue

                rulesWithMarker += 1
                checked += 1

                const found: number[] = []
                for (let from = 0; ;) {
                    const at = indexOfJsMarker(rule, from)
                    if (at < 0) break
                    found.push(at)
                    from = at + JS_MARKER.length
                }

                if (found.join(',') !== oracle.join(',')) {
                    mismatches.push(
                        `${name} [期望 ${oracle.join(',')} 实得 ${found.join(',')}] ${rule
                            .replace(/\s+/g, ' ')
                            .slice(0, 120)}`,
                    )
                }
            }
        }

        console.log(
            `  含 @js: 标记的规则 ${rulesWithMarker} 处 / 逐条比对 ${checked} 处 / 跳过（大小写换算不等长）${skipped} 处`,
        )
        for (const line of mismatches.slice(0, 10)) console.log(`    ${line}`)

        // 扫描要有效：集合里确实有带 JS 尾巴的规则
        expect(rulesWithMarker).toBeGreaterThan(0)
        expect(mismatches).toEqual([])
    })

    it('`@json:` / `@xpath:` 不会被误判成「含 JS」（那会让合法的规则被沙箱拒掉）', () => {
        const sources = loadSourceDump(DUMP)

        let checked = 0
        const wrong: string[] = []

        for (const source of sources) {
            const name = String(source.bookSourceName ?? '?')
            for (const rule of rulesOf(source)) {
                const lower = rule.toLowerCase()
                // 独立参照：小写里既没有 @js: 也没有 <js 与 {{，就不该被判定为含 JS
                if (lower.includes('@js:') || lower.includes('<js') || rule.includes('{{')) continue
                checked += 1
                if (ruleHasJs(rule)) wrong.push(`${name} ${rule.slice(0, 120)}`)
            }
        }

        console.log(`  不含 JS 的规则 ${checked} 处 / 误判 ${wrong.length} 处`)
        for (const line of wrong.slice(0, 10)) console.log(`    ${line}`)

        expect(checked).toBeGreaterThan(0)
        expect(wrong).toEqual([])
    })
})
