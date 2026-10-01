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
 * 为什么是 asyncify 版而不是同步版
 * ------------------------------
 * Legado 的 `java.ajax()` / `java.get()` / `java.post()` 是**异步取网**，
 * 而它们在书源脚本里是被当作同步函数调用的（`var html = java.ajax(url)`）。
 * 只有 QuickJS 的 asyncify 版本能实现这种「脚本里同步、宿主侧异步」的调用：
 * 脚本执行到那里会挂起，等宿主 fetch 完成后再恢复。
 *
 * 只装 asyncify 这一个变体，而不是同步/异步各装一份：一来 asyncify 版同样
 * 能跑纯同步脚本，二来「同步走 A、异步走 B」会让同一段规则在两种模式下行为
 * 不同，这类分歧极难排查；三来体积上更划算（1003 KB vs 两份 1494 KB）。
 * 代价是同步脚本也要承担 asyncify 的运行开销，对「几条字符串处理」这种量级可以忽略。
 *
 * 为什么把它当不可信代码
 * --------------------
 * 书源来自社区，内容不受控。any-reader 的 README 里就明确警告「规则可以利用 JS 越权」。
 * 所以每次执行都：
 *   - 新建一个 runtime + context，用完立刻销毁（同时避免请求间状态串味）
 *   - 限制内存与栈，并用中断回调挡住 `while(true){}`
 *   - 单独限制网络请求次数与总时限 —— 中断回调管不到宿主侧的等待，
 *     一段 `while(true){ java.ajax(...) }` 能靠发请求把 Worker 拖到超时
 */

import {
    newQuickJSAsyncWASMModule,
    newVariant,
    RELEASE_ASYNC,
    type QuickJSAsyncContext,
    type QuickJSAsyncRuntime,
    type QuickJSAsyncWASMModule,
    type QuickJSHandle,
} from 'quickjs-emscripten'

import type { SandboxHttp } from './types'
import { DEFAULT_TIME_OFFSET_HOURS, formatJavaTime } from '../lib/javatime'
import { md5Hex } from '../lib/hash'

// 相对路径 import WASM：wrangler 会把它编译成 WebAssembly.Module 直接交给运行时。
// 这是 Workers 上唯一可用的加载方式 —— 运行时既禁止 WebAssembly.compile，
// 也不允许按包路径去 fetch .wasm 文件。
// 该文件由 scripts/copy-quickjs-wasm.mjs 从 node_modules 复制而来（见 package.json 的 pre 钩子）。
import quickjsWasmModule from './RELEASE_ASYNC.wasm'

/** 脚本自身的执行时限（毫秒）。只约束 VM 里跑的代码，不含宿主等待 */
const DEFAULT_TIMEOUT_MS = 1200
const DEFAULT_MEMORY_LIMIT = 8 * 1024 * 1024
const DEFAULT_STACK_LIMIT = 512 * 1024

/** 整次求值的总时限，含所有网络请求 */
const DEFAULT_TOTAL_TIMEOUT_MS = 8000
/** 单次求值最多允许几次网络请求 */
const DEFAULT_MAX_HTTP_CALLS = 10

/**
 * 直接交出手上已有的 WebAssembly.Module，让 Emscripten 跳过它默认的
 * 「按 URL 取 WASM 再编译」流程。
 */
const cloudflareVariant = newVariant(RELEASE_ASYNC, {
    wasmModule: quickjsWasmModule,
})

/**
 * QuickJS 的 WASM 模块只加载一次。
 *
 * 这是模块级状态，但它是**不可变的编译产物**，不含任何请求数据，
 * 因此不违反「不要把请求态放进全局作用域」。
 */
let quickJsModule: Promise<QuickJSAsyncWASMModule> | null = null

function loadQuickJS(): Promise<QuickJSAsyncWASMModule> {
    quickJsModule ??= newQuickJSAsyncWASMModule(cloudflareVariant)
    return quickJsModule
}

/** 沙箱执行失败时抛这个，便于上层区分「规则写错」与「网络失败」 */
export class SandboxError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SandboxError'
    }
}

/**
 * 预置在沙箱里的 `java.*`（与 Legado 的 JsExtensions 同名）
 *
 * `__host` 是宿主注入的桥：`b64encode` / `b64decode` / `log` 是同步的，
 * `request` 是 asyncify 的异步桥 —— 它在脚本里表现为一个同步函数，
 * 底层会挂起脚本去发请求。
 */
