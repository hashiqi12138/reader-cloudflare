/*
 * 「哪些路径归接口」这一组前缀，四个地方各写了一遍 —— 它们必须**逐字一致**
 *
 *   | 谁                             | 写在哪                                | 干什么                                   |
 *   | ------------------------------ | ------------------------------------- | ---------------------------------------- |
 *   | 自建（Node）那一份             | `src/server/node.ts` 的 `WORKER_PREFIXES` | 进应用还是当静态资源                     |
 *   | Cloudflare 的接口那一份        | `wrangler.jsonc` 的 `assets.run_worker_first` | 先查静态资源还是先进 Worker              |
 *   | Cloudflare 的页面那一份        | `pages/_routes.json` + `pages/_worker.js` | 哪条路径进 Function / 哪条路径被反代     |
 *   | Docker 的页面那一份            | `page.nginx.conf` 的 location          | 哪条路径转给 api 容器                    |
 *
 * 这四个地方对不齐时，表现都是**同一个样子**：页面好好的，某一条路径却怎么都不通
 * （被当静态资源找了、或者反过来把页面请求转发给了接口）。没有一处会当场报错，
 * 所以这里直接读文件对账。
 *
 * 这也解释了为什么每一处都留着注释指向这一份清单 —— 改一处就得改四处。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

/** `/api/`、`/api`、`/api/*` 都归一成 `api`，好比较（先剥通配符，再剥两头的斜杠） */
const bare = (one: string) => one.replace(/^\/+/, '').replace(/\*+$/, '').replace(/\/+$/, '')

/** 自建那份：`const WORKER_PREFIXES = ['/api/', '/fixture/']` */
function fromNodeServer(): string[] {
    const raw = /const WORKER_PREFIXES = \[([^\]]*)\]/.exec(read('src/server/node.ts'))?.[1] ?? ''
    return raw
        .split(',')
        .map((one) => bare(one.trim().replace(/^['"]|['"]$/g, '')))
        .filter((one) => one !== '')
}

/** Cloudflare 接口那份：`run_worker_first: ["/api/*", "/fixture/*"]` */
function fromWrangler(): string[] {
    const raw = /"run_worker_first":\s*\[([^\]]*)\]/.exec(read('wrangler.jsonc'))?.[1] ?? ''
    return raw
        .split(',')
        .map((one) => bare(one.trim().replace(/^"|"$/g, '')))
        .filter((one) => one !== '')
}

/** Cloudflare 页面那份：`_routes.json` 的 include 与 `_worker.js` 的前缀数组 */
function fromPagesRoutes(): string[] {
    const parsed = JSON.parse(read('pages/_routes.json')) as { include: string[] }
    return parsed.include.map(bare)
}

function fromPagesWorker(): string[] {
    const raw = /const PROXY_PREFIXES = \[([^\]]*)\]/.exec(read('pages/_worker.js'))?.[1] ?? ''
    return raw
        .split(',')
        .map((one) => bare(one.trim().replace(/^['"]|['"]$/g, '')))
        .filter((one) => one !== '')
}

/** Docker 页面那份：`location ~ ^/(api|fixture)/ {` */
function fromNginx(): string[] {
    const raw = /location\s+~\s+\^\/\(([^)]*)\)\//.exec(read('page.nginx.conf'))?.[1] ?? ''
    return raw
        .split('|')
        .map((one) => bare(one.trim()))
        .filter((one) => one !== '')
}

const sets = {
    'src/server/node.ts': fromNodeServer(),
    'wrangler.jsonc': fromWrangler(),
    'pages/_routes.json': fromPagesRoutes(),
    'pages/_worker.js': fromPagesWorker(),
    'page.nginx.conf': fromNginx(),
}

const reference = [...sets['src/server/node.ts']].sort()

describe('「哪些路径归接口」四处写着同一组前缀', () => {
    it('自建那份的前缀不是空的（这条对账的前提）', () => {
        expect(reference.length).toBeGreaterThan(0)
        expect(reference).toContain('api')
    })

    for (const [where, list] of Object.entries(sets)) {
        it(`${where} 与自建那份一致`, () => {
            expect([...list].sort()).toEqual(reference)
        })
    }

    it('五处都是两个前缀，而且含 fixture（内置测试站点也要走到接口）', () => {
        for (const [where, list] of Object.entries(sets)) {
            expect(list.length, where).toBe(2)
            expect(list, where).toContain('fixture')
        }
    })
})
