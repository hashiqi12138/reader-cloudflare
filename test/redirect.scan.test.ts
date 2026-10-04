/**
 * 真实书源全量扫描：谁在读 `Location`（第五十五轮那一笔的依据）
 *
 * `fetch` 的 `redirect: 'follow'` 会把中间响应整份吃掉 —— 于是书源写
 * `java.post(url, body, {}).header('location')` 拿到的永远是空串。
 * 那些源拿这个 `Location` **找真正的搜索页地址**（站点把 POST 的 302 指向结果页），
 * 空串之后它们只会拿一个空地址去请求。
 *
 * 这一条账本量的是**这件事影响面有多大**：哪些源在读、写在哪个字段里、
 * 以及那条写法是不是「先取网、再读头」（不是的话它读的就是空气，与重定向无关）。
 *
 *   SOURCES_DUMP=sources.json npx vitest run test/redirect.scan.test.ts
 */

import { describe, expect, it } from 'vitest'

import { loadSourceDump, RULE_GROUPS } from './sourceDump'

const DUMP = process.env.SOURCES_DUMP ?? ''

/** 读响应头里的 Location（大小写与单复数都认，书源里三种写法都有） */
const READ_LOCATION = /headers?\s*\(\s*['"`]\s*[Ll]ocation/i

/** 同一段脚本里有没有取网 —— 「先取网、再读头」才读得到东西 */
const REQUEST = /\bjava\.(?:ajax|get|post|connect)\s*\(/

interface Hit {
    source: string
    path: string
    /** 那段脚本里取网了没有 */
    requests: boolean
}

function hitsOf(): Hit[] {
    const hits: Hit[] = []
    for (const source of loadSourceDump(DUMP)) {
        const name = String(source.bookSourceName ?? '?')
        const fields: { path: string; value: string }[] = []
        for (const key of ['jsLib', 'loginUrl', 'searchUrl', 'exploreUrl']) {
            const value = source[key]
            if (typeof value === 'string' && value !== '') fields.push({ path: key, value })
        }
        for (const group of RULE_GROUPS) {
            const rule = source[group]
            if (!rule || typeof rule !== 'object') continue
            for (const [field, value] of Object.entries(rule)) {
                if (typeof value === 'string' && value !== '') {
                    fields.push({ path: `${group}.${field}`, value })
                }
            }
        }
        for (const { path, value } of fields) {
            if (!READ_LOCATION.test(value)) continue
            hits.push({ source: name, path, requests: REQUEST.test(value) })
        }
    }
    return hits
}

describe.skipIf(DUMP === '')('真实书源全量扫描：读 Location 的源', () => {
    it('每一处都在「先取网、再读头」的写法里（否则它读的是空气）', () => {
        const hits = hitsOf()
        console.log(
            `读 Location 的地方：${hits.length} 处 / ${new Set(hits.map((h) => h.source)).size} 源`,
        )
        for (const hit of hits) console.log(`    ${hit.source}  [${hit.path}]`)

        expect(
            hits.filter((hit) => !hit.requests),
            '这些地方读了 Location 却没有取网 —— 那与我们跟不跟重定向无关',
        ).toEqual([])
        expect(
            hits.length,
            '一处都没有时，本引擎为「交回第一跳 Location」做的那个特例就该重新评估',
        ).toBeGreaterThan(0)
    })

    it('账本：都在 URL 脚本（searchUrl）里 —— 那正是取网与读头写在同一个表达式里的地方', () => {
        const hits = hitsOf()
        const byPath = new Map<string, number>()
        for (const hit of hits) byPath.set(hit.path, (byPath.get(hit.path) ?? 0) + 1)
        console.log('  按字段：', [...byPath.entries()].map(([p, n]) => `${p}=${n}`).join('  '))
        expect(hits.every((hit) => hit.path === 'searchUrl')).toBe(true)
    })
})
