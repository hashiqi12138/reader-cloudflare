/**
 * 真实书源全量扫描：脚本里用到的 `java.*` 名字，兼容层表里都有登记
 *
 * 为什么单列一条账本
 * ------------------
 * `JAVA_SURFACE`（`src/engine/platform.ts`）里**没有**的名字，在沙箱里就是 `undefined` ——
 * 书源一调就得到 QuickJS 那句 `TypeError: not a function`：它不说**是哪一个**，
 * 几十行的 jsLib 里根本定位不到（第四十九轮那条 `Symbol.iterator`、第五十一轮那条
 * `getLoginInfoMap` 都是这个形状：报错把人往「引擎坏了」的方向带）。
 *
 * 表里的三种登记都有各自的用处：
 *   - `implemented`  真实现了
 *   - `absent`       上游有、本平台没有 → 生成**带名字**的桩（`java.xxx：本引擎没有这个能力（…）`）
 *   - `keep-absent`  故意不定义（有书源靠 `typeof` 探测它来选分支）
 *
 * 所以「语料用到的名字」减「表里登记的名字」**必须为空**：出现新名字时，
 * 就该明确决定它属于哪一类，而不是让它悄悄变成一个 `not a function`。
 *
 *   SOURCES_DUMP=sources.json npx vitest run test/javaSurface.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { JAVA_SURFACE } from '../src/engine/platform'
import { loadSourceDump, scriptTextsOf } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

/** 名字 → 处数 + 用到它的源名。**在用例里调用**（dump 只在开了 SOURCES_DUMP 时才读） */
function usageOf(): {
    sourceCount: number
    usage: Map<string, { count: number; sources: Set<string> }>
} {
    const sources = loadSourceDump(DUMP)
    const usage = new Map<string, { count: number; sources: Set<string> }>()
    for (const source of sources) {
        const name = String(source.bookSourceName ?? '?')
        for (const text of scriptTextsOf(source)) {
            for (const match of text.matchAll(/\bjava\.([A-Za-z_$][\w$]*)\s*\(/g)) {
                const hit = match[1]!
                const entry = usage.get(hit) ?? { count: 0, sources: new Set<string>() }
                entry.count += 1
                entry.sources.add(name)
                usage.set(hit, entry)
            }
        }
    }
    return { sourceCount: sources.length, usage }
}

describe.skipIf(DUMP === '')('真实书源全量扫描：java.* 的用量都在兼容层表里', () => {
    it('语料用到的每一个 java.* 名字，表里都登记过（没有就是 not a function）', () => {
        const { sourceCount, usage } = usageOf()
        const registered = new Set(JAVA_SURFACE.map((m) => m.name))
        const unknown = [...usage.entries()]
            .filter(([hit]) => !registered.has(hit))
            .sort((a, b) => b[1].count - a[1].count)

        console.log(
            `书源 ${sourceCount} 条 / 语料用到 java.* 名字 ${usage.size} 个 / 表里登记 ${registered.size} 个`,
        )
        console.log('  未登记的：', unknown.length === 0 ? '（无）' : '')
        for (const [hit, entry] of unknown) {
            console.log(
                `    ${hit} ${entry.count} 处 / ${entry.sources.size} 源  ${[...entry.sources].slice(0, 3).join(', ')}`,
            )
        }

        expect(
            unknown.map(([hit]) => hit),
            '有新名字冒出来时要决定它是 implemented / absent / keep-absent',
        ).toEqual([])
    })

    /**
     * 账本：登记为 `absent`、而语料**真的在用**的那些
     *
     * 这一份名单就是「挡着源的是哪种平台能力」的清单 —— 换平台（比如将来真接一个
     * 带 WebView 的运行时）时就按它来排优先级。
     */
    it('账本：absent 里语料在用的那一批（挡着源的平台能力）', () => {
        const { usage } = usageOf()
        const support = new Map(JAVA_SURFACE.map((m) => [m.name, m.support]))
        const absentUsed = [...usage.entries()]
            .filter(([hit]) => support.get(hit) === 'absent')
            .sort((a, b) => b[1].count - a[1].count)

        console.log(`  登记为 absent 且语料在用：${absentUsed.length} 个`)
        for (const [hit, entry] of absentUsed) {
            console.log(
                `    ${hit.padEnd(24)} ${String(entry.count).padStart(4)} 处 / ${String(entry.sources.size).padStart(3)} 源`,
            )
        }

        // WebView 那一族确实被大量使用 —— 这条钉住「面里为什么必须有它」
        for (const hit of ['webView', 'startBrowser', 'startBrowserAwait']) {
            expect(usage.has(hit), `${hit} 应当在语料里被用到`).toBe(true)
        }
        expect(absentUsed.length).toBeGreaterThan(0)
    })
})
