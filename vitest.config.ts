import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * 单测这边的一份最小配置：只干一件事 —— 把 **WASM 那条缝**换成 Node 那份实现
 *
 * 为什么必须有它
 * --------------
 * `engine/js.ts` 里那句 `import { quickJsWasmModule } from '../platform/wasm'` 指向的是
 * `platform/wasm.ts`，而那个文件里是一句静态的 `.wasm` import。那是**打包器**的机制
 * （wrangler 把 .wasm 编成 `WebAssembly.Module` 交进来），Node 直接 import 会失败 ——
 * 实测失败长这样：
 *
 *     Error: Cannot find package 'a' imported from …/src/engine/RELEASE_ASYNC.wasm
 *
 * 也就是说 Vite 把那份**二进制**当源码加载了。于是「涉及沙箱的规则行为」在单测里
 * 一直只能打桩，真行为全靠 `scripts/smoke.mjs` —— 预置里那些 JS（`__listOf` / `__attrList` /
 * jsoup 方法面…）**中间那一层没有直接的断言**（见 TODO 第 14 条）。
 *
 * 换法与 `scripts/build-node.mjs` 里那个替换插件**同一件事**：把 `platform/wasm`
 * 指到 `platform/wasm.node.ts`（`readFile` + `new WebAssembly.Module`）。
 * 那个文件自己会按候选顺序找到 `src/engine/RELEASE_ASYNC.wasm`，所以这里不用再配路径。
 *
 * 为什么一刀切换掉也不拖慢测试
 * --------------------------
 * 顾虑是「几十个测试文件都（间接）import `analyze.ts` → `js.ts`，于是每个文件都要
 * 读 + 编译那 1 MB」。实测：**读 1ms + 编译 1ms**（V8 对 wasm 是惰性编译的），
 * 按 90 个文件算约 0.2 秒。比起「沙箱行为完全没有单测」，这点代价可以忽略 ——
 * 所以不做「只给某几个文件开」的那套复杂配置。
 *
 * 它**只影响 vitest**：`wrangler deploy` 与 `build-node.mjs` 都不读这个文件。
 */
const WASM_SEAM = fileURLToPath(new URL('./src/platform/wasm.node.ts', import.meta.url))

export default defineConfig({
    resolve: {
        alias: [{ find: '../platform/wasm', replacement: WASM_SEAM }],
    },
})
