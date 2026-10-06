/**
 * 拼出「页面那一份」要上传的目录（Pages）
 *
 * 就做一件事：`public/` 原样复制成 `dist-pages/`，再把 Pages 自己的两个约定文件
 * （`pages/_worker.js`、`pages/_routes.json`）摆进去。
 *
 * 为什么非要拼这一下，而不是让 `_worker.js` 直接住在 `public/` 里
 * -------------------------------------------------------------------
 * **因为 `_worker.js` 这个名字在 Pages 里是保留的**，而 `public/` 同时也是
 * **接口那一份（Worker）的静态资源目录**。把 `_worker.js` 放进 `public/` 之后，
 * `npm run deploy` 会在上传资产那一步直接失败：
 *
 *     ✘ [ERROR] Uploading a Pages _worker.js file as an asset.
 *
 * 所以分开摆：`public/` 保持「就是前端静态资源」这一件事（Worker / 自建 / 容器
 * 三份都照旧原样用它），Pages 专属的两份放在 `pages/`，部署时在这里拼一次。
 * `test/pages.test.ts` 把「`public/` 里不许出现 `_worker.js`」也钉住了 ——
 * 那是一条**硬失败**（发不出去），不是能凑合的警告。
 *
 * 拼出来的目录不进仓库（`.gitignore` 里），每次部署都重建，免得留下上一次的旧文件。
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const from = join(root, 'public')
const extra = join(root, 'pages')
const out = join(root, 'dist-pages')

/** Pages 那两个约定文件：`_worker.js` 是高级模式的入口，`_routes.json` 划 Function 的范围 */
const PAGES_FILES = ['_worker.js', '_routes.json']

for (const name of PAGES_FILES) {
    if (!existsSync(join(extra, name))) {
        console.error(`[build-pages] 少了 pages/${name} —— 页面那一份发出去会缺东西`)
        process.exit(1)
    }
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(from, out, { recursive: true })
for (const name of PAGES_FILES) copyFileSync(join(extra, name), join(out, name))

const count = readdirSync(out, { recursive: true }).length
console.log('页面那一份拼好了：dist-pages/')
console.log(`  ${count} 个条目（public/ 原样 + ${PAGES_FILES.join(' · ')}）`)
console.log('  发它：npx wrangler pages deploy dist-pages --project-name reader-cloudflare')
