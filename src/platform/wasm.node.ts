/*
 * Node 侧的 QuickJS WASM：`readFile` + `new WebAssembly.Module`
 *
 * 与 `platform/wasm.ts` 是同一个位置的另一份实现。那个文件里是一句静态的 `.wasm`
 * import —— 那是**打包器**的机制（wrangler 把 .wasm 编成 `WebAssembly.Module`
 * 直接交给运行时），只有 Workers 认。这里的 Node 构建
 * 会在打包时**把这个文件顶上那个**（见 `scripts/build-node.mjs` 里的插件），
 * 于是 `engine/js.ts` 那句 `import { quickJsWasmModule } from '../platform/wasm'`
 * 一行都不用改。
 *
 * 读文件是**同步**的、且发生在模块加载期：`engine/js.ts` 拿到的必须是**已经编好的**
 * `WebAssembly.Module`（它是同步用的）。好在 V8 对 wasm 是惰性编译的 ——
 * 那份 1 MB 实测读 + 编译约 2ms，所以「加载期就编好」并不贵，
 * 也因此单测里也能按文件地顶替这一份（见 `vitest.config.ts`）。
 *
 * 找文件的方式与 `server/node.ts` 的 `dirOf` 同一条思路：**按候选顺序找存在的那一个**，
 * 而不是把路径写死 —— 同一个文件有两种跑法（打完包和 dist-node 里的 `quickjs.wasm`
 * 并排；直接从仓库跑则在 `src/engine/RELEASE_ASYNC.wasm`），写死一种另一种就报
 * 「找不到 wasm」。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 候选路径按顺序试：显式指定的优先，然后是「产物旁边」，最后是「源码目录里那一份」 */
function findWasm(): string {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const candidates = [
        process.env.QUICKJS_WASM,
        // 打完包：build-node.mjs 把它复制成 dist-node/quickjs.wasm，与本文件同目录
        new URL('./quickjs.wasm', import.meta.url),
        // 直接跑源码：copy-quickjs-wasm.mjs 把它放在 engine/ 里（旁边就是唯一的使用点）
        new URL('../engine/RELEASE_ASYNC.wasm', import.meta.url),
    ].filter((one): one is string | URL => one !== undefined && one !== '')
    for (const one of candidates) {
        const path = typeof one === 'string' ? one : fileURLToPath(one)
        if (existsSync(path)) return path
    }
    throw new Error(
        `找不到 QuickJS 的 wasm（候选：${here} 下的 quickjs.wasm、../engine/RELEASE_ASYNC.wasm）。` +
            `先跑 \`npm run wasm\` 生成它，或用 QUICKJS_WASM 指一个路径。`,
    )
}

export const quickJsWasmModule: WebAssembly.Module = new WebAssembly.Module(
    readFileSync(findWasm()),
)
