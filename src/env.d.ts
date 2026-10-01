/**
 * 本地补充的模块类型
 *
 * wrangler 会把**相对路径**的 `.wasm` import 编译成 `WebAssembly.Module`
 * （这是 Workers 上唯一可用的 WASM 加载方式），但 `wrangler types` 生成的
 * worker-configuration.d.ts 里并不包含这条声明，需要自己补上。
 */

declare module '*.wasm' {
  const module: WebAssembly.Module
  export default module
}
