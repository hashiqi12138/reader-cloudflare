/**
 * 真实书源全量扫描：`cookie.*` 的用量与 `enabledCookieJar` 对不对得上
 *
 * 第五十四轮给 cookie 罐接上了「收 / 发 / 存」，但**只有开了 `enabledCookieJar`
 * 的书源才建罐子**（816 条里 457 条开着、359 条作者明确关掉了）。于是有一条
 * 必须钉住的性质：
 *
 *   **靠站点下发 cookie 才能干活的那一类源，开关必须是开着的。**
 *
 * 判据是「只读不写」：只用 `cookie.getCookie` / `cookie.getKey`、
 * 从不 `setCookie` / `replaceCookie` / `removeCookie` —— 那说明它读的东西
 * **不可能来自它自己写的**，只能来自站点。这一批要是关着开关，它读到的永远是空串，
 * 而症状只是「某个字段取不到」，不会报任何错。
 *
 *   SOURCES_DUMP=sources.json npx vitest run test/cookieJar.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { loadSourceDump, scriptTextsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

/** 会写罐子的那几个；不含它们就说明这个源只是**读** */
const WRITES = ['setCookie', 'replaceCookie', 'removeCookie']
const READS = ['getCookie', 'getKey']

interface Usage {
    /** 这个源调了几次某个方法 */
    count: (method: string) => number
    on: boolean
    name: string
}

function usageOf(): { sources: Usage[]; total: number } {
    const sources = loadSourceDump(DUMP).map((source) => {
        const counts = new Map<string, number>()
        for (const text of scriptTextsOf(source)) {
            for (const method of [...READS, ...WRITES]) {
                const hit = (text.match(new RegExp(`\\bcookie\\.${method}\\s*\\(`, 'g')) ?? [])
                    .length
                if (hit > 0) counts.set(method, (counts.get(method) ?? 0) + hit)
            }
        }
        return {
            name: String(source.bookSourceName ?? '?'),
            on: source.enabledCookieJar === true,
            count: (method: string) => counts.get(method) ?? 0,
        }
    })
    return { sources, total: sources.length }
}

describe.skipIf(DUMP === '')('真实书源全量扫描：cookie 罐与 enabledCookieJar', () => {
    it('只读 cookie 的源（靠站点下发）必须开着开关 —— 否则它读到的永远是空串', () => {
        const { sources, total } = usageOf()
        const used = sources.filter((s) => [...READS, ...WRITES].some((m) => s.count(m) > 0))
        const readOnly = used.filter(
            (s) => READS.some((m) => s.count(m) > 0) && WRITES.every((m) => s.count(m) === 0),
        )
        const offenders = readOnly.filter((s) => !s.on).map((s) => s.name)

        console.log(
            `书源 ${total} 条，用到 cookie.* 的 ${used.length} 条；其中只读的 ${readOnly.length} 条`,
        )
        for (const s of readOnly) console.log(`    只读：${s.name}（开关 ${s.on ? '开' : '关！'}）`)
        console.log('  关着开关却用了 cookie.* 的（不止读的）：')
        for (const s of used.filter((x) => !x.on)) console.log(`    ${s.name}`)

        expect(
            readOnly.length,
            '一条只读的源都没有时，这条账本就空转了 —— 判据要重新看一眼',
        ).toBeGreaterThan(0)
        expect(
            offenders,
            '这些源只读 cookie（只能来自站点），却关掉了 enabledCookieJar —— 它们读到的永远是空串',
        ).toEqual([])
    })

    it('账本：`enabledCookieJar` 的分布与各方法的用量', () => {
        const { sources, total } = usageOf()
        const on = sources.filter((s) => s.on).length
        console.log(`  enabledCookieJar：true=${on} / false=${total - on}`)
        for (const method of [...READS, ...WRITES, 'getCookieMap']) {
            const onCount = sources.reduce((sum, s) => sum + (s.on ? s.count(method) : 0), 0)
            const offCount = sources.reduce((sum, s) => sum + (s.on ? 0 : s.count(method)), 0)
            console.log(`    cookie.${method.padEnd(14)} 开=${onCount} 关=${offCount}`)
        }
        // 开关是书源作者表过态的，两边都该有人 —— 全开或全关说明这个字段被我们读错了
        expect(on).toBeGreaterThan(0)
        expect(on).toBeLessThan(total)
    })
})
