/*
 * Node 适配器的集成测试
 *
 * 它测的是**真的那个实现**（不是「假 D1」）：每一个用例都开一个临时 SQLite 文件、
 * 跑真 SQL、用真文件系统。之所以能这么测，是因为 `platform/node.ts` **不碰 WASM**
 * —— 那一句静态 `.wasm` import 还在 `platform/wasm.ts` 里，只有 Workers 的构建认它
 * （见 `scripts/build-node.mjs` 的替换插件）。这也是「把平台差异关进 platform/」
 * 这笔账第一次真的还上了：第二个适配器可以独立于沙箱单测。
 *
 * 用例全部来自**真实调用方**踩过的地方，而不是我编的 API 形状：
 *
 *   - `batch()` 里写语句的 `meta.changes`：`setSourceEnabled` / `setSourcesEnabled` /
 *     `revokeSession` 都拿它判「到底改到没有」。第一版实现里 `batch` 一律走 `all()`，
 *     于是写语句的 `changes` 恒为 0 —— 数据改了，接口却报「找不到书源」。
 *   - `.bind()` 的布尔：SQLite 没有布尔类型，`node:sqlite` 直接抛错，
 *     而 `importSources` 那条路上会绑 `true/false`。
 *   - 缓存的 `put/match` 语义：Cache API 是「收完体存字节、每次 `match` 给一份新的」。
 *     早先这里存 `response.clone()`（一根**活的流**），第一趟取图正常、之后同一张图
 *     一律 500（`Response.clone: Body has already been consumed.`）。
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { nodeEnv, type NodeAppEnv } from '../src/platform/node'

const opened: NodeAppEnv[] = []

/** 开一个临时库 + 一张小表（每个用例一份，互不干扰） */
function fresh(): NodeAppEnv {
    const dir = mkdtempSync(join(tmpdir(), 'rc-node-'))
    const env = nodeEnv({ dbPath: join(dir, 'test.sqlite'), publicRoot: dir })
    env.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, n INTEGER, flag INTEGER)')
    opened.push(env)
    return env
}

afterEach(() => {
    for (const env of opened.splice(0)) env.close()
})

describe('Node 适配器：数据库', () => {
    it('run 给 changes 与 last_row_id', async () => {
        const env = fresh()
        const insert = await env.DB.prepare('INSERT INTO t (id, name, n) VALUES (?, ?, ?)')
            .bind('a', '甲', 1)
            .run()
        expect(insert.success).toBe(true)
        expect(insert.meta.changes).toBe(1)
        expect(insert.meta.last_row_id).toBeGreaterThan(0)

        const hit = await env.DB.prepare('UPDATE t SET n = ? WHERE id = ?').bind(2, 'a').run()
        expect(hit.meta.changes).toBe(1)

        // 没命中就是 0 —— 调用方（`setSourceEnabled`）靠这个判「这条源在不在」
        const miss = await env.DB.prepare('UPDATE t SET n = ? WHERE id = ?').bind(3, 'zzz').run()
        expect(miss.meta.changes).toBe(0)
    })

    it('batch 里写语句也要给出 changes（D1 那边也是这么统一的）', async () => {
        const env = fresh()
        await env.DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('a', '甲').run()

        const [updated, second] = await env.DB.batch([
            env.DB.prepare('UPDATE t SET name = ? WHERE id = ?').bind('乙', 'a'),
            env.DB.prepare('SELECT name FROM t WHERE id = ?').bind('a'),
        ])
        expect(updated?.meta.changes).toBe(1)
        expect(second?.results).toEqual([{ name: '乙' }])
    })

    it('batch 是「要么全成要么全不成」', async () => {
        const env = fresh()
        await expect(
            env.DB.batch([
                env.DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('a', '甲'),
                // 主键冲突：整批都该回滚
                env.DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('a', '再来一次'),
            ]),
        ).rejects.toThrow()

        const rows = await env.DB.prepare('SELECT id FROM t').all<{ id: string }>()
        expect(rows.results).toEqual([])
    })

    it('布尔折成 1/0（SQLite 没有布尔，直接绑 true 会抛错）', async () => {
        const env = fresh()
        await env.DB.prepare('INSERT INTO t (id, name, flag) VALUES (?, ?, ?)')
            .bind('a', '甲', true)
            .run()
        await env.DB.prepare('INSERT INTO t (id, name, flag) VALUES (?, ?, ?)')
            .bind('b', '乙', false)
            .run()
        const rows = await env.DB.prepare('SELECT id, flag FROM t ORDER BY id').all<{
            flag: number
        }>()
        expect(rows.results).toEqual([
            { id: 'a', flag: 1 },
            { id: 'b', flag: 0 },
        ])
    })

    it('first 带列名 / 不带列名 / 查不到', async () => {
        const env = fresh()
        await env.DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('a', '甲').run()

        const row = await env.DB.prepare('SELECT id, name FROM t WHERE id = ?')
            .bind('a')
            .first<{ id: string; name: string }>()
        expect(row).toEqual({ id: 'a', name: '甲' })

        const column = await env.DB.prepare('SELECT name FROM t WHERE id = ?').bind('a').first<string>('name')
        expect(column).toBe('甲')

        const none = await env.DB.prepare('SELECT name FROM t WHERE id = ?').bind('nope').first()
        expect(none).toBeNull()
    })

    it('bind 之后互不影响（同一个 prepare 出来的语句可以重复 bind）', async () => {
        const env = fresh()
        const statement = env.DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)')
        await statement.bind('a', '甲').run()
        await statement.bind('b', '乙').run()
        const rows = await env.DB.prepare('SELECT id FROM t ORDER BY id').all<{ id: string }>()
        expect(rows.results).toEqual([{ id: 'a' }, { id: 'b' }])
    })
})

