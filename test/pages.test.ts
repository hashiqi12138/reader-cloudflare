/*
 * 「页面与接口分开部署」（Pages + Worker）这条路上的防漂移测试
 *
 * 分工是：**Pages 发页面**（`public/` 拼上 Pages 的两个约定文件，见 `scripts/build-pages.mjs`），
 * **Worker 发接口**（`src/index.ts` + D1）。两边各发各的，所以中间那条缝全靠几个
 * 名字与几个前缀对齐 —— 而它们对不齐时**都不会当场报错**：
 *
 *   - `_routes.json` 的 include 与 `_worker.js` 代理的前缀不是同一组：漏的那条路径
 *     会被 Pages 当**静态资源**找，用户拿到 404；多写的那条则进到 worker 又被当静态
 *     资源 —— 两种都是「页面好好的，某个接口死活不通」
 *   - 默认 API 源写的是别的 Worker 名：转发打到一个不存在的主机上，**页面看起来正常**，
 *     一用就报错
 *   - 转发时「顺手」把响应头挑几个拼一拼：`Set-Cookie` 一丢，登录在 Pages 这份上
 *     就是「提交成功、却还是没登录」
 *   - 用 Functions 的写法（`export function onRequest`）写高级模式的文件：Pages 编译得
 *     过，但没有 fetch 入口，每个转发请求都 500
 *   - 那两个约定文件**放进 `public/`**：`public/` 同时是接口那一份的静态资源目录，
 *     而 `_worker.js` 这个名字在 Pages 里是保留的 —— `npm run deploy` 会在上传资产那一步
 *     直接失败（`Uploading a Pages _worker.js file as an asset`）。这一条是实测踩出来的
 *
 * 所以这里直接读仓库里那几份真文件对账，不另抄一份清单。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const exists = (name: string) => {
    try {
        readFileSync(new URL(`../${name}`, import.meta.url))
        return true
    } catch {
        return false
    }
}

const worker = read('pages/_worker.js')
const routes = JSON.parse(read('pages/_routes.json')) as {
    version: number
    include: string[]
    exclude: string[]
}
const buildPages = read('scripts/build-pages.mjs')
const wrangler = read('wrangler.jsonc')
const pkg = JSON.parse(read('package.json').replace(/^\uFEFF/, '')) as {
    name: string
    scripts: Record<string, string>
}
const doc = read('EXPERIENCE.md')

/** `wrangler.jsonc` 里那个 Worker 的名字（接口那一份就是它） */
const workerName = /"name":\s*"([^"]+)"/.exec(wrangler)?.[1] ?? ''
/** `_worker.js` 里那份默认接口源 */
const defaultApi = /const DEFAULT_API_ORIGIN = '([^']+)'/.exec(worker)?.[1] ?? ''
/** `_worker.js` 里代理的路径前缀（`const PROXY_PREFIXES = ['/api', '/fixture']`） */
const proxyPrefixes = (/const PROXY_PREFIXES = \[([^\]]*)\]/.exec(worker)?.[1] ?? '')
    .split(',')
    .map((one) => one.trim().replace(/^['"]|['"]$/g, ''))
    .filter((one) => one !== '')

describe('Pages 与 Worker 的分工：接口反代那一层', () => {
    it('`_worker.js` 用的是高级模式的形状（ESM 默认导出 + fetch）', () => {
        // Functions 的写法（`export function onRequest`）在这里编译得过、却接不到请求
        expect(worker).toMatch(/export default \{/)
        expect(worker).toMatch(/async fetch\(request, env\)/)
        expect(worker).not.toContain('export function onRequest')
    })

    it('`_routes.json` 的 include 与 `_worker.js` 代理的前缀是同一组', () => {
        const included = routes.include.map((one) => one.replace(/\/\*$/, '')).sort()
        expect(included).toEqual([...proxyPrefixes].sort())
        expect(included.length).toBeGreaterThan(0)
    })

    it('`_routes.json` 是 v1，而且没有莫名其妙的 exclude', () => {
        // exclude 的优先级**高于** include：随手写一条就会让某个接口走不到 Function
        expect(routes.version).toBe(1)
        expect(routes.exclude).toEqual([])
    })

    it('默认接口源指向本仓库部署的那个 Worker', () => {
        expect(workerName).not.toBe('')
        expect(defaultApi).toContain(`${workerName}.`)
        expect(defaultApi.startsWith('https://')).toBe(true)
    })

    it('接口源可以用 `API_ORIGIN` 覆盖（换账号 / 换名字时不必改代码）', () => {
        expect(worker).toMatch(/env\??\.API_ORIGIN/)
        expect(doc).toContain('API_ORIGIN')
    })
})

describe('Pages 与 Worker 的分工：转发的那几行', () => {
    it('请求整份转发（方法 / 头 / 体都跟着走）', () => {
        expect(worker).toMatch(
            /new Request\(new URL\(url\.pathname \+ url\.search, origin\), request\)/,
        )
    })

    it('响应头**整份**交回 —— `Set-Cookie` 一丢，登录就成了「提交成功却还是没登录」', () => {
        expect(worker).toMatch(/headers:\s*upstream\.headers/)
        // 不许出现「自己拼一份头」的写法（白名单一定会漏东西）
        expect(worker).not.toMatch(/new Headers\(\{/)
        expect(worker).not.toMatch(/headers:\s*\{\s*['"]content-type/)
    })

    it('204 / 304 / HEAD 不照抄响应体（照抄会让 Response 构造直接抛错）', () => {
        for (const token of ['204', '304', "'HEAD'"]) expect(worker).toContain(token)
        expect(worker).toMatch(/request\.method === 'HEAD' \|\| upstream\.status === 204/)
    })

    it('不是接口的路径交回静态资源层（兜住 `_routes.json` 万一没生效）', () => {
        expect(worker).toContain('env.ASSETS.fetch(request)')
    })
})

describe('Pages 与 Worker 的分工：部署入口', () => {
    it('`deploy:page` 先拼目录、再指名道姓发到同一个项目与分支', () => {
        const script = pkg.scripts['deploy:page'] ?? ''
        expect(script).toContain('build-pages.mjs')
        expect(script).toContain('wrangler pages deploy dist-pages')
        const project = /--project-name (\S+)/.exec(script)?.[1] ?? ''
        const branch = /--branch (\S+)/.exec(script)?.[1] ?? ''
        expect(project).not.toBe('')
        expect(branch).toBe('main')
        // 项目名与文档里写的是同一个（不然「改的是那一份、坏的是这一份」）
        expect(doc).toContain(`https://${project}.pages.dev`)
    })

    it('接口那一份仍是 `npm run deploy`（`deploy:all` 把两步串起来）', () => {
        expect(pkg.scripts.deploy).toContain('wrangler deploy')
        expect(pkg.scripts['deploy:all']).toContain('deploy:page')
    })
})

/*
 * Pages 那两个约定文件**不能住在 `public/` 里**
 *
 * 这一条是真踩出来的：`_worker.js` 在 Pages 里是保留名，而 `public/` 同时是接口那一份
 * 的静态资源目录 —— 放进去之后 `npm run deploy` 在上传资产那一步直接失败
 * （`Uploading a Pages _worker.js file as an asset`），也就是说**接口那一份发不出去**。
 * 所以两份约定文件单独住在 `pages/`，部署时由 `scripts/build-pages.mjs` 拼进 `dist-pages/`。
 */
describe('Pages 那两个约定文件不进 `public/`', () => {
    it('`public/` 里一个都不许有（有的话接口那一份就发不出去了）', () => {
        expect(exists('public/_worker.js')).toBe(false)
        expect(exists('public/_routes.json')).toBe(false)
        expect(exists('pages/_worker.js')).toBe(true)
        expect(exists('pages/_routes.json')).toBe(true)
    })

    it('拼目录的脚本把两份都摆进 `dist-pages/`（每次重建，不留上一次的旧文件）', () => {
        for (const name of ['_worker.js', '_routes.json']) expect(buildPages).toContain(name)
        expect(buildPages).toContain("join(root, 'public')")
        expect(buildPages).toContain("join(root, 'pages')")
        expect(buildPages).toContain("join(root, 'dist-pages')")
        expect(buildPages).toContain('rmSync(out')
    })

    it('拼出来的目录不进仓库、也不进容器镜像', () => {
        expect(read('.gitignore')).toContain('dist-pages/')
        expect(read('.dockerignore')).toContain('dist-pages')
    })
})
