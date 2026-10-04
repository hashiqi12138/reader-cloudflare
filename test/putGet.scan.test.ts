/**
 * 用**真实书源集合**全量校验：`@put:` / `@get:` / `ruleBookInfo.init`
 *
 * 这三样在语料里是**一件事**：`init` 求值一次（顶格 `@put:{…}` 或脚本里的 `java.put`），
 * 其余字段用 `@get:{键}` 读回来。线上：`@get:` 184 处 / 40 个源、`@put:` 52 处 / 46 个源、
 * `ruleBookInfo.init` 116 处 / 109 个源。
 *
 * 这份账本守四件事：
 *   ① 分布不变形
 *   ② 每一处 `@get:` 都是**单键**形状（`{键}`）—— 出现带括号 / 带冒号的写法就要人工看一次
 *   ③ 每一处 `@put:{…}` 的括号**配得平**、且每一对都有键有值
 *   ④ `init` 的写法分类不变形（选择器那类**本轮不覆盖**，数量要能看出来）
 *
 * 书源不进仓库，dump 路径由环境变量给，整组默认跳过：
 *
 *   SOURCES_DUMP=sources-current.json npx vitest run test/putGet.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { asGetSegment, splitPutDirectives } from '../src/engine/infoVars'
import { loadSourceDump, ruleFieldsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

const sources = DUMP === '' ? [] : loadSourceDump(DUMP)
const describeOrSkip = DUMP === '' ? describe.skip : describe

/** 抠出所有 `@get:{…}` 的正文（与实现无关，只看文本形状） */
function getBodies(text: string): string[] {
    const out: string[] = []
    const re = /@@?get:\s*\{([^{}]*)\}/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) out.push(m[1]!)
    return out
}

/** `init` 的写法分类（与实现无关） */
function initKind(init: string): string {
    const t = init.trim()
    if (/^@put:/.test(t)) return '顶格 @put:{…}'
    if (/^@js:/.test(t)) return '@js: 脚本'
    if (/^<js[\s>]/i.test(t)) return '<js> 块'
    if (/^(\$|\.|\[)/.test(t) || /^[A-Za-z_][\w.-]*$/.test(t)) return '选择器/路径（本轮不覆盖）'
    return '其它'
}

describeOrSkip('`@put:` / `@get:` / `init`（全量账本）', () => {
    const gets: Array<{ source: string; path: string; body: string }> = []
    const puts: Array<{ source: string; path: string; rule: string }> = []
    const inits: Array<{ source: string; kind: string }> = []

    for (const source of sources) {
        const name = String(source.bookSourceName)
        for (const field of ruleFieldsOf(source)) {
            for (const body of getBodies(field.value))
                gets.push({ source: name, path: field.path, body })
            if (/@put:/i.test(field.value))
                puts.push({ source: name, path: field.path, rule: field.value })
        }
        const init = (source.ruleBookInfo as { init?: string } | undefined)?.init
        if (typeof init === 'string' && init.trim() !== '')
            inits.push({ source: name, kind: initKind(init) })
    }

    it('dump 读得进来，三样的量级对得上', () => {
        expect(sources.length).toBeGreaterThan(100)
        expect(gets.length).toBeGreaterThanOrEqual(180)
        expect(puts.length).toBeGreaterThanOrEqual(50)
        expect(inits.length).toBeGreaterThanOrEqual(110)
    })

    it('每一处 `@get:` 都是单键形状', () => {
        // 带括号 / 带冒号的写法（`{a.b}`、`{k: v}`）在语料里一个都没有；
        // 出现就说明有新的写法，要人工判一次再登记
        const odd = gets.filter((g) => /[{}:]/.test(g.body))
        expect(odd.map((g) => `${g.source} ${g.path} :: ${g.body}`)).toEqual([])
        expect(gets.filter((g) => g.body.trim() === '')).toEqual([])
    })

    it('每一处 `@put:{…}` 括号都配得平，且每对都有键有值', () => {
        const broken: string[] = []
        for (const p of puts) {
            const { puts: pairs } = splitPutDirectives(p.rule)
            if (pairs.length === 0) broken.push(`${p.source} ${p.path} :: ${p.rule.slice(0, 60)}`)
            for (const pair of pairs) {
                if (pair.key.trim() === '' || pair.rule.trim() === '')
                    broken.push(`${p.source} ${p.path} :: 空键或空值`)
            }
        }
        expect(broken).toEqual([])
    })

    it('`init` 的写法分类不变形（选择器那类是**本轮不覆盖**的那批）', () => {
        const tally = new Map<string, number>()
        for (const i of inits) tally.set(i.kind, (tally.get(i.kind) ?? 0) + 1)
        // 只登记这五种；出现新写法就失败
        expect([...tally.keys()].sort()).toEqual(
            ['<js> 块', '@js: 脚本', '其它', '选择器/路径（本轮不覆盖）', '顶格 @put:{…}'].sort(),
        )
        // 「只取副作用」那三类合起来是这一轮真正覆盖的
        const covered = ['顶格 @put:{…}', '<js> 块', '@js: 脚本']
        const n = covered.reduce((sum, k) => sum + (tally.get(k) ?? 0), 0)
        expect(n).toBeGreaterThanOrEqual(60)
    })

    it('`@get:{键}` 整段才是「段」—— 嵌在文字里的不算（这一条钉住那条分界）', () => {
        expect(asGetSegment('@get:{a}')).toBe('a')
        expect(asGetSegment('编号：@get:{a}')).toBeNull()
    })
})