describe('Node 适配器：静态资源与缓存', () => {
    it('静态资源按扩展名给 content-type，找不到给 404', async () => {
        const env = fresh()
        const dir = mkdtempSync(join(tmpdir(), 'rc-assets-'))
        writeFileSync(join(dir, 'a.js'), 'console.log(1)')
        const withAssets = nodeEnv({ dbPath: join(dir, 'x.sqlite'), publicRoot: dir })
        opened.push(withAssets)

        const hit = await withAssets.ASSETS.fetch(new Request('http://x/a.js'))
        expect(hit.status).toBe(200)
        expect(hit.headers.get('content-type')).toContain('text/javascript')

        const miss = await withAssets.ASSETS.fetch(new Request('http://x/nope.js'))
        expect(miss.status).toBe(404)

        // `..` 不能爬出资源目录
        const climb = await withAssets.ASSETS.fetch(new Request('http://x/../secret.txt'))
        expect(climb.status).toBe(404)
        void env
    })

    it('缓存：存进去的是字节，反复 match 都读得到（哪怕源响应是流、且已被读走）', async () => {
        const env = fresh()
        const request = new Request('http://x/media/1.png')

        /**
         * 照**真实时序**来：媒体代取那条路交给 `put` 的不是一个自足的响应，
         * 而是「上游响应的一次 `clone()` 出来的分支」（见 `index.ts` 的 `/api/media`），
         * 而且原始那份紧接着就会被写回给客户端。早先这里直接存 `response.clone()`，
         * 于是**第二趟**请求去 `match` 时抛 `Body has already been consumed.` ——
         * 表现是「第一张图好好的，之后同一张图一律 500」。
         */
        const bytes = new Uint8Array([1, 2, 3])
        const upstream = new Response(bytes)
        const response = new Response(upstream.body, { status: 200 })
        const stored = new Response(response.clone().body, {
            status: response.status,
            headers: { 'content-type': 'image/png' },
        })
        await env.CACHE.put(request, stored)
        // 客户端那一份被读走（真实世界里它由服务器的写响应读掉）
        await response.arrayBuffer()

        for (const round of [1, 2, 3]) {
            const hit = await env.CACHE.match(request)
            expect(hit?.status, `第 ${round} 次`).toBe(200)
            expect(hit?.headers.get('content-type'), `第 ${round} 次`).toBe('image/png')
            expect(new Uint8Array(await hit!.arrayBuffer()), `第 ${round} 次`).toEqual(bytes)
        }

        const none = await env.CACHE.match(new Request('http://x/media/2.png'))
        expect(none).toBeUndefined()
    })
})