const JAVA_PRELUDE = `
var java = {
  base64Encode: function (s) { return __host.b64encode(String(s)) },
  base64Decode: function (s) { return __host.b64decode(String(s)) },
  encodeURI: function (s) { return encodeURIComponent(String(s)) },
  htmlFormat: function (s) { return String(s).replace(/<[^>]*>/g, '') },
  log: function (s) { __host.log(String(s)) },

  // MD5 走同步桥，实现放在宿主侧（src/lib/hash.ts）—— WebCrypto 不提供 MD5，
  // 放宿主侧还能直接拿 node:crypto 对拍。禁漫天堂API、书音M 都靠它拼签名。
  md5Encode: function (s) { return __host.md5(String(s)) },

  // 十六进制与字符串互转，按 UTF-8 取字节（和 Java 的写法一致）
  hexDecodeToString: function (s) {
    var t = String(s).replace(/[^0-9a-fA-F]/g, '')
    var esc = ''
    for (var i = 0; i + 1 < t.length; i += 2) esc += '%' + t.substr(i, 2)
    try { return decodeURIComponent(esc) } catch (e) { return esc }
  },
  hexEncodeToString: function (s) {
    var enc = encodeURIComponent(String(s))
    var out = ''
    for (var i = 0; i < enc.length; i++) {
      // encodeURIComponent 给的是大写十六进制，这里统一转小写 ——
      // 与 md5Encode 的输出习惯一致，hexDecodeToString 大小写都收
      if (enc.charAt(i) === '%') { out += enc.substr(i + 1, 2).toLowerCase(); i += 2 }
      else { out += ('0' + enc.charCodeAt(i).toString(16)).slice(-2) }
    }
    return out
  },

  // 纯 UI 动作。服务端没有界面可弹，但**不能没有这些函数** ——
  // 书源里它们常和取数据写在同一个 try 里，缺一个就是
  // 「not a function」把整条规则带走（线上 12 条源在用）。这里记进日志，
  // 既不丢信息，也不让规则失败。
  toast: function (s) { __host.log('[toast] ' + String(s)) },
  longToast: function (s) { __host.log('[toast] ' + String(s)) },
  refreshExplore: function () {},
  getWebViewUA: function () {
    return 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36'
  },

  // 把一条规则当成字符串求值。当前节点只有规则求值层知道，所以要过宿主桥。
  // 时机上它是 asyncify 的：脚本里是同步调用，宿主侧 await。
  getString: function (rule, content) {
    var raw = __host.getString(JSON.stringify([
      String(rule),
      content === undefined || content === null ? null : String(content),
    ]))
    var res = JSON.parse(raw)
    if (!res.ok) { throw new Error(res.error) }
    return res.value
  },

  // 时间格式化是纯计算，走同步桥 —— 实现放在宿主侧，好在 Node 里直接测
  timeFormat: function (time, format) {
    return __host.timeFormat(time, format === undefined || format === null ? null : String(format), null)
  },
  timeFormatUTC: function (time, format, offset) {
    return __host.timeFormat(
      time,
      format === undefined || format === null ? null : String(format),
      offset === undefined || offset === null ? 0 : Number(offset),
    )
  },

  __req: function (opts) {
    var raw = __host.request(JSON.stringify(opts))
    var res = JSON.parse(raw)
    if (!res.ok) { throw new Error('取网失败：' + res.error) }
    return res.body
  },
  ajax: function (url) { return java.__req({ url: String(url) }) },
  get: function (url, headers) { return java.__req({ url: String(url), headers: headers || {} }) },
  post: function (url, body, headers) {
    return java.__req({ url: String(url), method: 'POST', body: String(body), headers: headers || {} })
  },
  // Legado 的 ajaxAll 返回的是带 body() 方法的响应对象数组，这里对齐这个形状
  ajaxAll: function (urls) {
    var out = []
    for (var i = 0; i < urls.length; i++) {
      var text = java.__req({ url: String(urls[i]) })
      out.push({ body: (function (t) { return function () { return t } })(text), url: String(urls[i]) })
    }
    return out
  },
}
`

/**
 * `java.getString(规则)` 的能力
 *
 * 由规则求值层注入 —— 「当前节点」只有那一层知道。
 *
 * **实现里不能再进沙箱**：asyncify 不支持嵌套挂起（见 runInSandbox 里的说明），
 * 所以传入的规则若含 `@js:` / `<js>` 必须直接报错，而不是进去再挂起一次。
 */
export type SandboxGetString = (rule: string, content?: string) => Promise<string>

export interface SandboxLimits {
    /** 脚本执行时限（毫秒） */
    timeoutMs?: number
    memoryLimitBytes?: number
    stackLimitBytes?: number
    /** 取网能力；不传时 java.ajax 会明确报错 */
    http?: SandboxHttp
    /** 规则求值能力；不传时 java.getString 会明确报错 */
    getString?: SandboxGetString
}

