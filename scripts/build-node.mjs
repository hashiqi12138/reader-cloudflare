/**
 * 打一个能直接 `node dist-node/server.mjs` 跑的包（自建模式）
 *
 * 为什么要打包而不是直接跑源码：`src/**` 里那些相对导入是**不带扩展名**的
 * （`from './data/db'`），Node 自己解析不了（它要求写全 `.ts` / `.js`）。
 * 而项目本来就有打包器（wrangler 用的是 esbuild），所以这里直接用 esbuild 打一份。
 *
 * 两处**只有打包器能做的事**：
 *
 *   1. **把 `platform/wasm` 换成 Node 那一份**。`engine/js.ts` 里那句
 *      `import … from '../platform/wasm'` 一行都不能改 —— Workers 侧必须是那句静态
 *      `import '*.wasm'`（运行时只认这种方式）。所以换的是**解析结果**：
 *      插件把 `platform/wasm` 指向 `platform/wasm.node.ts`（`readFile` + `compile`）。
 *   2. 把 WASM、`public/`、`migrations/` 拷到产物旁边，让 `dist-node/` 自成一包。
 */
import { build } from 'esbuild'
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const out = join(root, 'dist-node')

/** 把 `platform/wasm` 的解析结果换成 Node 那份（见文件头第 1 条） */
const wasmSeam = {
    name: 'wasm-seam',
    setup(b) {
        b.onResolve({ filter: /platform[/\\]wasm$/ }, () => ({
            path: join(root, 'src', 'platform', 'wasm.node.ts'),
        }))
    },
}

mkdirSync(out, { recursive: true })

await build({
    entryPoints: [join(root, 'src', 'server', 'node.ts')],
    outfile: join(out, 'server.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    // 依赖不打进产物：自建部署本来就是 `npm install` 之后跑，没必要把 cheerio 也塞进来
    packages: 'external',
    plugins: [wasmSeam],
})

const wasm = join(root, 'src', 'engine', 'RELEASE_ASYNC.wasm')
if (!existsSync(wasm)) {
    throw new Error(
        '缺少 src/engine/RELEASE_ASYNC.wasm —— 先跑 `npm run wasm`（npm install 会自动跑）',
    )
}
copyFileSync(wasm, join(out, 'quickjs.wasm'))
cpSync(join(root, 'migrations'), join(out, 'migrations'), { recursive: true })
cpSync(join(root, 'public'), join(out, 'public'), { recursive: true })

console.log(`产物在 ${out}：`)
console.log('  server.mjs（入口）· quickjs.wasm · migrations/ · public/')
console.log('跑起来：node dist-node/server.mjs')
