/*
 * 更新记录的单元测试
 *
 * 这份记录最大的风险不是写错字，而是**三处版本号漂了**：
 * `wrangler.jsonc` 的 `ENGINE_VERSION`（界面真正显示的那个）、`package.json` 的 `version`、
 * 以及 `src/changelog.ts` 里最新的一条。它们不同步**不会报错**，只会让界面显示 0.53
 * 而实际跑着 0.52 —— 排查时对着错的版本找问题。
 *
 * 所以这里直接读那两个文件比对，而不是把版本号在测试里再抄一遍。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { CHANGELOG } from '../src/changelog'

/** `package.json` 带 BOM，`JSON.parse` 不认，先剥掉 */
const read = (name: string) =>
    readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replace(/^\uFEFF/, '')

const engineVersion = /"ENGINE_VERSION":\s*"([^"]+)"/.exec(read('wrangler.jsonc'))?.[1]
const packageVersion = (JSON.parse(read('package.json')) as { version: string }).version

/** 按点分段比大小：0.9.0 与 0.10.0 若按字符串比会得出反的结论 */
function compareVersion(left: string, right: string): number {
    const a = left.split('.').map(Number)
    const b = right.split('.').map(Number)
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0)
        if (diff !== 0) return diff
    }
    return 0
}

describe('更新记录', () => {
    it('不是空的', () => {
        expect(CHANGELOG.length).toBeGreaterThan(0)
    })

    it('最新那条的版本号与 ENGINE_VERSION 一致 —— 界面显示的就是它', () => {
        expect(engineVersion).toBeTruthy()
        expect(CHANGELOG[0]?.version).toBe(engineVersion)
    })

    it('最新那条的版本号与 package.json 一致', () => {
        expect(CHANGELOG[0]?.version).toBe(packageVersion)
    })

    it('每条的版本号都是 `数字.数字.数字`', () => {
        for (const one of CHANGELOG) {
            expect(one.version, one.version).toMatch(/^\d+\.\d+\.\d+$/)
        }
    })

    it('日期都是 `YYYY-MM-DD`', () => {
        for (const one of CHANGELOG) {
            expect(one.date, one.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
            expect(Number.isNaN(Date.parse(one.date)), one.date).toBe(false)
        }
    })

    it('每句话都不为空 —— 只有版本号的记录等于没写', () => {
        for (const one of CHANGELOG) {
            expect(one.note.trim().length, one.version).toBeGreaterThan(0)
        }
    })

    it('从新到旧严格递减，也没有重复的版本号', () => {
        // 严格递减本身就排除了重复：两条一样高会比出 0，而不是「大于」
        let previous = CHANGELOG[0]?.version ?? ''
        for (const one of CHANGELOG.slice(1)) {
            expect(
                compareVersion(previous, one.version),
                `${previous} 应当比 ${one.version} 新`,
            ).toBeGreaterThan(0)
            previous = one.version
        }
    })
})