/**
 * 执行一段书源 JS，返回其最后一个表达式的值
 *
 * @param code 书源里的 JS 片段（`@js:` 之后的部分，或 `{{}}` 里的内容）
 * @param globals 暴露给脚本的变量，对应 Legado 的 result / src / baseUrl / book 等
 * @param limits 资源上限与取网能力
 */
export async function runInSandbox(
    code: string,
    globals: Record<string, unknown>,
    limits: SandboxLimits = {},
): Promise<unknown> {
    const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const memoryLimit = limits.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT
    const stackLimit = limits.stackLimitBytes ?? DEFAULT_STACK_LIMIT
    const http = limits.http
    const getString = limits.getString
    const totalTimeoutMs = http?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
    const maxHttpCalls = http?.maxCalls ?? DEFAULT_MAX_HTTP_CALLS

    const QuickJS = await loadQuickJS()

    const runtime = QuickJS.newRuntime()
    runtime.setMemoryLimit(memoryLimit)
    runtime.setMaxStackSize(stackLimit)

    // 两套时限：
    //   deadline  只卡 VM 里跑的代码（中断回调只管得到这里）
    //   hardDeadline 卡整次求值，含宿主侧的等待
    const started = Date.now()
    const deadline = started + timeoutMs
    const hardDeadline = started + totalTimeoutMs

    let timedOut = false
    runtime.setInterruptHandler(() => {
        if (Date.now() > deadline || Date.now() > hardDeadline) {
            timedOut = true
            return true
        }
        return false
    })

    const vm = runtime.newContext()
    const logs: string[] = []
    let httpCalls = 0

    try {
        // 宿主桥。注意句柄所有权：newFunction / newAsyncifiedFunction 返回的句柄归
        // **调用方**所有，setProp 只是让它被属性引用一次。不 dispose 的话，runtime
        // 销毁时会因为 GC 对象链表非空而断言失败（list_empty(&rt->gc_obj_list)），
        // 表现为整个请求 Aborted，报错信息里完全不会提到句柄。
        const host = vm.newObject()

        const defineHostFn = (
            name: string,
            impl: (arg: QuickJSHandle) => QuickJSHandle | void,
        ): void => {
            const fn = vm.newFunction(name, impl)
            vm.setProp(host, name, fn)
            fn.dispose()
        }

        /** 多参数版本：`timeFormat(时间, 格式, 偏移)` 要用 */
        const defineHostFnN = (
            name: string,
            impl: (...args: QuickJSHandle[]) => QuickJSHandle | void,
        ): void => {
            const fn = vm.newFunction(name, impl)
            vm.setProp(host, name, fn)
            fn.dispose()
        }

        defineHostFn('b64encode', (arg) => vm.newString(btoa(String(vm.dump(arg)))))
        defineHostFn('b64decode', (arg) => vm.newString(atob(String(vm.dump(arg)))))
        defineHostFn('md5', (arg) => vm.newString(md5Hex(String(vm.dump(arg)))))
        defineHostFn('log', (arg) => {
            logs.push(String(vm.dump(arg)))
        })

        // 时间格式化：纯计算，同步桥就够，也不用受 asyncify 的嵌套限制
        defineHostFnN('timeFormat', (timeArg, formatArg, offsetArg) => {
            const format = formatArg === undefined ? null : vm.dump(formatArg)
            const offset = offsetArg === undefined ? null : vm.dump(offsetArg)
            return vm.newString(
                formatJavaTime(
                    Number(vm.dump(timeArg)),
                    format === null || format === undefined ? undefined : String(format),
                    offset === null || offset === undefined
                        ? DEFAULT_TIME_OFFSET_HOURS
                        : Number(offset),
                ),
            )
        })

        // asyncify 函数：在脚本里是同步调用，宿主侧是 await。
        // 约束：asyncify 函数内部**不能再调用另一个 asyncify 函数**，
        // 所以这里只做 fetch 与规则求值，不做任何会再次进入沙箱的事 ——
        // 规则求值那一侧为此挡住了含 `@js:` 的规则（见 analyze.ts 的 sandboxGetString）。
        const getStringFn = vm.newAsyncifiedFunction('getString', async (arg) => {
            const raw = String(vm.dump(arg))
            return vm.newString(await handleGetString(raw, { getString }))
        })
        vm.setProp(host, 'getString', getStringFn)
        getStringFn.dispose()

        const requestFn = vm.newAsyncifiedFunction('request', async (arg) => {
            const optionsJson = String(vm.dump(arg))
            const response = await handleHttpRequest(optionsJson, {
                http,
                now: () => Date.now(),
                hardDeadline,
                takeCall: () => {
                    httpCalls += 1
                    if (httpCalls > maxHttpCalls) {
                        throw new SandboxError(
                            `单次规则最多允许 ${maxHttpCalls} 次网络请求，已超出`,
                        )
                    }
                },
            })
            return vm.newString(response)
        })
        vm.setProp(host, 'request', requestFn)
        requestFn.dispose()

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

        // evalCodeAsync 会在脚本调用 asyncify 函数时自动驱动挂起的任务，
        // 直到脚本跑完；不需要手工轮询 executePendingJobs
        const outcome = await vm.evalCodeAsync(code)

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
        releaseHostBridge(vm, runtime)
    }
}

