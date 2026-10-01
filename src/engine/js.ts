/**
 * 书源 JS 规则的沙箱
 *
 * 为什么必须用 WASM 引擎
 * --------------------
 * Cloudflare Workers 出于安全考虑**禁用 `eval()` 与 `new Function()`**，
 * 而 Legado 书源里的 `@js:` 规则、`{{}}` 模板都是货真价实的 JS 代码。
 * 所以只能外挂一个 ECMAScript 引擎：这里用 QuickJS 编译成的 WASM
 * （Cloudflare 自己在 Kitesurf 里用的是 Rust 写的 Boa，思路一致）。
 *
 * 为什么把它当不可信代码
 * --------------------
 * 书源来自社区，内容不受控。any-reader 的 README 里就明确警告「规则可以利用 JS 越权」。
 * 所以每次执行都：
 *   - 新建一个 runtime + context，用完立刻销毁（同时避免请求间状态串味）
 *   - 限制内存与栈
 *   - 用中断回调做超时，挡住 `while(true){}` 这类会把 Worker 拖死的规则
 *
 * 已知限制
 * ------
 * 目前只支持**同步**脚本。Legado 的 `java.ajax()` 是异步取网，
 * 需要 asyncify 才能支持，留到后面的迭代；遇到时会抛出明确错误，
 * 而不是悄悄返回空字符串让书源表现成「搜不到书」。
 */

