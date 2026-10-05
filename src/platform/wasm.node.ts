/*
 * Node 侧的 QuickJS WASM：`readFile` + `WebAssembly.compile`
 *
 * 与 `platform/wasm.ts` 是同一个位置的另一份实现。那个文件里是一句静态的 `.wasm`
 * import —— 那是**打包器**的机制（wrangler 把 .wasm 编成 `WebAssembly.Module`
 * 直接交给运行时），只有 Workers 认。这里的 Node 构建
 * 会在打包时**把这个文件顶上那个**（见 `scripts/build-node.mjs` 里的插件），
 * 于是 `engine/js.ts` 那句 `import { quickJsWasmModule } from '../platform/wasm'`
 * 一行都不用改。
 *
 * 读文件是**同步**的、且发生在模块加载期：`engine/js.ts` 拿到的必须是**已经编好的**
 * `WebAssembly.Module`（它是同步用的），而 `.wasm` 只有 1 MB 出头，
 * 启动时多花几毫秒换「不需要 top-level await」这笔账划算。
 *
 * 路径默认取**打包产物旁边**那一份；`QUICKJS_WASM` 环境变量可以覆盖（指向别处）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const path = process.env.QUICKJS_WASM ?? fileURLToPath(new URL('./quickjs.wasm', import.meta.url))

export const quickJsWasmModule: WebAssembly.Module = new WebAssembly.Module(readFileSync(path))