/**
 * 销毁沙箱，保证宿主函数先于 runtime 被释放
 *
 * 必须先 `delete globalThis.__host` 再销毁，这不是可选的清理步骤，而是绕过
 * quickjs-emscripten 0.32.0 在 asyncify 变体上的一个顺序问题：
 *
 *   runtime.dispose() 会**先**把该 runtime 从回调表里注销，**再**真正释放 runtime；
 *   而宿主函数（newFunction / newAsyncifiedFunction 建的）此时还挂在全局对象上，
 *   于是 QuickJS 在释放它们时回调进来找不到 runtime，直接抛
 *   「QuickJSRuntime(rt = ...) not found when trying to free HostRef」——
 *   报错发生在脚本已经跑完之后，却会让整个请求失败。
 *
 * 摘掉全局引用后，这些函数的引用计数立刻归零、在 runtime 尚存时就被释放干净，
 * 销毁路径随之恢复干净。实测：不摘会抛错；只调 vm.dispose() 也不抛但
 * 少释放一层；摘掉再按正常顺序销毁则完全正常。
 */
function releaseHostBridge(vm: QuickJSAsyncContext, runtime: QuickJSAsyncRuntime): void {
    try {
        // 清理阶段不该再被超时打断（脚本可能因为超时才走到这里）
        runtime.setInterruptHandler(() => false)

        const cleanup = vm.evalCode('delete globalThis.__host')
        if (cleanup.error) cleanup.error.dispose()
        else cleanup.value.dispose()
    } catch {
        // 脚本已经把 VM 弄坏了也不影响结果：下面照常销毁
    }

    try {
        vm.dispose()
        runtime.dispose()
    } catch {
        // 走到这里说明库的销毁路径又出了问题，但结果早已取到、VM 也不再复用。
        // 这里不抛是为了不让一个纯清理阶段的问题把整次求值判成失败。
    }
}

/** 沙箱内 java.getString 的实际执行：把规则交给上层注入的求值能力 */
async function handleGetString(
    payloadJson: string,
    ctx: { getString?: SandboxGetString },
): Promise<string> {
    let rule = ''
    let content: string | undefined

    try {
        const parsed = JSON.parse(payloadJson) as [unknown, unknown]
        rule = String(parsed[0] ?? '')
        const raw = parsed[1]
        content = raw === null || raw === undefined ? undefined : String(raw)
    } catch {
        return JSON.stringify({ ok: false, error: 'java.getString 的参数不是合法 JSON' })
    }

    if (rule === '') return JSON.stringify({ ok: false, error: 'java.getString 缺少规则' })

    if (!ctx.getString) {
        return JSON.stringify({
            ok: false,
            error: '当前上下文未提供规则求值能力（java.getString 不可用）',
        })
    }

    try {
        return JSON.stringify({ ok: true, value: await ctx.getString(rule, content) })
    } catch (err) {
        return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        })
    }
}

/** 沙箱内 java.ajax 的实际执行：调用上层注入的取网能力，把结果规整成 JSON 字符串 */
async function handleHttpRequest(
    optionsJson: string,
    ctx: {
        http?: SandboxHttp
        now: () => number
        hardDeadline: number
        takeCall: () => void
    },
): Promise<string> {
    let options: { url?: string; method?: string; body?: string; headers?: Record<string, string> }
    try {
        options = JSON.parse(optionsJson) as typeof options
    } catch {
        return JSON.stringify({
            ok: false,
            error: `请求参数不是合法 JSON：${optionsJson.slice(0, 80)}`,
        })
    }

    if (!ctx.http) {
        return JSON.stringify({
            ok: false,
            error: '当前上下文未提供取网能力（java.ajax 不可用）',
        })
    }

    if (ctx.now() > ctx.hardDeadline) {
        return JSON.stringify({ ok: false, error: '整次求值已超时，请求被中止' })
    }

    try {
        ctx.takeCall()
    } catch (err) {
        return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        })
    }

    const url = String(options.url ?? '')
    if (url === '') return JSON.stringify({ ok: false, error: '请求缺少 url' })

    try {
        const text = await ctx.http.fetchText(url, {
            method: options.method,
            body: options.body,
            headers: options.headers,
        })
        return JSON.stringify({ ok: true, body: text })
    } catch (err) {
        return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        })
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
