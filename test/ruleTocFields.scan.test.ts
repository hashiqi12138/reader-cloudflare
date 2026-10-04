/**
 * 真实书源全量扫描：目录规则里的字段，哪些取了、哪些明确不取
 *
 * `ruleToc` 不是只有「列表 / 章节名 / 章节地址 / 翻页」四样。第五十六轮量了一遍：
 * 除了那四样，语料里还有 `isVip`（45 源）/ `updateTime`（74 源）/ `isVolume`（25 源）/
 * `isPay`（7 源）/ `preUpdateJs`（5 源）—— 而引擎**一个都没取**。
 *
 * 这就是第四十九轮那个形状的重演：规则产出了东西，引擎不读，症状是
 * 「目录里看不出哪一章要钱、也看不到卷」，**不报任何错**。
 *
 * 所以这条账本钉两件事：
 *   1. 语料里出现的每一个 `ruleToc` 字段名，要么在「取了」的单子里、
 *      要么在「明确不取」的单子里（连理由）—— 不许有没人认领的名字
 *   2. 逐条字段（那四个）里**确实有需要脚本求值的** —— `MAX_MARKED_CHAPTERS`
 *      那个上限的取舍就建立在这一点上；一个都没有时，那个上限就该重新评估
 *
 *   SOURCES_DUMP=sources.json npx vitest run test/ruleTocFields.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { loadSourceDump } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

/** 引擎**取**的目录字段 */
const TAKEN = new Set([
    'chapterList',
    'chapterName',
    'chapterUrl',
    'nextTocUrl',
    'isVip',
    'isPay',
    'isVolume',
    'updateTime',
])

/** 明确**不取**的：名字 → 为什么不取 */
const IGNORED: Record<string, string> = {
    preUpdateJs:
        'App 侧「更新目录前跑一段脚本」——语料 5 处都在调 java.refreshTocUrl() 或改 book.bookUrl，' +
        '本引擎没有那套「更新目录」流程，登记着不留（真要用得连那个流程一起做）',
}

/** 逐条求值的那四个（`chapterName` 同层，每条一次） */
const PER_CHAPTER = ['isVip', 'isPay', 'isVolume', 'updateTime']

/** 这四条里，规则本身要不要进沙箱（选择器求值不走沙箱，`@js:` / `{{}}` 才走） */
const NEEDS_SANDBOX = /@js:|<js[\s>]|\{\{/

interface FieldStat {
    sources: number
    sandbox: number
    samples: string[]
}

function statsOf(): Map<string, FieldStat> {
    const stats = new Map<string, FieldStat>()
    for (const source of loadSourceDump(DUMP)) {
        const toc = source.ruleToc
        if (!toc || typeof toc !== 'object') continue
        for (const [field, value] of Object.entries(toc as Record<string, unknown>)) {
            if (typeof value !== 'string' || value.trim() === '') continue
            const stat = stats.get(field) ?? { sources: 0, sandbox: 0, samples: [] }
            stat.sources += 1
            if (NEEDS_SANDBOX.test(value)) stat.sandbox += 1
            if (stat.samples.length < 2)
                stat.samples.push(`${source.bookSourceName}：${value.slice(0, 60)}`)
            stats.set(field, stat)
        }
    }
    return stats
}

describe.skipIf(DUMP === '')('真实书源全量扫描：目录规则里的字段', () => {
    it('每一个出现过的字段名都被认领了（取了，或明确不取并写明理由）', () => {
        const stats = statsOf()
        const ownerless = [...stats.keys()].filter((f) => !TAKEN.has(f) && !(f in IGNORED))

        console.log('目录字段分布（源数 / 其中要走沙箱的）：')
        for (const [field, stat] of [...stats].sort((a, b) => b[1].sources - a[1].sources)) {
            const mark = TAKEN.has(field) ? '取' : '不取'
            console.log(
                `    ${field.padEnd(14)} ${String(stat.sources).padStart(4)} 源  沙箱 ${String(stat.sandbox).padStart(3)}  [${mark}]`,
            )
            for (const sample of stat.samples) console.log(`        ${sample}`)
        }
        for (const [field, reason] of Object.entries(IGNORED)) {
            console.log(`    不取 ${field}：${reason}`)
        }

        expect(ownerless, '有新字段冒出来时要决定它是「取」还是「明确不取（并写明理由）」').toEqual(
            [],
        )
    })

    it('逐条字段里确实有需要脚本求值的 —— 上限那个取舍就建立在这上面', () => {
        const stats = statsOf()
        const perChapter = PER_CHAPTER.filter((f) => stats.has(f))
        const sandboxBound = perChapter.filter((f) => (stats.get(f)?.sandbox ?? 0) > 0)

        console.log(`  逐条字段：${perChapter.join(' / ')}`)
        console.log(
            `  其中规则本身要走沙箱的：${sandboxBound.join(' / ')} —— 一条一次求值 × 章的条数`,
        )

        expect(perChapter.length, '一个逐条字段都没有时，这条账本该重新看一眼').toBeGreaterThan(0)
        expect(
            sandboxBound.length,
            '没有任何逐条字段需要沙箱求值的话，MAX_MARKED_CHAPTERS 那个上限就该删掉',
        ).toBeGreaterThan(0)
    })
})