import {
  newQuickJSWASMModule,
  newVariant,
  RELEASE_SYNC,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten'

// 相对路径 import WASM：wrangler 会把它编译成 WebAssembly.Module 直接交给运行时。
// 这是 Workers 上唯一可用的加载方式 —— 运行时既禁止 WebAssembly.compile，
// 也不允许按包路径去 fetch .wasm 文件。
// 该文件由 scripts/copy-quickjs-wasm.mjs 从 node_modules 复制而来（见 package.json 的 pre 钩子）。
import quickjsWasmModule from './RELEASE_SYNC.wasm'

/** 默认给足字符串处理，但别让一条规则把 CPU 吃满 */
const DEFAULT_TIMEOUT_MS = 1200
const DEFAULT_MEMORY_LIMIT = 8 * 1024 * 1024
const DEFAULT_STACK_LIMIT = 512 * 1024

/**
 * 直接交出手上已有的 WebAssembly.Module，让 Emscripten 跳过它默认的
 * 「按 URL 取 WASM 再编译」流程。
 */
const cloudflareVariant = newVariant(RELEASE_SYNC, {
  wasmModule: quickjsWasmModule,
})

/**
 * QuickJS 的 WASM 模块只加载一次。
 *
 * 这是模块级状态，但它是**不可变的编译产物**，不含任何请求数据，
 * 因此不违反「不要把请求态放进全局作用域」。
 */
let quickJsModule: Promise<QuickJSWASMModule> | null = null

function loadQuickJS(): Promise<QuickJSWASMModule> {
  quickJsModule ??= newQuickJSWASMModule(cloudflareVariant)
  return quickJsModule
}

/** 沙箱执行失败时抛这个，便于上层区分「规则写错」与「网络失败」 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxError'
  }
}

/** 在沙箱里预置的 `java.*` 辅助函数（与 Legado 的 JsExtensions 同名） */
const JAVA_PRELUDE = `
var java = {
  base64Encode: function (s) { return __host.b64encode(String(s)) },
  base64Decode: function (s) { return __host.b64decode(String(s)) },
  encodeURI: function (s) { return encodeURIComponent(String(s)) },
  htmlFormat: function (s) { return String(s).replace(/<[^>]*>/g, '') },
  log: function (s) { __host.log(String(s)) },
  // 下面是异步取网，当前沙箱不支持，显式抛错而不是返回 undefined
  ajax: function () { throw new Error('java.ajax 暂不支持：沙箱目前只执行同步脚本') },
  ajaxAll: function () { throw new Error('java.ajaxAll 暂不支持：沙箱目前只执行同步脚本') },
  get: function () { throw new Error('java.get 暂不支持：沙箱目前只执行同步脚本') },
  post: function () { throw new Error('java.post 暂不支持：沙箱目前只执行同步脚本') },
}
`

export interface SandboxLimits {
  timeoutMs?: number
  memoryLimitBytes?: number
  stackLimitBytes?: number
}

/**
 * 执行一段书源 JS，返回其最后一个表达式的值
 *
 * @param code 书源里的 JS 片段（`@js:` 之后的部分，或 `{{}}` 里的内容）
 * @param globals 暴露给脚本的变量，对应 Legado 的 result / src / baseUrl / book 等
 */
export async function runInSandbox(
  code: string,
  globals: Record<string, unknown>,
  limits: SandboxLimits = {},
): Promise<unknown> {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const memoryLimit = limits.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT
  const stackLimit = limits.stackLimitBytes ?? DEFAULT_STACK_LIMIT

  quickJsModule ??= newQuickJSWASMModule(cloudflareVariant)
  const QuickJS = await loadQuickJS()

  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(memoryLimit)
  runtime.setMaxStackSize(stackLimit)

  // 超时靠中断回调：QuickJS 会在字节码边界定期回调它
  const deadline = Date.now() + timeoutMs
  let timedOut = false
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      timedOut = true
      return true
    }
    return false
  })

  const vm = runtime.newContext()
  const logs: string[] = []

  try {
    // 宿主函数：Workers 的 atob/btoa 是同步的，可以直接当桥。
    //
    // 注意句柄所有权：newFunction 返回的句柄归**调用方**所有，setProp 只是让它
    // 被属性引用一次。不 dispose 的话，runtime 销毁时会因为 GC 对象链表非空而
    // 断言失败（list_empty(&rt->gc_obj_list)），表现为整个请求 Aborted。
    const host = vm.newObject()

    const defineHostFn = (
      name: string,
      impl: (arg: QuickJSHandle) => QuickJSHandle | void,
    ): void => {
      const fn = vm.newFunction(name, impl)
      vm.setProp(host, name, fn)
      fn.dispose()
    }

    defineHostFn('b64encode', (arg) => {
      const s = vm.dump(arg) as string
      return vm.newString(btoa(String(s)))
    })
    defineHostFn('b64decode', (arg) => {
      const s = vm.dump(arg) as string
      return vm.newString(atob(String(s)))
    })
    defineHostFn('log', (arg) => {
      logs.push(String(vm.dump(arg)))
    })

    vm.setProp(vm.global, '__host', host)
    host.dispose()

    // 注入变量：走 JSON.parse，这样数组/对象/数字的类型都能保住
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) continue
      const json = JSON.stringify(value ?? null)
      const handle = vm.evalCode(`JSON.parse(${JSON.stringify(json)})`)
      if (handle.error) {
        handle.error.dispose()
        continue
      }
      vm.setProp(vm.global, key, handle.value)
      handle.value.dispose()
    }

    const prelude = vm.evalCode(JAVA_PRELUDE)
    if (prelude.error) {
      const msg = String(vm.dump(prelude.error))
      prelude.error.dispose()
      throw new SandboxError(`沙箱预置失败：${msg}`)
    }
    prelude.value.dispose()

    const outcome = vm.evalCode(code)
    if (outcome.error) {
      const dumped = vm.dump(outcome.error)
      outcome.error.dispose()
      const msg =
        dumped && typeof dumped === 'object' && 'message' in dumped
          ? String((dumped as { message: unknown }).message)
          : String(dumped)
      throw new SandboxError(`规则脚本执行出错：${msg}`)
    }

    const value = vm.dump(outcome.value)
    outcome.value.dispose()
    return value
  } catch (err) {
    if (timedOut) {
      throw new SandboxError(`规则脚本超时（>${timeoutMs}ms），已中断`)
    }
    throw err
  } finally {
    // 不管成败都要销毁：既不泄漏，也保证请求之间互不干扰
    vm.dispose()
    runtime.dispose()
  }
}

/** 把沙箱结果规整成字符串（JS 里 return 数组是常见写法） */
export function sandboxResultToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((v) => String(v ?? '')).join('\n')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 把沙箱结果规整成字符串列表 */
export function sandboxResultToStrings(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.map((v) => sandboxResultToString(v))
  return [sandboxResultToString(value)]
}
