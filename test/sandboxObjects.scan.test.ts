/**
 * 真实书源全量扫描：五个**对象全局**（source / book / chapter / cookie / cache）用到的方法
 *
 * 方法与第五十二轮 `javaSurface.scan.test.ts` 同一套：**「语料用到的名字」减「沙箱里有的名字」
 * 必须为空**。非空时，多出来的那个名字在沙箱里就是 `undefined`，书源一调就得到
 * `TypeError: not a function` —— 它不说**是哪一个**，而 `cleanCache()` 这种一行看不出问题。
 *
 * 与 java 那一边唯一的区别：这些对象是手写在预置里的，没有生成关系，
 * 所以「表 ↔ 实现」由 `test/sandboxObjects.test.ts`（永远跑）核，
 * 这里只核「表 ↔ 语料」。两边合起来才是闭环。
 *
 *   SOURCES_DUMP=sources.json npx vitest run test/sandboxObjects.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { loadSourceDump, scriptTextsOf } from './sourceDump'
import { SANDBOX_OBJECTS } from './sandboxSurface'

const DUMP = process.env.SOURCES_DUMP ?? ''

/** 对象名 → 方法名 → 处数 + 用到它的源名。**在用例里调用**（dump 只在开了 SOURCES_DUMP 时才读） */
function usageOf(): {
    sourceCount: number
    usage: Map<string, Map<string, { count: number; sources: Set<string> }>>
} {
    const sources = loadSourceDump(DUMP)
    const objects = Object.keys(SANDBOX_OBJECTS)
    const usage = new Map<string, Map<string, { count: number; sources: Set<string> }>>()
    for (const source of sources) {
        const name = String(source.bookSourceName ?? '?')
        for (const text of scriptTextsOf(source)) {
            for (const object of objects) {
                const pattern = new RegExp(`\\b${object}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g')
                for (const match of text.matchAll(pattern)) {
                    const method = match[1]!
                    const inner = usage.get(object) ?? new Map()
                    const entry = inner.get(method) ?? { count: 0, sources: new Set<string>() }
                    entry.count += 1
                    entry.sources.add(name)
                    inner.set(method, entry)
                    usage.set(object, inner)
                }
            }
        }
    }
    return { sourceCount: sources.length, usage }
}

describe.skipIf(DUMP === '')('真实书源全量扫描：对象全局用到的方法都在表里', () => {
    it('语料用到的每个方法，要么沙箱里有、要么在表里写明「故意不做」', () => {
        const { sourceCount, usage } = usageOf()
        const problems: string[] = []

        console.log(`书源 ${sourceCount} 条`)
        for (const [object, surface] of Object.entries(SANDBOX_OBJECTS)) {
            const used = usage.get(object) ?? new Map()
            const known = new Set([...surface.methods, ...Object.keys(surface.notDone)])
            const unknown = [...used.entries()]
                .filter(([method]) => !known.has(method))
                .sort((a, b) => b[1].count - a[1].count)

            console.log(
                `  ${object.padEnd(8)} 用到 ${String(used.size).padStart(2)} 个方法 / 沙箱里有 ${surface.methods.length} 个 / 明知不做 ${Object.keys(surface.notDone).length} 个`,
            )
            for (const [method, entry] of unknown) {
                const line = `${object}.${method} ${entry.count} 处 / ${entry.sources.size} 源  ${[...entry.sources].slice(0, 3).join(', ')}`
                console.log(`      未登记：${line}`)
                problems.push(line)
            }
        }

        expect(
            problems,
            '有新名字冒出来时要决定它是「实现」还是「明知不做（并写明理由）」',
        ).toEqual([])
    })

    /**
     * 账本：表里写着「故意不做」的那些名字
     *
     * 这份名单要能**自己过期**：一个名字如果语料里已经不再出现，就该从表里删掉
     * （留着会让人以为还有源在用）。反过来，名单一空就说明「对象全局这条线收口了」。
     */
    it('账本：故意不做的那些（名字 → 为什么），并且都还在语料里用着', () => {
        const { usage } = usageOf()
        let total = 0
        for (const [object, surface] of Object.entries(SANDBOX_OBJECTS)) {
            const used = usage.get(object) ?? new Map()
            for (const [method, reason] of Object.entries(surface.notDone)) {
                const entry = used.get(method)
                console.log(
                    `  ${`${object}.${method}`.padEnd(24)} ${String(entry?.count ?? 0).padStart(4)} 处  ${reason}`,
                )
                expect(entry, `${object}.${method} 已经没人用了，该从表里删掉`).toBeTruthy()
                total += 1
            }
        }
        console.log(`  合计 ${total} 个`)
        expect(total).toBeGreaterThan(0)
    })
})
