/*
 * QuickJS 那个 WASM 模块从哪来
 *
 * 这是**构建期**的平台差异，所以单独一个文件、单独一句静态 import。
 * Workers 上只认「相对路径 import `.wasm`」这一种方式：wrangler 把它编译成
 * `WebAssembly.Module` 直接交给运行时 —— 运行时既禁止 `WebAssembly.compile`，
 * 也不允许按包路径去 fetch 那个文件。
 *
 * 之所以要留出这条缝：只要 `engine/js.ts` 里还留着这句 import，任何非 Workers 的构建
 * 都会在**模块加载**阶段就失败 —— 连跑一下别的功能都做不到。换平台时替换这一个文件
 * （Node 上是 `readFile` + `WebAssembly.compile`），引擎那侧一行都不用动。
 *
 * 该文件由 `scripts/copy-quickjs-wasm.mjs` 从 node_modules 复制而来
 * （见 package.json 的 `pre*` 钩子）。
 */

import quickJsWasm from '../engine/RELEASE_ASYNC.wasm'

export const quickJsWasmModule: WebAssembly.Module = quickJsWasm
