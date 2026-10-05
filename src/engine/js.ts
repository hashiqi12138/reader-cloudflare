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
 *
 * 另外**同一个模块实例不能同时跑两次求值**（asyncify 的挂起状态挂在模块实例上），
 * 而又不能让一个请求去等另一个请求（Workers 禁止跨请求的 promise 链）。
 * 两条约束合起来只有「按请求隔离 + 请求内串行」这一个解，实现见下面 `SandboxSession`。
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

import type { ItemVarSink, SandboxHttp } from './types'
import type { CookieJar } from '../lib/cookies'
import { base64OfUtf8, bytesOfBase64, utf8OfBase64 } from '../lib/base64'
import { DEFAULT_TIME_OFFSET_HOURS, formatJavaTime } from '../lib/javatime'
import { md5Bytes, md5Hex, runHash, sha256Hex, type HashRequest } from '../lib/hash'
import { runSymmetric, type SymmetricRequest } from '../lib/symmetric'
import { JsoupBridge } from './jsoupBridge'
import { persistCrossVar } from './infoVars'
import { unsupportedPrelude } from './platform'

// WASM 模块从哪来是**构建期**的平台差异，那句 `import '*.wasm'` 挪去了
// `platform/wasm.ts` —— 只要它留在这里，任何非 Workers 的构建都会在**模块加载**
// 阶段就失败（原因见那个文件）。引擎这侧只管拿手上的 `WebAssembly.Module` 用。
import { quickJsWasmModule } from '../platform/wasm'

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
    wasmModule: quickJsWasmModule,
})

/**
 * 一次**请求**内的沙箱执行环境
 *
 * 为什么是「每次请求一个」而不是全局共用一个
 * -----------------------------------------
 * 两个约束同时成立，只剩这一个可行解：
 *
 * 1. **一个模块实例上不能有两次求值同时进行。**
 *    asyncify 的「正在挂起」标记挂在模块实例上（quickjs-emscripten 的
 *    `QuickJSModuleCallbacks` 里有个 `suspended` 字段），第二次挂起直接抛
 *    `Already suspended at: QuickJSAsyncifySuspended`；更糟的是它会把挂起状态弄坏，
 *    之后同一模块实例上的求值全部失败，报的却是一句看不出所以然的
 *    `SyntaxError: unexpected token: 'undefined'`。
 *
 * 2. **不能让一个请求去等另一个请求。**
 *    Workers 明确禁止跨请求的 promise 链：一旦请求 A 的 promise 在 A 结束之后
 *    才 resolve 到请求 B 的续体上，运行时会警告
 *    「A promise was resolved or rejected from a different request context…」，
 *    并把请求取消。所以「全局串行队列」「全局槽位池排队」这类写法**全都不能用** ——
 *    都会让后来的请求挂在先前请求的 promise 上。
 *
 * 合起来就是：**请求内串行，请求间互不相干**。
 * 于是每个请求拿一个自己的 session：内部一条串行链（保证同一模块上不会并发），
 * 请求结束随之废弃（不会跨请求）。网络取网不在沙箱里，仍然照常并行 ——
 * 被串起来的只是沙箱求值本身。
 *
 * 实测（`scripts/probe-concurrency.mjs`，同一书源 6 并发 + 6 串行）：
 * 全局共享一个模块 = 并发 0/6、之后串行 0/6；改成按请求隔离后 = 并发 6/6、串行 6/6。
 * 「多开几个模块做全局池」也不行 —— 池子一旦排满，后来的请求就要排队等待，
 * 又踩回第 2 条。
 */
export interface SandboxSession {
    /** 本会话的模块实例，第一次用到时才创建 */
    module: Promise<QuickJSAsyncWASMModule>
    /** 本会话内的串行链（只在本请求的上下文里串，不会跨请求） */
    queue: Promise<unknown>
    /**
     * **会话变量**：`java.put` / `java.get(key)` / `source.put(k,v)` 共用这一张表
     *
     * 为什么要有它：书源里「先存后取」是常规写法 —— 搜索地址的脚本里
     * `java.put('单', …)` 记下这次搜索的形态，同一个源后面的字段规则再
     * `java.get('单')` 读回来分情况处理。变量只活在单次求值里的话，后一次读到空串，
     * 规则会**静默**走到另一条分支。语料上这类调用是 130 处 `java.put` + 141 处一参
     * `java.get`，不是边角。
     *
     * 生命周期刻意与 cookie/cache 不同（那两个是「单次求值」，见 GLOBALS_PRELUDE 的说明）：
     * 变量是**按请求**活的，因为要跨求值，但仍然**不落库、不跨请求**。
     *
     * 注意它与「书源变量」（`source.getVariable()` / `setVariable(整串)`）是两回事：
     * 后者读写书源自己的 `variable`、会落库、跨请求活着，值挂在 `BookSource.variable` 上，
     * 不经过这张表。
     */
    vars: Record<string, string>
    /**
     * **书的变量**：`book.putVariable(名字, 值)` / `book.getVariable(名字)` 用这一张
     *
     * 与上面 `vars` 的区别是**作用域**：这一张属于「这本书」，落库在 `book_variables`
     * 表上（见 `collectBookVars`），并且**下一次求值的起点就是它** —— 一章一次请求，
     * 「探测出来的规则形状」必须跨请求留住，否则下一章要重探一遍。
     *
     * 会话里也留一份，是为了同一次请求内的**跨求值**：一次规则求值跑完 VM 就销毁，
     * 后一次求值的 `__bookVarsOut` 是从这里 + `RuleContext.bookVars` 重新组装的
     * （见 engine/globals.ts 的 bookVars）。
     */
    bookVars: Record<string, string>
    /**
     * 本次请求里**已经为跨请求的 `java.put` 落过库**的键（见 `collectSourceVars`）
     *
     * 挂在会话上而不是 `ctx` 上：`ctx` 在目录循环里每翻一页都会拷一份
     * （`{ ...ctx, baseUrl: 新页 }`），记账挂在它上面等于「每页都重新开始算」——
     * 逐章求值的写法于是会变成几百次 D1 写。会话是按请求活的，正合适。
     *
     * 不放进 `vars` 里：那张表会被整份注入沙箱的 `__sourceVars`，脚本会看见莫名的键。
     */
    crossVarSaved?: Set<string>
    /**
     * 上一次求值的日志（`java.toast` / `java.log` 那些）
     *
     * 只有登录接口在用：书源把「登录成功了」「账号密码为空」这类话写成 toast，
     * 而那句话是用户唯一能看到的结果 —— 接口得把它带回去。
     */
    lastLogs?: string[]
    /**
     * 这一次求值里**被改过的登录态**（`putLoginHeader` / `putLoginInfo` / `removeLogin*`）
     *
     * 只有登录接口在用。它回答的是「登录成功没有」，而**不能**用「loginInfo 非空」
     * 去回答 —— 表单字段会被宿主先放进 loginInfo 让脚本读得到（官方文档里
     * `login` 函数就是从 `source.getLoginInfoMap()` 取用户输入的），
     * 那不是「登录成功」。退出登录（写成空串）也算「改过」，所以这里存的是一份
     * **这次写出去的值**，不是布尔。
     */
    loginOut?: { header?: string; info?: string }
    /**
     * **批量求值会话**（第五十九轮；第六十一轮起按 jsLib 分开成多份）
     *
     * 由 `openSandboxBatch` 装上、`closeSandboxBatch` 拆掉：装上之后这一批里的每次
     * 求值都复用同一个 runtime + context（静态预置只解析一次）。生命周期刻意很短 ——
     * 由调用方在循环外开、循环结束就关，**绝不留到请求之外**（否则 WASM 内存会漏）。
     *
     * 键是「这份上下文是用**哪份 jsLib** 预热的」，见 `SandboxBatch.jsLib`。
     */
    batches: Map<string, SandboxBatch>
}

/**
 * 一个请求内**复用**的沙箱执行环境（第五十九轮）
 *
 * 为什么值得单独做一层：一次求值的固定代价实测 5.64ms，其中 **5.3ms 是重新解析
 * 那 52KB 预置**（runtime + context 只要 0.34ms），而同一段改成「复用 context 重跑」
 * 只要 0.01ms 量级。目录里的「逐条字段」正是「一本书几千条、每条一次」那种写法，
 * 于是被这个代价逼出了 `MAX_MARKED_CHAPTERS = 300` 这个有损上限 —— 这一层就是为它做的。
 *
 * 三条边界（分别靠 `PER_EVAL_PRELUDE` / 每次重建的宿主桥 / `closeSandboxBatch` 守住）：
 *   - 静态预置与 jsLib **只跑一次**；每次求值只重跑 PER_EVAL_PRELUDE
 *   - 宿主**每次求值仍建一套自己的桥**（它闭包着这一次的日志、取网与时限），
 *     求值结束就摘掉 —— 复用上下文不会把上一次的日志与取网带过来
 *   - runtime / context 只在 `closeSandboxBatch` 里销毁，且在 `delete __host` 之后
 *     （顺序原因见 `releaseHostBridge` 的说明）
 */
export interface SandboxBatch {
    runtime: QuickJSAsyncRuntime
    vm: QuickJSAsyncContext
    /**
     * 这份上下文是用**哪份 jsLib** 预热的（`''` = 没有 jsLib）
     *
     * 为什么要记它：`closeSandboxBatch` 之后要按同一份 jsLib 找回自己那一批；更要紧的是
     * **同一份上下文不能给两个 jsLib 不同的书源共用** —— 静态预置与 jsLib 只跑一次
     * （见下面那段「只跑一次」的说明），共用了 `GetUL()` / `host()` 这类名字就会**漏**到
     * 另一个源里，而且不报错。第六十一轮把批量求值接到搜索上时，一页三个源共享一个
     * session，这个漏点才第一次真正暴露出来（见 `openSandboxBatch`）。
     */
    jsLib: string
    /**
     * 有几个调用方正拿着它
     *
     * 同一份 jsLib 的多个源可以共用同一批（引用计数到 0 才真的销毁）——
     * 于是「一页三个都没 jsLib 的源」共享一份上下文，而「一个带 jsLib 的混在里头」
     * 也不会串味，只是那一份自己单独一批。
     */
    holders: number
    /** 静态预置与 jsLib 跑过了没有 */
    ready: boolean
    /** 这一次求值被 setProp 到全局的那些名字 —— 下次求值前要先删掉，否则会串味 */
    injected: string[]
    /** 只卡 VM 内代码的时限（复用时要每次重设） */
    deadline: number
    /**
     * 这一次求值的**宿主侧累计耗时**（复用路径下由 `executeInSandbox` 挂上来）
     *
     * `deadline` 的语义是「只卡 VM 里跑的代码」，而中断回调只能看到墙上时间 ——
     * 不减掉这一项，一次几百毫秒的 `jsoup` 桥调用也会被算成「脚本跑了这么久」。
     * 详见图注里 📂漫画搬运 那段实测。
     */
    busy: { ms: number }
    /** 卡整次求值（含宿主侧等待）的时限 */
    hardDeadline: number
    /** 这一批里最近一次求值是不是被超时中断的 */
    timedOut: boolean
    /** 这一批已经跑过多少次求值（够了就轮换 context，见 `rotateSandboxBatch`） */
    runs: number
}

/**
 * 一批里求值多少次之后**换一个 context**
 *
 * 复用省时间，代价是「规则里新建的全局名」与垃圾都留在同一个 context 里（第五十九轮
 * 明知的取舍）。轮换让它定期归零：代价是每 400 次多花一次 5.3ms 的预置解析，
 * 换的是「一本书一万次求值也不会把 8MB 内存吃满」。
 *
 * 时机判断第六十一轮搬进了沙箱层（`executeInSandbox`）：搜索那条路也开批之后，
 * 轮换不该只挂在目录那一个调用方上。
 */
const BATCH_ROTATE_EVALS = 400

export function createSandboxSession(): SandboxSession {
    let module: Promise<QuickJSAsyncWASMModule> | null = null
    return {
        // 懒创建：只读「书源列表」这类请求根本不进沙箱，
        // 不该为它们白实例化一个 WASM 模块（实例化不便宜，见上面那段说明）
        get module() {
            module ??= newQuickJSAsyncWASMModule(cloudflareVariant)
            return module
        },
        queue: Promise.resolve(),
        vars: {},
        bookVars: {},
        batches: new Map(),
    }
}

/**
 * 开一个批量求值会话（见 `SandboxBatch`）
 *
 * 只做**便宜**的那部分：建 runtime + context、装上中断回调（它读 `batch` 上的时限，
 * 于是每次求值只要改那两个字段）。静态预置与 jsLib 留给这一批的**第一次求值**去跑 ——
 * 那时宿主桥才装得上，而预置里 `Packages` 之类在定义期就可能碰 `__host`。
 *
 * **一批绑一份 jsLib**（第六十一轮）：`limits` 就是给 `runInSandbox` 的那一份，
 * 于是键与求值那边的查表用的是同一个字段（`preludeJs`）。理由见 `SandboxBatch.jsLib` ——
 * 一页三个源共享一个 session，jsLib 不同的源共用一份上下文会**静默**串味。
 *
 * 同一份 jsLib 已经开着就**记一笔**并复用（重复开要配对重复关，引用计数到 0 才销毁）——
 * 所以调用方**必须**把 `openSandboxBatch` / `closeSandboxBatch` 配成对，放在 try/finally 里。
 */
export async function openSandboxBatch(
    session: SandboxSession,
    limits: {
        preludeJs?: string
        memoryLimitBytes?: number
        stackLimitBytes?: number
    } = {},
): Promise<void> {
    const key = limits.preludeJs ?? ''
    const existing = session.batches.get(key)
    if (existing) {
        existing.holders += 1
        return
    }
    const QuickJS = await session.module
    const runtime = QuickJS.newRuntime()
    runtime.setMemoryLimit(limits.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT)
    runtime.setMaxStackSize(limits.stackLimitBytes ?? DEFAULT_STACK_LIMIT)
    const batch: SandboxBatch = {
        runtime,
        vm: runtime.newContext(),
        jsLib: key,
        holders: 1,
        ready: false,
        injected: [],
        deadline: Number.POSITIVE_INFINITY,
        busy: { ms: 0 },
        hardDeadline: Number.POSITIVE_INFINITY,
        timedOut: false,
        runs: 0,
    }
    // 整批共用一个中断回调：时限每次求值由 executeInSandbox 重设（不能摘掉，
    // 摘掉之后这一批剩下的求值就再也没有超时保护了）
    runtime.setInterruptHandler(() => {
        if (Date.now() - batch.busy.ms > batch.deadline || Date.now() > batch.hardDeadline) {
            batch.timedOut = true
            return true
        }
        return false
    })
    session.batches.set(key, batch)
}

/**
 * 真的销毁一份上下文
 *
 * 顺序与 `releaseHostBridge` 一致：先 `delete __host` 再销毁 runtime，否则
 * quickjs-emscripten 0.32.0 在 asyncify 变体上会抛
 * 「not found when trying to free HostRef」（那里有详细说明）。
 */
function disposeSandboxBatch(batch: SandboxBatch): void {
    try {
        batch.runtime.setInterruptHandler(() => false)
        const cleanup = batch.vm.evalCode('delete globalThis.__host')
        if (cleanup.error) cleanup.error.dispose()
        else cleanup.value.dispose()
    } catch {
        /* 清理阶段的问题不该让请求失败 */
    }
    try {
        batch.vm.dispose()
        batch.runtime.dispose()
    } catch {
        /* 同上：结果早已取到，VM 也不再复用 */
    }
}

/**
 * 关掉批量求值会话（**必须**在循环结束后调，否则 WASM 内存一直挂着）
 *
 * `limits` 要与 `openSandboxBatch` 那一次**给出同一份 jsLib** —— 拿错键就关不掉
 * （那是内存泄漏，不是报错）。引用计数没到 0 时只减一笔，上下文留给还在用的那边。
 */
export function closeSandboxBatch(
    session: SandboxSession,
    limits: { preludeJs?: string } = {},
): void {
    const key = limits.preludeJs ?? ''
    const batch = session.batches.get(key)
    if (!batch) return
    batch.holders -= 1
    if (batch.holders > 0) return
    session.batches.delete(key)
    disposeSandboxBatch(batch)
}

/**
 * 一批跑够 `BATCH_ROTATE_EVALS` 次就换一个 context（第六十一轮从目录那条路搬进来）
 *
 * 引用计数与 jsLib 都照搬过去 —— 换的是上下文，不是「这一批」的账。
 */
async function rotateSandboxBatch(session: SandboxSession, key: string): Promise<void> {
    const old = session.batches.get(key)
    if (!old) return
    const { holders, jsLib } = old
    session.batches.delete(key)
    disposeSandboxBatch(old)
    await openSandboxBatch(session, { preludeJs: jsLib })
    const fresh = session.batches.get(key)
    if (fresh) fresh.holders = holders
}

/** 在会话内串行执行；闸门不会因为某次失败而断掉 */
function withSession<T>(session: SandboxSession, task: () => Promise<T>): Promise<T> {
    const run = session.queue.then(task, task)
    session.queue = run.then(
        () => undefined,
        () => undefined,
    )
    return run
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
// ---------------------------------------------------------------- 会话变量
//
// java.put(k, v) / java.get(k)（以及 source.get(k) / source.setVariable(k, v) 那种
// 两参写法）共用这一张表。求值开始时由宿主注入（__sourceVars 里带着本次请求前面
// 几次求值写过的值），求值结束时宿主再把它收回去 —— 「搜索脚本先存、字段规则后读」
// 就靠这一步跨过去。
//
// **书源变量不走这张表**：source.getVariable() / setVariable(整串) 读写的是书源自己的
// variable（Legado 的 BookSource.variable），会落库、跨请求活着，见 GLOBALS_PRELUDE 里
// source 那一段与 collectSourceVariable。
//
// 注意：这一段是模板字符串的一部分，注释里**不能写反引号**。
var __varsOut = {}
var __varsDirty = {}
var __bookVarsOut = {}
var __bookVarsDirty = {}

/**
 * 写会话变量
 *
 * **必须与读同一张表**：java.put / source.setVariable(k, v) / source.put(k, v)
 * 三条写法在语料里混着用，各写一份的话「脚本里 put 完、规则里 get(k)」就读不到。
 *
 * 除值本身外还记一笔 __varsDirty：宿主靠它知道**这次求值真的写过哪些键**，
 * 好把其中属于「别的请求会读」的那些落进 book_variables（见 collectSourceVars）。
 * 不记这一笔的话，宿主只能把整张表都当成「写过的」—— 而这张表里现在还有
 * 从书的变量垫进来的跨请求值，那样每次目录翻页都要多写一次一模一样的库。
 *
 * 注意：这一段是模板字符串的一部分，注释里**不能写反引号**。
 */
function __varsPut(key, value) {
  var name = String(key)
  __varsOut[name] = value === undefined || value === null ? '' : String(value)
  __varsDirty[name] = 1
}

/**
 * 把这一次求值的两张表装进来（第五十九轮）
 *
 * 以前这里是两个 IIFE：预置文本每求值一次就重新解析一遍，那 52KB 的解析占了
 * 一次求值 5.6ms 里的 5.3ms。现在预置在一个请求里只解析一次，每次求值改跑
 * 下面这些 __refresh*（见 PER_EVAL_PRELUDE 与 README 第五十九轮）。
 */
function __refreshVars() {
  __varsOut = __tableOf(globalThis.__sourceVars)
  __bookVarsOut = __tableOf(globalThis.__bookVars)
  // 「这次求值写过的名字」每次都是新的：不重置的话上一章写过的会被再回传一次
  __varsDirty = {}
  __bookVarsDirty = {}
}

/** 把一段注入的 JSON 解析成表；坏了就当空表（书源里的坏值不该让整次求值挂掉） */
function __tableOf(text) {
  try { return JSON.parse(String(text || '{}')) || {} } catch (e) { return {} }
}

__refreshVars()

/**
 * 给一个对象挂上 Legado 的 StrResponse 方法（body / code / statusCode / header(s) / url / raw）
 *
 * 存在的理由：**取网方法的返回值在语料里是两用的**，而且两种用法都真实存在 ——
 *
 *   JSON.parse(java.get(u, h))        当**字符串**（正文）用
 *   java.get(u, h).statusCode() == 200  当**响应对象**用（⚡📂米读小说 / 📂就去看网）
 *   java.post(u, b, h).body()           同上（🏷晋江文学）
 *
 * 只给字符串的话，第二种是 TypeError: ... is not a function（QuickJS 还说不出是哪一个）；
 * 只给对象的话，第一种会在 JSON.parse 上炸。所以 java.get / java.post 的返回值是**盒装字符串**
 * （typeof 是 object、但所有字符串操作照常），再把响应方法挂上去 ——
 * 与 __boxHtml 处理 result 的两用是同一个手法。
 *
 * getDetail 是取数入口（调一次、结果缓存），urlOf 是不取网就能算出来的请求地址
 * （java.get 当场取数，java.connect 只在真要 body/code/headers 时才取）。
 */
function __attachResponse(target, getDetail, urlOf) {
  target.url = function () { return urlOf === undefined || urlOf === null ? '' : String(urlOf) }
  target.body = function () {
    var d = getDetail()
    return d.ok ? String(d.body === undefined || d.body === null ? '' : d.body) : String(d.error || '')
  }
  target.code = function () { var d = getDetail(); return d.ok ? Number(d.status) : 0 }
  target.statusCode = target.code
  target.isSuccessful = function () { var c = target.code(); return c >= 200 && c < 300 }
  target.headers = function (name) {
    var d = getDetail()
    if (!d.ok) return []
    var key = String(name).toLowerCase()
    var list = (d.headers || {})[key]
    /**
     * Location 要特别对待：重定向是**我们替书源跟的**，跟完之后最终响应里当然没有它，
     * 但那个 Location 是书源那次请求的**真实响应头**。线上 11 个源的 searchUrl 就是
     * 靠它找真正的搜索页地址（写法是 java.post(url, body, {}).header('location')），
     * 丢了它们只会拿到空串、然后拿空地址去请求。
     */
    if (
      (list === undefined || list === null || list.length === 0) &&
      key === 'location' &&
      d.redirectedFrom
    ) {
      return [String(d.redirectedFrom.location)]
    }
    return list === undefined || list === null ? [] : list
  }
  target.header = function (name, fallback) {
    var list = target.headers(name)
    if (list.length > 0) return list[0]
    return fallback === undefined || fallback === null ? '' : fallback
  }
  target.raw = function () {
    return {
      request: function () { return { url: function () { return target.url() } } },
      code: function () { return target.code() },
      headers: function (name) { return target.headers(name) },
    }
  }
  return target
}

/**
 * 当场取一次网，把响应包成「正文 + 响应方法」的盒装字符串（java.get 两参 / java.post）
 *
 * 网络层真失败（超时、连不上）仍然抛错，与 java.ajax 一致 —— 那种情况没有任何
 * 可用的响应可言，静默返回一段错误文本会让书源把「取不到」当成「取到了」。
 * HTTP 非 2xx **不抛**：那正是 .statusCode() == 403 这类判断要看的东西。
 */
function __fetchResponse(opts) {
  var res = JSON.parse(__host.fetchFull(JSON.stringify(opts)))
  if (!res.ok) throw new Error('取网失败：' + (res.error || '未知错误'))
  var text = String(res.body === undefined || res.body === null ? '' : res.body)
  var boxed = new String(text)
  __attachResponse(boxed, function () { return res }, res.url || opts.url)
  boxed.toString = function () { return text }
  return boxed
}

var java = {
  base64Encode: function (s) { return __host.b64encode(String(s)) },
  base64Decode: function (s) { return __host.b64decode(String(s)) },

  // 解出来的是**原始字节**，不是字符串。
  // 用途几乎只有一个：把书源里写死的 base64 密钥/偏移量变回字节数组交给 AES
  // （base64DecodeToByteArray(KEY_BASE64)）。做成字符串再转回去的话，
  // 二进制密钥会被 UTF-8 解码器替换成 U+FFFD，密钥就废了 —— 而症状是解密失败/乱码，
  // 完全看不出是解码方式的问题。线上 10 处用到它。
  base64DecodeToByteArray: function (s) {
    var raw = __host.base64Bytes(String(s))
    var res = JSON.parse(raw)
    if (!res.ok) { throw new Error(res.error) }
    return res.value
  },
  // 字符串按 UTF-8 取字节（有的书源用它把字符串密钥转成字节）
  strToBytes: function (s) { return JSON.parse(__host.utf8Bytes(String(s))) },
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
  //
  // 全量数过之后又补了同一类动作（一共 24 处引用）：
  //   openUrl / open / openWeb / openBook —— 让 App 去打开地址或页面。
  //     java.open("explore", url, book) 这种是「跳到发现页」，openUrl(u) 是
  //     「在浏览器里打开 u」（⚡📂八一中文网 拿它提示「搜索地址已更新」）
  //   refreshTocUrl  —— 让 App 重新拉一次目录
  //   upLoginData    —— 上传登录态（书源的登录脚本里调）
  //   copyText       —— 复制到剪贴板
  //   sleep          —— 睡一会儿。**Worker 里没有阻塞线程这回事**，只能忽略；
  //                     真要等待的话书源该用「再发一次请求」，不是 sleep
  toast: function (s) { __host.log('[toast] ' + String(s)) },
  longToast: function (s) { __host.log('[toast] ' + String(s)) },
  refreshExplore: function () {},
  refreshTocUrl: function () { __host.log('[refreshTocUrl] 本引擎按需重新取目录，忽略') },
  upLoginData: function () { __host.log('[upLoginData] 本引擎没有登录态上传，忽略') },
  openUrl: function (u) { __host.log('[openUrl] 打不开外部浏览器，忽略：' + String(u).slice(0, 120)) },
  open: function (u) { __host.log('[open] 没有可跳转的界面，忽略：' + String(u).slice(0, 120)) },
  openWeb: function (u) { __host.log('[openWeb] 打不开外部浏览器，忽略：' + String(u).slice(0, 120)) },
  openBook: function (u) { __host.log('[openBook] 没有可跳转的界面，忽略：' + String(u).slice(0, 120)) },
  copyText: function (s) { __host.log('[copyText] 没有剪贴板，忽略：' + String(s).slice(0, 60)) },
  sleep: function () { __host.log('[sleep] Worker 里不能阻塞，忽略') },
  // 跨源搜索是 App 级能力（java.searchBook(key, source)），服务端做不了。
  // 返回空串 + 记日志，而不是抛错：它出现在「其它书源里有没有这本」这类**附加信息**里，
  // 抛错会把整条规则带走，比这个字段少一个值更糟；返回空的话症状是「这个字段没值」，
  // 一眼能看出是没做，而不是给了一个错的值。
  searchBook: function (key) {
    __host.log('[searchBook] 本引擎不做跨源搜索，返回空：' + String(key).slice(0, 60))
    return ''
  },
  getWebViewUA: function () {
    return 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36'
  },
  // 随机 UUID。线上 5 处，用来拼「本次请求的一次性标识」
  randomUUID: function () {
    var hex = '0123456789abcdef'
    var out = ''
    for (var i = 0; i < 32; i++) out += hex.charAt(Math.floor(Math.random() * 16))
    return (
      out.slice(0, 8) + '-' + out.slice(8, 12) + '-4' + out.slice(13, 16) + '-a' +
      out.slice(17, 20) + '-' + out.slice(20)
    )
  },

  // 把一条规则当成字符串求值。当前节点只有规则求值层知道，所以要过宿主桥。
  // 时机上它是 asyncify 的：脚本里是同步调用，宿主侧 await。
  getString: function (rule, content) {
    var c = content === undefined || content === null ? java.__content : content
    var raw = __host.getString(JSON.stringify([
      String(rule),
      c === undefined || c === null ? null : String(c),
    ]))
    var res = JSON.parse(raw)
    if (!res.ok) { throw new Error(res.error) }
    return res.value
  },

  // 把一条规则求值成**节点集**（org.jsoup 的 Elements）
  //
  // 与 getString 同一个套路：命中哪些节点只有规则求值层知道，所以宿主侧求值、
  // 把每个节点的 outerHTML 交回来，这边再解析成 Elements。
  // 线上 32 处 getElements + 9 处 getElement，写法横跨 CSS、JSOUP 简写与 XPath，
  // 都由规则求值层统一处理，这里不做方言判断。
  getElements: function (rule, content) {
    var c = content === undefined || content === null ? java.__content : content
    var raw = __host.getElements(JSON.stringify([
      String(rule),
      c === undefined || c === null ? null : String(c),
    ]))
    var res = JSON.parse(raw)
    if (!res.ok) { throw new Error(res.error) }
    var reply = __jsoupCall('parseFragments', null, [res.value])
    return reply.handle === null ? new JsoupElements(0) : new JsoupElements(reply.handle)
  },
  getElement: function (rule, content) {
    var all = java.getElements(rule, content)
    return all.size() > 0 ? all.first() : null
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
  // java.get(key) 读变量、java.get(url, headers) 取网 —— Legado 里是**同名两个重载**，
  // 所以这里按**参数个数**分派，而不是猜参数像不像地址。
  // 语料上：一参 141 处全是变量名（java.get('bid')、java.get("单")），
  // 二参 35 处才是地址（java.get(baseUrl, headers)）。早先一律当取网，
  // 于是 if (java.get("单") == '') 会去**请求一个叫「单」的地址**：必然失败，
  // 而且报出来的是一个与书源毫无关系的网络错误。
  //
  // 二参那条返回的是 Legado 的 **StrResponse**（既是正文、又带响应方法）——
  // 语料里两种用法都有：JSON.parse(java.get(u, h)) 当字符串，
  // java.get(u, h).statusCode() == 200 当响应对象（⚡📂米读小说 / 📂就去看网）。
  get: function (a, b) {
    if (arguments.length >= 2) return __fetchResponse({ url: String(a), headers: b || {} })
    var v = __varsOut[String(a)]
    return v === undefined || v === null ? '' : String(v)
  },
  // 存变量。线上 130 处 —— 本引擎以前**根本没有这个函数**，所以每一处都是
  // TypeError: not a function（QuickJS 还说不出是哪一个）。
  put: function (key, value) {
    __varsPut(key, value)
  },
  // 与 java.get 两参同形：Legado 的 post 也返回 StrResponse（🏷晋江文学 用 .body()）
  post: function (url, body, headers) {
    return __fetchResponse({
      url: String(url),
      method: 'POST',
      body: String(body),
      headers: headers || {},
    })
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
  getStringList: function (rule, content) {
    var joined = java.getString(rule, content)
    if (joined === '') return []
    return String(joined).split('\\n')
  },
  // 连接式取网。Legado 的 java.connect(url, header) **当场发请求**，返回 StrResponse：
  //
  //   res.url()                    请求地址（AnalyzeUrl 解析后的绝对地址）
  //   res.body()                   响应正文
  //   res.code()                   HTTP 状态码
  //   res.isSuccessful()           2xx
  //   res.raw().request().url()    同一个地址（OkHttp 的形状）
  //   res.raw().headers(name)      响应头（**数组**，Set-Cookie 靠它）
  //
  // 语料上 22 个源在用，其中 9 个只写 {{java.connect(source.getKey()).raw().request().url()}}
  // —— 它们要的**只是那个地址**。所以这里的 url() / raw().request().url() 走同步桥
  // 解析地址、**不发请求**（Legado 也是在发请求之前就把地址定下来的）；
  // 只有真要 body() / code() / raw().headers() 时才发那一次，且只发一次（结果缓存）。
  //
  // 一个刻意的取舍：上游失败时 raw 是 null（脚本随即 NPE），这里始终给一个形状完整的
  // 对象，headers() 取不到就给空数组 —— 半条信息总比一个 NPE 好查。
  //
  // 另一个与上游不同的地方：header 参数上游是 **JSON 字符串**（GSON.fromJsonObject），
  // 📚聚合书库 却直接传了一个对象；两种都收，否则那个源的头会**静默**失效。
  connect: function (url, header) {
    var opts = { url: String(url) }
    var parsed = header
    if (typeof header === 'string') {
      try { parsed = JSON.parse(header) } catch (e) { parsed = null }
    }
    if (parsed && typeof parsed === 'object') {
      var map = {}
      for (var k in parsed) map[k] = String(parsed[k])
      opts.headers = map
    }
    var requestUrl = __host.resolveUrl(opts.url)
    var cached = null
    function detail() {
      if (cached === null) cached = JSON.parse(__host.fetchFull(JSON.stringify(opts)))
      return cached
    }
    // 与 java.get / java.post 共用同一套响应方法（见 __attachResponse 的说明）。
    // 差别只在**取数时机**：这里的 url() 是解析出来的、不发请求，
    // body() / code() / headers() 才触发那唯一一次请求。
    var response = __attachResponse({}, detail, requestUrl)
    // 规则直接把响应对象返回时（result = java.connect(url)），串化要给出正文而不是 {}
    response.toString = function () { return response.body() }
    return response
  },
  // 中文数字转阿拉伯数字（toNumChapter('第一百二十三章') -> 123）。纯计算，无需桥
  toNumChapter: function (text) {
    var s = String(text)
    var digits = { '零': 0, '〇': 0, '一': 1, '壹': 1, '二': 2, '两': 2, '贰': 2, '三': 3, '叁': 3, '四': 4, '肆': 4, '五': 5, '伍': 5, '六': 6, '陆': 6, '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9 }
    var units = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 }
    var found = String(s).match(/[零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万萬亿億]+/)
    if (!found) return s
    var num = 0, section = 0, current = 0, matched = false
    var word = found[0]
    for (var i = 0; i < word.length; i++) {
      var ch = word.charAt(i)
      if (digits[ch] !== undefined) { current = digits[ch]; matched = true; continue }
      if (ch === '万' || ch === '萬') { num += (section + current) * 10000; section = 0; current = 0; matched = true; continue }
      if (ch === '亿' || ch === '億') { num = (num + section + current) * 100000000; section = 0; current = 0; matched = true; continue }
      var unit = units[ch]
      if (unit === undefined) continue
      // 十五 是 15 而不是 105：十前面没有数字时按 1 算
      section += (current === 0 ? 1 : current) * unit
      current = 0
      matched = true
    }
    if (!matched) return s
    var value = num + section + current
    if (value <= 0) return s
    return s.replace(word, String(value))
  },
  // 对称加解密。算法与形状都在宿主侧（src/lib/aes.ts + symmetric.ts），
  // 这里只是把「方法名 + 参数」打包送过去 —— 同步桥，脚本里是普通函数调用。
  //
  // Legado 的形状：createSymmetricCrypto(transformation, key, iv) 返回一个对象，
  // 上面有 encrypt / decrypt / encryptBase64 / decryptBase64 /
  // encryptBase64ToString / decryptBase64ToString / encryptHex / decryptHex。
  // 线上 14 处 createSymmetricCrypto + 18 处 aesBase64DecodeToString。
  __crypto: function (op, transformation, key, iv, data) {
    var raw = __host.crypto(JSON.stringify({
      op: String(op),
      transformation: String(transformation),
      key: key,
      iv: iv === undefined ? null : iv,
      data: data,
    }))
    var res = JSON.parse(raw)
    if (!res.ok) { throw new Error(res.error) }
    return res.value
  },
  createSymmetricCrypto: function (transformation, key, iv) {
    var tf = String(transformation)
    var k = key
    var v = iv === undefined ? null : iv
    function call(op, data) { return java.__crypto(op, tf, k, v, data) }
    return {
      encrypt: function (data) { return call('encrypt', data) },
      decrypt: function (data) { return call('decrypt', data) },
      encryptBase64: function (data) { return call('encryptBase64', data) },
      decryptBase64: function (data) { return call('decryptBase64', data) },
      encryptBase64ToString: function (data) { return call('encryptBase64ToString', data) },
      decryptBase64ToString: function (data) { return call('decryptBase64ToString', data) },
      encryptHex: function (data) { return call('encryptHex', data) },
      decryptHex: function (data) { return call('decryptHex', data) },
    }
  },
  // aesBase64DecodeToString(data, key, transformation, iv) —— 参数顺序与 Legado 一致
  aesBase64DecodeToString: function (data, key, transformation, iv) {
    return java.__crypto('decryptBase64ToString', transformation, key, iv, data)
  },
  // ---------------------------------------------------------------- 上游那批「旧版对称加密」包装
  //
  // 上游 JsEncodeUtils.kt 里这一批全带 @Deprecated（"过于繁琐弃用"），
  // 方法体一律是「createSymmetricCrypto(transformation, key, iv).某方法(data)」的一行 ——
  // 所以这里也照抄成一行，不再各写一套。语料里它们 0 次调用，
  // 但用户自己导入的书源可能还在用，而实现成本就是一行。
  //
  // 语义以**上游方法体**为准，不看名字猜：
  aesDecodeToByteArray: function (str, key, transformation, iv) {
    return java.__crypto('decryptBase64', transformation, key, iv, str)
  },
  aesBase64DecodeToByteArray: function (str, key, transformation, iv) {
    return java.__crypto('decryptBase64', transformation, key, iv, str)
  },
  aesDecodeToString: function (str, key, transformation, iv) {
    return java.__crypto('decryptBase64ToString', transformation, key, iv, str)
  },
  aesEncodeToByteArray: function (data, key, transformation, iv) {
    return java.__crypto('encrypt', transformation, key, iv, data)
  },
  aesEncodeToString: function (data, key, transformation, iv) {
    return java.__crypto('encryptBase64', transformation, key, iv, data)
  },
  aesEncodeToBase64ByteArray: function (data, key, transformation, iv) {
    return java.strToBytes(java.__crypto('encryptBase64', transformation, key, iv, data))
  },
  aesEncodeToBase64String: function (data, key, transformation, iv) {
    return java.__crypto('encryptBase64', transformation, key, iv, data)
  },
  aesBase64EncodeToString: function (data, key, transformation, iv) {
    return java.__crypto('encryptBase64', transformation, key, iv, data)
  },
  // 这两个「ArgsBase64」在上游**不对称**：解码版把 key/iv 先 base64 解成字节，
  // 加密版直接用原字符串。照抄 —— 改了就与上游算出来的密文不一致。
  aesDecodeArgsBase64Str: function (data, key, mode, padding, iv) {
    return java.__crypto(
      'decryptBase64ToString',
      'AES/' + mode + '/' + padding,
      java.base64DecodeToByteArray(key),
      java.base64DecodeToByteArray(iv),
      data,
    )
  },
  aesEncodeArgsBase64Str: function (data, key, mode, padding, iv) {
    return java.__crypto('encryptBase64', 'AES/' + mode + '/' + padding, key, iv, data)
  },
  desDecodeToString: function (data, key, transformation, iv) {
    return java.__crypto('decryptBase64ToString', transformation, key, iv, data)
  },
  desBase64DecodeToString: function (data, key, transformation, iv) {
    return java.__crypto('decryptBase64ToString', transformation, key, iv, data)
  },
  // 上游是 String(encrypt(data))：把密文字节按 UTF-8 解成字符串
  // （非 UTF-8 的字节会被替换成 U+FFFD —— 与上游一样是有损的，别拿它当可靠编码）
  desEncodeToString: function (data, key, transformation, iv) {
    return java.bytesToStr(java.__crypto('encrypt', transformation, key, iv, data))
  },
  desEncodeToBase64String: function (data, key, transformation, iv) {
    return java.__crypto('encryptBase64', transformation, key, iv, data)
  },

  // ---------------------------------------------------------------- 摘要与 HMAC
  //
  // 三个成员共用宿主那一条 hash 桥（见 js.ts 里 hashFn）：输入输出约定一样，
  // 只有算法与要不要密钥不同。算法名归一化在宿主侧做 —— 语料里有
  // "SHA-256" / "sha-256" / "HmacSHA256" / "HMAC-SHA1" 四种写法。
  __hash: function (op, algorithm, key, data, encoding) {
    return __host.hash(JSON.stringify({
      op: String(op),
      algorithm: String(algorithm),
      key: key === undefined || key === null ? '' : String(key),
      data: String(data),
      encoding: String(encoding),
    }))
  },
  digestBase64Str: function (data, algorithm) {
    return java.__hash('digest', algorithm, '', data, 'base64')
  },
  HMacHex: function (data, algorithm, key) {
    return java.__hash('hmac', algorithm, key, data, 'hex')
  },
  HMacBase64: function (data, algorithm, key) {
    return java.__hash('hmac', algorithm, key, data, 'base64')
  },
  // 上游 MD5Utils.md5Encode16 就是 md5Encode(str).substring(8, 24)（抄自该方法体）
  md5Encode16: function (str) {
    return java.md5Encode(String(str)).substring(8, 24)
  },
  // 十六进制 → 字节数组（hexDecodeToString 的字节数组版本，线上 8 处）
  hexDecodeToByteArray: function (hex) {
    var cleaned = String(hex).replace(/[^0-9a-fA-F]/g, '')
    var out = []
    for (var i = 0; i + 1 < cleaned.length; i += 2) {
      out.push(parseInt(cleaned.slice(i, i + 2), 16))
    }
    return out
  },

  // 简繁转换。**没有字典表就不做**：原样返回并记一条日志。
  //
  // 为什么不塞一张「常用字」小表：转换是**逐字映射**，表不全就会出现「半简半繁」
  // 的正文 —— 那比整篇繁体更让人以为是站点排版坏了。而完整的对照表（OpenCC 的
  // TSCharacters 有五千多条，含大量罕用字）不适合手抄进源码，抄错几个字的代价
  // 是静默给出错字。所以宁可不转，也不给一个看起来像那么回事的半成品。
  t2s: function (s) { __host.log('[t2s] 未做简繁转换，原样返回'); return String(s) },
  s2t: function (s) { __host.log('[s2t] 未做简繁转换，原样返回'); return String(s) },

  // 需要 WebView / 浏览器 / Android / 文件系统的那一批**不在这里手写**：
  // 它们由 src/engine/platform.ts 的成员表统一生成（见文件末尾的 unsupportedPrelude），
  // 表里同时记着上游签名、缺的是哪一类平台能力、以及换了平台之后该由谁来提供。
  // java.setContent(content[, baseUrl])：把「当前内容」换成传进来的这一段
  //
  // Legado 里它改的是**后续规则求值的对象**：设过之后，java.getString(规则) 与
  // java.getElements(规则) 不带第二个参数时就在这份内容上求值，而不是在原来的页面上。
  // ⚡📂八一中文网 的搜索规则就是这个套路 —— 发现搜索地址变了就自己 POST 一次，
  // 用 setContent 把响应换成新内容，再 getElements("#nr||#sitebox dl") 取结果
  // （线上 13 条源 / 18 处）。早先这里是一条「需要 WebView」的明确报错，
  // 但这件事**根本不需要 WebView**：getString / getElements 本来就有
  // 「第二个参数是内容」那条路（显式传内容线上几十处），这里只是把「不传第二个参数」
  // 也变成传。所以改成真的实现。
  //
  // 第二个参数（新的 baseUrl）**忽略**：相对地址由宿主侧按这次请求的上下文补全，
  // 沙箱改不了它。语料里传它的只有一处，且传的是同一个地址。
  setContent: function (content) {
    java.__content = content === undefined || content === null ? '' : String(content)
    return java.__content
  },
  // 没设过 setContent 时用「当前节点」（宿主侧解释 null）
  __content: null,

  // java.digestHex(str[, algorithm])：摘要的十六进制
  //
  // 线上 5 处，算法是 MD5 与 SHA-256（后者在拼 App 接口签名）。其余算法**明确报错**，
  // 不静默给空 —— 签名算错的表现是「接口返回 403 / 数据不对」，比报错难查得多。
  digestHex: function (s, algorithm) {
    var alg = String(algorithm === undefined || algorithm === null ? 'MD5' : algorithm)
      .toUpperCase().replace(/-/g, '')
    if (alg === 'MD5') return __host.md5(String(s))
    if (alg === 'SHA256') return __host.sha256(String(s))
    throw new Error('本引擎的 java.digestHex 只实现了 MD5 与 SHA-256，不支持 ' + alg)
  },
  alert: function (s) { __host.log('[alert] ' + String(s)) },
  logType: function (s) { __host.log(String(s)) },

  // 当前使用的 UA。getWebViewUA 之外的两个别名，线上另有 4 处 java.getUserAgent
  getUserAgent: function () { return java.getWebViewUA() },
  getUA: function () { return java.getWebViewUA() },

  // 字节数组 → 字符串（按 UTF-8），strToBytes 的反向。线上 5 处（丁丁小说等）
  bytesToStr: function (bytes) {
    var esc = ''
    for (var i = 0; i < bytes.length; i++) {
      var b = Number(bytes[i]) & 255
      esc += '%' + (b < 16 ? '0' : '') + b.toString(16)
    }
    try { return decodeURIComponent(esc) } catch (e) { return esc }
  },

  // ---------------------------------------------------------------- 本平台没有的成员
  //
  // 这一批**不在源码里手写**：由 src/engine/platform.ts 的成员表（对着上游
  // help/JsExtensions.kt 与 help/JsEncodeUtils.kt 抄的面）生成，每个成员都带
  // 「上游签名 + 缺的是哪一类平台能力」。这样加一个成员、换一个平台都只改那一张表。
  //
  // 为什么是报错而不是返回空：这里没有一个「安全的中性值」—— 拿空 UA 去拼签名、
  // 拿空验证码去登录，错误都会跑到下游，症状离原因更远。而 QuickJS 的
  // TypeError: not a function 又不说**是哪一个**，所以报错里必须自带名字。
${unsupportedPrelude()}
}
`

/**
 * 书源脚本里那几个「全局对象」：`source` / `cookie` / `cache` / `infoMap` /
 * `org.jsoup` / `Packages`
 *
 * 放在 java 之后单独一段，是因为它依赖 java（`source.refreshExplore` 要调它），
 * 而 java 又必须先用上 `__host`。
 *
 * 三个刻意的取舍：
 *   1. **cookie 与 cache 只在本次求值里存在**。它们是内存对象，求值结束就销毁。
 *      真正的跨规则持久化需要一张表 + 按书源隔离，这里没有做 ——
 *      书源里绝大多数用法是「同一段脚本里先存后取」，内存版足够。
 *   2. **`Packages` 只实现了 MD5 那几个类**。`Packages.java.xxx` 是 Java 反射桥，
 *      引擎里没有 JVM；没实现的类一律**报出类名**，让失败原因可归类。
 *   3. **`org.jsoup` 的写操作是空实现**。节点集在宿主侧是共享对象，
 *      改它会串到同一份文档的其它句柄上（jsoup 在 Java 里是深拷贝语义），
 *      宁可不改也不改错。
 */
const GLOBALS_PRELUDE = `
// ---------------------------------------------------------------- 工具

function __toJavaMap(text) {
  var out = {}
  try {
    var parsed = JSON.parse(String(text === undefined || text === null ? '' : text) || '{}')
    if (parsed && typeof parsed === 'object') {
      for (var k in parsed) out[k] = String(parsed[k])
    }
  } catch (e) {}
  out.get = function (k) { var v = out[String(k)]; return v === undefined ? '' : v }
  out.put = function (k, v) { out[String(k)] = String(v) }
  out.containsKey = function (k) { return Object.prototype.hasOwnProperty.call(out, String(k)) }
  return out
}

// 登录表单：宿主把用户填的字段以 JSON 注进来（__loginFields），这里包成
// 「同时支持 result.get(k) 与 result[k]」的对象 —— 语料里两种读法都有
// （🏷晋江文学 写的是 (typeof result)=="string" ? this.M("账号") : result.get("账号")）。
// 只在**跑登录脚本**那一次注入了 __loginFields、而且宿主没有另外给 result 时才生效，
// 平时的规则求值完全不受影响。
//
// 它挪到 PER_EVAL_PRELUDE 里了（第五十九轮）：这一步**每次求值都要重来**，
// 而它依赖的 __toJavaMap 是静态的，两边分开正好

// ---------------------------------------------------------------- book / chapter
//
// 当前这本书与这一章。宿主每次求值把客户端带上来的那份 JSON 注进来
// （见 engine/globals.ts 的 baseGlobals），这里只挂上变量读写。
//
// 语料上它们是**用得最多的一组上下文**：book.name 54 处 / 39 源、book.author 27/18、
// book.bookUrl 32/16、book.origin 13/10、chapter.title 32/30、chapter.index 4/4。
// 在此之前 ctx.book 从来没人赋过值，于是 '【' + book.name + '】' 拼出「【undefined】」
// —— 不报错，只是结果不对，比抛异常难查得多。
/**
 * 造一个 book 全局对象
 *
 * 第五十九轮：从「每次求值都把整段预置重新解析一遍」改成「预置只解析一次、
 * 每次求值**重新造一个对象**」—— 方法体写在这个函数里，于是也只解析一次，
 * 而每次调用只是新建几个函数对象（0.01ms 量级，见 README 第五十九轮）。
 *
 * 必须是「造」而不是「改」：宿主每次求值会把**裸数据**注入成全局 book，
 * 那个名字正好会盖掉这个对象 —— 所以只能等注入之后重新造一个，不能就地改。
 */
function __buildBook() {
  var data = globalThis.book || {}
  var obj = {}
  for (var k in data) obj[k] = data[k]
  // 名字/地址这类标量**总是**给字符串：书源里普遍直接拼（'【' + book.name + '】'），
  // 给 undefined 会拼出字面量 "undefined"，给 null 更糟（'null'）。
  if (obj.name === undefined || obj.name === null) obj.name = ''
  if (obj.author === undefined || obj.author === null) obj.author = ''
  if (obj.bookUrl === undefined || obj.bookUrl === null) obj.bookUrl = ''
  if (obj.origin === undefined || obj.origin === null) obj.origin = ''
  // book.getVariable(name) 读这本书的变量（Legado 的 Book.getVariable）。
  // 语料里 14 处全是**带名字**的（book.getVariable("custom") / ("bid")），
  // 没有无参写法 —— 无参给空串，绝不回整张表的 JSON。
  obj.getVariable = function (name) {
    var v = __bookVarsOut[String(name)]
    return v === undefined || v === null ? '' : String(v)
  }
  // book.putVariable(name, value) 写这本书的变量（语料 20 处，全部两参）。
  // 写进 __bookVarsOut 供同一次请求后面的规则立刻读到，同时记进 __bookVarsDirty
  // 交给宿主落库（见 collectBookVars）—— 一章一次请求，不落库就要每章重探一次。
  obj.putVariable = function (name, value) {
    var key = String(name)
    var text = value === undefined || value === null ? '' : String(value)
    __bookVarsOut[key] = text
    __bookVarsDirty[key] = text
  }
  // 别名：Legado 的 Book 上没有这两个，但书源里偶有 get/put 写法，给它们不至于报错
  obj.get = obj.getVariable
  obj.put = obj.putVariable
  obj.setVariable = obj.putVariable
  obj.getVariableMap = function () { return __bookVarsOut }
  obj.putVariableMap = function (map) {
    if (!map) return
    for (var k in map) obj.putVariable(k, map[k])
  }
  // book.setReverseToc(flag)：上游用它把目录倒序显示。语料 2 处（📂就去看网 / 📂言情小说）
  // 都写在 **ruleBookInfo.name 的中途** —— 没有这个方法时那一句直接抛错，
  // 连书名都取不到（比「目录顺序不对」严重得多）。本引擎不改目录顺序，只把意图记下来。
  obj.reverseToc = false
  obj.setReverseToc = function (flag) { obj.reverseToc = !!flag }
  // book.putCustomVariable(value)：上游语义未确认。语料 3 处都只往里放一条状态字符串、
  // 没有任何地方读回（🏷晋江文学 的目录菜单放「开启•购买」、🌍🔞爱丽丝书屋 放空串清掉）。
  // 存下来、不报错；**不与书变量表混用**，免得它去顶替某个真变量。
  obj.putCustomVariable = function (value) {
    obj.customVariable = value === undefined || value === null ? '' : String(value)
  }
  return obj
}
var book = __buildBook()

// 当前这一章（chapter.title 32 处 / 30 源、chapter.index 4 处 / 4 源）
//
// 章节变量与书的变量**共用一张表**：Legado 里 Chapter 也有自己的一张，但语料里
// chapter.getVariable 是 0 处、只有 📂就去看网 / 📂言情小说 写 chapter.putVariable("next", …)
// （而且读回来用的是 java.get("next")，不是 chapter.getVariable）。各自一张的话，
// 写进去的值没有任何人能读到；共表既不报错，也顺带让它跨请求留住。
/** 造一个 chapter 全局对象（理由同 __buildBook） */
function __buildChapter() {
  var data = globalThis.chapter || {}
  var obj = {}
  for (var k in data) obj[k] = data[k]
  if (obj.title === undefined || obj.title === null) obj.title = ''
  if (obj.name === undefined || obj.name === null) obj.name = obj.title
  obj.getVariable = function (name) { return book.getVariable(name) }
  obj.putVariable = function (name, value) { book.putVariable(name, value) }
  obj.getVariableMap = function () { return book.getVariableMap() }
  // chapter.isVip()：上游的「这一章要不要付费」。语料 1 处（🏷起点(部分可看) 的正文规则
  // if (chapter.isVip()) { 走 JSON } else { 走 jsoup }）—— 没有它时报 TypeError，
  // **整章正文一条都取不到**。但目录带上来的章节上下文目前只有 title / name / url / index
  // （见 index.ts 的 requestChapterContext），没有 vip 标记，所以现在恒为 false：
  // 免费章走对分支、付费章走错 —— 这是「缺信息」，不是「方法不存在」。
  obj.isVip = function () { return data.isVip === true || data.isVip === 'true' || data.isVip === 1 }
  // chapter.putImgUrl(url)：上游把这一章的图片地址写回章节对象。语料 1 处
  // （🏷书旗小说 的 ruleContent.title，写在 try 里、只为清掉旧值）。
  // 节点集在宿主侧是共享的，改它会串到同一份文档的其它句柄上，所以是空实现。
  obj.putImgUrl = function () {}
  return obj
}
var chapter = __buildChapter()

// ---------------------------------------------------------------- source

/** 造一个 source 全局对象（理由同 __buildBook） */
function __buildSource() {
  var data = globalThis.__source || {}
  // 会话变量表：只给两参写法（source.setVariable(k, v)）与 source.get(k) 用，
  // 与 java.put / java.get(k) 共用同一张（两条路各存一份的话，脚本里 put 完
  // 规则里 get(k) 就读不到）。书源自己的 variable 不走这里，见下面 getVariable。
  var vars = globalThis.__varsOut || {}

  var obj = {}
  for (var k in data) {
    if (k === 'key') continue
    obj[k] = data[k]
  }
  obj.key = data.key === undefined || data.key === null ? '' : String(data.key)
  obj.variable = data.variable === undefined || data.variable === null ? '' : String(data.variable)
  obj.__loginHeader = String(globalThis.__loginHeader || '')
  obj.__loginInfo = String(globalThis.__loginInfo || '')

  obj.getKey = function () { return String(obj.key || '') }
  // 书源自己的 variable（Legado 的 BookSource.variable）：起点是空串，由书源自己填

  // 两种读法，按**参数个数**分派（与 java.get 同一套思路）：
  //   无参 -> 书源自己的 variable 字符串（Legado 的 getVariable()，线上 126 处）
  //   有参 -> 会话变量表里的某一项（本引擎以前的形状，source.get(k) 那 8 个源在用）
  //
  // 以前无参时回的是**整张会话变量表的 JSON**，而书源把它当自己的配置字符串用：
  // 读出来的是 {"key":"斗破苍穹"} 这种完全不相干的东西。两条路分不开的话，
  // 24 个「读配置 → 改配置 → 写回去」的源（🎨漫蛙 / 🌍🔞爱丽丝书屋 / 🏷七猫小说 …）
  // 每次都要重新初始化，而症状只是「设置好像没保存」。
  obj.getVariable = function (name) {
    if (name !== undefined && name !== null) {
      var v = vars[String(name)]
      return v === undefined || v === null ? '' : String(v)
    }
    return String(obj.variable === undefined || obj.variable === null ? '' : obj.variable)
  }
  // 同理按参数个数分派：一参是 Legado 的 setVariable(整串)，两参是会话表（老写法）
  obj.setVariable = function (a, b) {
    if (arguments.length >= 2) {
      __varsPut(a, b)
      return
    }
    obj.variable = a === undefined || a === null ? '' : String(a)
    // 记一笔给宿主收走：它负责更新会话、并把值写回库（见 collectSourceVariable）
    globalThis.__sourceVariableOut = obj.variable
  }
  obj.putVariable = obj.setVariable
  obj.get = obj.getVariable
  obj.put = obj.setVariable
  obj.getVariableMap = function () { return vars }
  obj.getHeaderMap = function () { return __toJavaMap(obj.header) }
  /**
   * 登录态：起点是**库里存着的那一份**（注入的 __loginHeader / __loginInfo），
   * 每次改动都记一笔给宿主收走落库（见 collectLogin）。
   *
   * 以前它们只活在这一次求值里 —— 于是「登录一次、之后每趟请求都带着」根本不成立：
   * 登录脚本写下的头，下一次求值（乃至下一个请求）读到的都是空串。
   * 线上 15 处 putLoginHeader / 8 处 putLoginInfo 写、30 处 getLoginHeader* / 28 处
   * getLoginInfo* 读，两边一直对不上（见「第五十七轮」）。
   */
  obj.getLoginHeader = function () { return String(obj.__loginHeader || '') }
  obj.getLoginHeaderMap = function () { return __toJavaMap(obj.__loginHeader) }
  obj.putLoginHeader = function (header) {
    obj.__loginHeader = header === undefined || header === null ? '' : String(header)
    globalThis.__loginHeaderOut = obj.__loginHeader
  }
  obj.getLoginInfoMap = function () {
    // Legado 那边 getLoginInfoMap() 返回的是一个 Java Map，书源因此写成
    // info.get("vid")（还会先判 info == null）。这里以前直接返回一个裸的 {}，
    // 连 putLoginInfo 也是空函数 —— 于是 .get 不存在，报出来的是
    // TypeError: not a function，一个把方向完全指偏的错：真正的原因往往是
    // 「这份源需要登录，而当前没有登录信息」，而书源自己带着那句清楚的提示，
    // 只是走不到（🏷微信读书二合一本地源 就是这么报的）。
    //
    // __toJavaMap 给出的对象同时支持 map.get(k) 与 map[k]（线上两种写法都有），
    // 缺键回空串 —— 与 getLoginHeaderMap 同一套。
    // 线上 getLoginInfoMap 30 处 / 16 源、putLoginInfo 12 处 / 8 源。
    if (!obj.__loginInfoMap) obj.__loginInfoMap = __toJavaMap(obj.__loginInfo)
    return obj.__loginInfoMap
  }
  obj.putLoginInfo = function (info) {
    obj.__loginInfo = info === undefined || info === null ? '' : String(info)
    // 重建一份，保证「先 put 再 get」在同一个脚本里就能读到
    obj.__loginInfoMap = __toJavaMap(obj.__loginInfo)
    globalThis.__loginInfoOut = obj.__loginInfo
  }
  // getLoginInfo() 与 putLoginInfo 配套：上游返回登录信息**字符串**，
  // 源自己 JSON.parse 后按键取。语料 2 处（🎨漫蛙 / 🎨🔞禁漫天堂），都写成
  // JSON.parse(source.getLoginInfo())[键]；没登录时这里是空串，JSON.parse 会抛 ——
  // 但那两句本来就写在 try 里，抛了正好落到「未登录」那条分支。
  obj.getLoginInfo = function () {
    return String(obj.__loginInfo === undefined || obj.__loginInfo === null ? '' : obj.__loginInfo)
  }
  obj.removeLoginInfo = function () {
    obj.__loginInfo = ''
    obj.__loginInfoMap = __toJavaMap('')
    // 退出登录也要**落库**：不记这一笔的话，库里那份还在，下一趟请求又带上了
    globalThis.__loginInfoOut = ''
  }
  // 退出登录：语料 4 处 / 4 源（🌍🔞爱丽丝书屋 / 📂完本神站（登录）/ 🏷七猫小说 /
  // ⚡📂三五中文，都在 logout / clearLogin 那条路上），与 putLoginHeader 对称。
  obj.removeLoginHeader = function () {
    obj.__loginHeader = ''
    globalThis.__loginHeaderOut = ''
  }
  // source.putConcurrent("并发数/间隔")：上游拿它调**书架刷新**的并发。
  // 语料 2 处（🔞 Linpx / 🔞兽人小说站 的 startShelfRefresh / endShelfRefresh 回调），
  // 本引擎没有书架刷新，空实现。
  obj.putConcurrent = function () {}
  obj.refreshExplore = function () { java.refreshExplore() }
  obj.setExploreScreen = function () {}
  return obj
}
var source = __buildSource()

// ---------------------------------------------------------------- cookie / cache
//
// cookie 罐按**主机名**存（见 src/lib/cookies.ts），与宿主侧那一个模块同一套语义：
//   收 —— 每个响应的 Set-Cookie 由取网层收进来（这里不再收）
//   发 —— 请求前由取网层按主机名拼 Cookie 头
//   存 —— 书源开着 enabledCookieJar 时按源落库
//
// 沙箱这一侧只做两件事：**读写注入进来的那一份**，以及把改动记到 __cookieJarOut
// 让求值结束后被 collectCookies 收回去。书源没开 CookieJar 时注入的是空表，
// 于是 cookie.* 退回「只活本次求值」的老行为 —— 与它自己声明的取舍一致。
//
// 取不到时返回空串，与原项目的语义一致 —— 返回 null 会让 cookie.getCookie(u).length 这类写法报错。
//
// 注意：这一段是模板字符串的一部分 —— 里面**不能写带反斜杠的正则**（模板字符串会把
// 反斜杠吃掉：转义过的斜杠只剩斜杠、空白类只剩它后面那个字母，正则会悄悄变形，
// 甚至直接变成语法错误）。所以下面几个小助手一个反斜杠都不用。

function __cookieHost(url) {
  var s = String(url === undefined || url === null ? '' : url).trim()
  if (s === '') return ''
  var scheme = s.indexOf('://')
  if (scheme > 0) s = s.slice(scheme + 3)
  else if (s.slice(0, 2) === '//') s = s.slice(2)
  var cut = s.length
  var marks = ['/', '?', '#']
  for (var i = 0; i < marks.length; i++) {
    var at = s.indexOf(marks[i])
    if (at !== -1 && at < cut) cut = at
  }
  var host = s.slice(0, cut)
  var at2 = host.indexOf('@')
  if (at2 !== -1) host = host.slice(at2 + 1)
  var colon = host.indexOf(':')
  if (colon !== -1) host = host.slice(0, colon)
  return host.toLowerCase()
}

// 「这个站的 cookie」是哪几个主机。比宿主侧发请求时那一份**宽**：除了自己和各级父域，
// 还往下找子域 —— 站点常把会话 cookie 下在 m.xxx.com 上，而书源问的是 xxx.com
// （🏷起点 的发现页模板就是 cookie.getKey("https://qidian.com","_csrfToken")，
// 而它的页面全在 m.qidian.com 上）。这里是「脚本看这个站」，不是「这次请求发什么」，
// 发出去的那一份由取网层按严格的父子域规则拼（见 src/lib/cookies.ts）。
function __cookieRelated(jar, host) {
  var out = [host]
  var parts = host.split('.')
  for (var i = 1; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'))
  var suffix = '.' + host
  var subs = []
  for (var k in jar) {
    if (k !== host && k.length > suffix.length && k.slice(k.length - suffix.length) === suffix) {
      subs.push(k)
    }
  }
  subs.sort()
  return out.concat(subs)
}

function __cookiePairs(text) {
  var out = []
  var parts = String(text).split(';')
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i].trim()
    var eq = seg.indexOf('=')
    if (eq > 0) out.push([seg.slice(0, eq).trim(), seg.slice(eq + 1).trim()])
  }
  return out
}

function __cookieMerge(existing, incoming) {
  var order = []
  var map = {}
  var all = __cookiePairs(existing).concat(incoming)
  for (var i = 0; i < all.length; i++) {
    var name = all[i][0]
    if (!Object.prototype.hasOwnProperty.call(map, name)) order.push(name)
    map[name] = all[i][1]
  }
  var out = []
  for (var j = 0; j < order.length; j++) out.push(order[j] + '=' + map[order[j]])
  return out.join('; ')
}

/** 造一个 cookie 全局对象（理由同 __buildBook） */
function __buildCookie() {
  var jar = {}
  var dirty = {}
  try {
    var injected = JSON.parse(String(globalThis.__cookieJar || '{}'))
    if (injected && typeof injected === 'object') {
      for (var k in injected) jar[String(k).toLowerCase()] = String(injected[k])
    }
  } catch (e) {}

  // 记一笔改动：宿主求值结束后按这张表更新罐子（空串表示删掉这个主机）。
  // 只记**改过的主机** —— 整份回传会把求值期间取网层刚收进来的 cookie 覆盖掉。
  function touch(host) {
    dirty[host] = jar[host] === undefined ? '' : String(jar[host])
    globalThis.__cookieJarOut = JSON.stringify(dirty)
  }

  // 这个请求会带上的那一串（含各级父域的合并，更具体的先出现、同名以它为准）
  function stored(url) {
    var host = __cookieHost(url)
    if (host === '') return ''
    var names = __cookieRelated(jar, host)
    var seen = {}
    var out = []
    for (var i = 0; i < names.length; i++) {
      var value = jar[names[i]]
      if (!value) continue
      var ps = __cookiePairs(value)
      for (var j = 0; j < ps.length; j++) {
        if (Object.prototype.hasOwnProperty.call(seen, ps[j][0])) continue
        seen[ps[j][0]] = 1
        out.push(ps[j][0] + '=' + ps[j][1])
      }
    }
    return out.join('; ')
  }

  var api = {
    getCookie: function (url) { return stored(url) },
    getCookieMap: function () { return jar },
    getKey: function (url, key) {
      var name = String(key)
      var ps = __cookiePairs(stored(url))
      for (var i = 0; i < ps.length; i++) if (ps[i][0] === name) return ps[i][1]
      return ''
    },
    // setCookie 按**名字合并**（同名覆盖、其余留着）；replaceCookie 整串换掉
    setCookie: function (url, value) {
      var host = __cookieHost(url)
      if (host === '') return
      var incoming = __cookiePairs(String(value === undefined || value === null ? '' : value))
      if (incoming.length === 0) return
      jar[host] = __cookieMerge(jar[host] || '', incoming)
      touch(host)
    },
    replaceCookie: function (url, value) {
      var host = __cookieHost(url)
      if (host === '') return
      var text = String(value === undefined || value === null ? '' : value)
      if (text === '') delete jar[host]
      else jar[host] = __cookieMerge('', __cookiePairs(text))
      touch(host)
    },
    removeCookie: function (url) {
      var host = __cookieHost(url)
      if (host === '') return
      if (jar[host] !== undefined) delete jar[host]
      touch(host)
    },
  }
  return api
}
var cookie = __buildCookie()

/** 造一个 cache 全局对象（理由同 __buildBook；它没有「站点下发」这个来源，每次都是空的） */
function __buildCache() {
  var memory = {}
  return {
    get: function (name) { var v = memory[String(name)]; return v === undefined ? '' : v },
    put: function (name, value) { memory[String(name)] = String(value) },
    getFromMemory: function (name) { var v = memory[String(name)]; return v === undefined ? '' : v },
    putMemory: function (name, value) { memory[String(name)] = String(value) },
    delete: function (name) { delete memory[String(name)] },
    deleteMemory: function (name) { delete memory[String(name)] },
    // 文件缓存要落盘，服务端没有可持久化的私有文件系统：明确返回空
    getFile: function () { return '' },
    putFile: function () {},
    getFileUrl: function () { return '' },
    putFileUrl: function () {},
  }
}
var cache = __buildCache()

/** 发现页筛选器的当前选择。我们不做那套交互界面，所以是空的，脚本会落到自己写的默认值 */
var infoMap = globalThis.__infoMap || {}

// ---------------------------------------------------------------- org.jsoup

function __jsoupCall(op, handleId, args) {
  var raw = __host.jsoup(JSON.stringify({
    op: op,
    handle: handleId === undefined || handleId === null ? null : handleId,
    args: args || [],
  }))
  var reply = JSON.parse(raw)
  if (!reply.ok) throw new Error(reply.error)
  return reply
}

function JsoupElements(id) { this.__id = id }

/**
 * 沙箱里 jsoup 对象的**方法面** —— 只有这一份清单
 *
 * 它要挂在四种包装上：
 *
 *   1. JsoupElements（java.getElements(规则) 与它自己的返回值）
 *   2. org.jsoup.Jsoup.parse(整页) 的返回值
 *   3. 「命中多个节点」时的**数组形态**（能下标、能 forEach / map）
 *   4. 单个元素的「盒装字符串」（脚本常常直接把它 return 回去，要能串化成文本）
 *
 * 以前这四份是**各写一遍的字面量数组**，于是漂了，而且是两种不同的漂：
 *
 *   - **桥里根本没有 data 这个 op**，四份清单也都没写它 ——
 *     📂少年小说网 的目录规则（Jsoup.parse(result).select("style").first().data()）
 *     因此报 TypeError: not a function，报错行号还指向规则里那一行；
 *     既不是选择器错、也不是桥那句「还不支持的方法：xxx()」，无从下手。
 *   - **改文档的那几个**（remove / addClass / …）只在第 1 份里有，
 *     于是 X.select(css).remove() 只要 X 不是 JsoupElements（脚本里的 result、
 *     Jsoup.parse(...) 的返回值）就炸 —— 线上 8 处是这么写的。
 *
 * 现在只留这一份，四种包装各取所需（数组那两种要去掉与 Array.prototype 撞名的）。
 * 加方法时改一处；test/jsoupSurface.test.ts 盯着清单与桥的 op 一一对上。
 */
var JS_SURFACE = [
  'select', 'selectFirst', 'get', 'first', 'last', 'eq', 'children', 'child', 'childNodeSize',
  'parent', 'parents', 'nextElementSibling', 'prevElementSibling', 'nextAll', 'prevAll',
  'siblingElements', 'not', 'filter', 'clone', 'has', 'is',
  'size', 'isEmpty', 'text', 'ownText', 'textNodes', 'eachText', 'data',
  'html', 'outerHtml', 'attr', 'hasAttr', 'attributes', 'val', 'className', 'hasClass',
  'tagName', 'id', 'index', 'matches', 'matchesOwn',
  'remove', 'addClass', 'removeClass', 'append', 'prepend',
]

/**
 * 返回值要**再包一层**的那几个 op（见 __valueOf）
 *
 * 只有 attributes 一个：桥给的是最小契约（一串 {key, value} 键值对），
 * 而脚本要的是 jsoup 的 Attribute（getKey() / getValue() / toString()）。
 * 这层包装放在沙箱里，宿主就不必知道脚本会拿这些属性当什么用。
 *
 * 其余所有 value 形态的 op（text / attr / size …）给什么就是什么，不加包装 ——
 * 这个表**故意是白名单**：谁加进来都得先想清楚为什么不能把包装放进桥里。
 */
var JS_VALUE_WRAPPERS = {
  attributes: __attrList,
}

/** value 形态的回复 → 交回给脚本的东西（见 JS_VALUE_WRAPPERS） */
function __valueOf(name, reply) {
  var wrap = JS_VALUE_WRAPPERS[name]
  return wrap ? wrap(reply.value) : reply.value
}

/**
 * 挂在**数组**上的那一份：与 Array.prototype 撞名的必须去掉
 *
 * filter 挂上去会被数组自己的 filter 顶掉；clone 同理 —— 都不该拿 jsoup 的语义
 * 去覆盖数组自己的方法。
 */
var JS_LIST_SURFACE = (function () {
  var clash = { filter: 1, clone: 1 }
  var out = []
  for (var i = 0; i < JS_SURFACE.length; i++) {
    if (!clash[JS_SURFACE[i]]) out.push(JS_SURFACE[i])
  }
  return out
})()

var JS_METHODS = JS_SURFACE
for (var __i = 0; __i < JS_METHODS.length; __i++) {
  (function (name) {
    JsoupElements.prototype[name] = function () {
      var reply = __jsoupCall(name, this.__id, Array.prototype.slice.call(arguments))
      if (reply.kind === 'handle') return reply.handle === null ? null : new JsoupElements(reply.handle)
      return __valueOf(name, reply)
    }
  })(JS_METHODS[__i])
}
JsoupElements.prototype.toString = function () {
  return String(__jsoupCall('toString', this.__id, []).value)
}
JsoupElements.prototype.toArray = function () {
  var out = []
  for (var i = 0; i < this.size(); i++) out.push(this.get(i))
  return out
}
/**
 * 让它**可迭代**，于是 Array.from(...) / for...of 都能用（第七十六轮）
 *
 * jsoup 的 Elements 本来就是个 List，所以书源里
 *
 *     x = Array.from(java.getElements("class.BCsectionTwo-top-chapter"))
 *     x.map(...)
 *
 * 是常规写法（📂贝壳读书 的整条目录就建立在这个 x 上）。而以前这里**没有
 * Symbol.iterator**：Array.from 对一个「既不可迭代、也没有 length」的对象
 * **不报错**，直接给一个空数组 —— 于是目录 0 章、没有 warning、书源也不报错，
 * 是最难查的那种静默故障。🎨51漫画 的 Array.from(java.getElement("script"))
 * 是同一个坑的另一个形状（第四十九轮修的是它返回 null 那一半）。
 *
 * 交给 toArray()：条目的形态与别处一致（每个元素的 String() 就是它自己的 outerHTML）。
 */
JsoupElements.prototype[Symbol.iterator] = function () {
  return this.toArray()[Symbol.iterator]()
}
// 书源里偶尔用 .eachText() 的返回值当数组迭代，这里保证它一定是数组
JsoupElements.prototype.copy = function () { return this.clone() }

/**
 * 把一段 HTML 包成「字符串 + jsoup 方法」
 *
 * Legado 的字段规则里 result 有两种用法，而且**同一条书源里都会出现**：
 *
 *   @js:JSON.parse(result).data        当成字符串（44 处）
 *   @js:result.select('h3').text()     当成 jsoup 对象（18 处）
 *
 * 只用字符串的话，第二种会在 String.prototype.select is not a function 上炸掉 ——
 * 而报错行号指向规则第一行，看不出缺的是「result 不是对象」。
 *
 * 所以这里用 new String(html) 作为底座：它仍是字符串（JSON.parse、String()、
 * indexOf、replace 全都照常），只是额外挂了 jsoup 的那几个方法。
 * 只有脚本真的写了 result.select(...) 才这么包（见 analyze.ts 的 resultGlobals），
 * 以免 typeof result 从 'string' 变成 'object'。
 */
function __htmlApi(html) {
  var cached = null
  function docHandle() {
    if (cached === null) cached = __jsoupCall('parse', null, [html]).handle
    return cached
  }
  /**
   * 返回句柄的那些方法（select / first / get / not …）给的是**数组形态**，
   * 于是 links[i] 与 links.length 都能用（🔞紫云宫 的目录规则正是这么写的）。
   * 以前这里返回裸的 JsoupElements：它既不能下标也没有 length，
   * links[i] 恒为 undefined，于是整条目录悄悄变成 0 条。
   */
  function run(name) {
    var reply = __jsoupCall(name, docHandle(), Array.prototype.slice.call(arguments, 1))
    if (reply.kind !== 'handle') return __valueOf(name, reply)
    return reply.handle === null ? [] : __listOf(reply.handle)
  }
  var api = {}
  var methods = JS_SURFACE
  for (var i = 0; i < methods.length; i++) {
    (function (name) {
      api[name] = function () {
        var args = [name]
        for (var a = 0; a < arguments.length; a++) args.push(arguments[a])
        return run.apply(null, args)
      }
    })(methods[i])
  }
  api.toString = function () { return html }
  // toArray()：把这份文档的**顶层元素**取成数组
  //
  // 走这里的是「result 被绑成字符串、脚本却又要 result.toArray()」那一种 ——
  // 脚本里同时出现 String(result) 时字符串优先（见 analyze.ts 的 resultGlobals），
  // 于是 result 是**盒装字符串**而不是数组。🔞PO5 / 新龙小说 / 废纸文学 / 冷冷文学 /
  // 海马书屋 / 海棠看书 六个源的 chapterList 都是这个形状：选择器取到一串 li，
  // 脚本要 list[i].attr('data-id') 拿去排序。
  //
  // 给的是**顶层元素**（body > *）：拼起来的那串 HTML 解析后，body 的孩子正好就是
  // 选择器命中的那些节点，与 Legado 里 Elements.toArray() 拿到的是同一批。
  api.toArray = function () { return run('select', 'body > *') }
  return api
}

function __boxHtml(value) {
  var text = String(value === undefined || value === null ? '' : value)
  var boxed = new String(text)
  var api = __htmlApi(text)
  for (var k in api) boxed[k] = api[k]
  return boxed
}

/**
 * 把「宿主侧命中到的 N 段 HTML」包成**数组形态的 Elements**
 *
 * 与 __boxHtml 的区别在**形态**。__boxHtml 给的是「字符串 + 几个 jsoup 方法」，
 * 适合把 result 当**一份文档**用的写法（result.select('h3').text()）。
 * 这里给的是一个**真的数组**：能下标、能 forEach / map、有 length，
 * 逐个元素是「字符串 + 作用在它自己身上的 jsoup 方法」，
 * 集合级方法（size() / select() / attr() …）挂在数组上。
 *
 * 为什么要两种：Legado 里 result 是 jsoup 的 Elements（一个 List），
 * 于是脚本既会 result.size()、又会 result.forEach(e => e.attr('href'))、
 * 还会 result.select('a') 之后 links[i] —— 这些在字符串上**一个都没有**。
 * 线上三处正是这么写的（⚡📂八一中文网、🔞西瓜书屋、🔞紫云宫），
 * 而它们原来都会在多命中时报 result.size is not a function。
 *
 * 为什么元素也是「字符串 + 方法」而不是裸的 JsoupElements：脚本常常把整个
 * result（或某个元素）直接 return 回去，而宿主侧拿到的值要能**串化**成文本。
 * 盒装字符串能，只带一个内部句柄号的对象不能 —— 那会串成 {"__id":5}。
 *
 * 集合级方法挂在**数组实例**上而不是 JsoupElements.prototype 上，是因为
 * 那样会改动所有 jsoup 调用的返回值形态（线上两千多处），
 * 而这一轮要动的只是「result 绑成什么」。挂的属性名都避开了
 * Array.prototype 上已有的那些（尤其 filter / map / forEach / join）。
 */
function __attachList(handle, out) {
  var methods = JS_LIST_SURFACE
  for (var i = 0; i < methods.length; i++) {
    (function (name) {
      out[name] = function () {
        var reply = __jsoupCall(name, handle, Array.prototype.slice.call(arguments))
        // 返回句柄的集合级方法（select / first / get / not …）继续给「数组形态」，
        // 否则 result.select('a')[0] 这种写法又会退回到不能下标的 JsoupElements
        if (reply.kind !== 'handle') return __valueOf(name, reply)
        return reply.handle === null ? [] : __listOf(reply.handle)
      }
    })(methods[i])
  }
  out.toString = function () { return String(__jsoupCall('toString', handle, []).value) }
  // toArray()：jsoup 的 Elements.toArray() 返回的是**纯数组**
  //
  // 必须返回不带附加方法的纯数组：书源会写 for (i in list) 遍历它
  // （📂文学小说 就是），而 for...in 会把挂在数组上的那批集合级方法名
  // 一起枚举出来 —— 那样 list[i] 拿到的是函数，html += list[i] 就把**函数源码**
  // 拼进了结果里（不报错，只是正文变成一堆 JS 代码）。
  out.toArray = function () { return Array.prototype.slice.call(out) }
  return out
}

/**
 * 单个元素句柄 → 「盒装字符串 + 作用在它自己身上的 jsoup 方法」
 *
 * 复用 __htmlApi 那套方法名，但把它们指到**这个元素**的句柄上：
 * 指向文档的话 e.attr('href') 会问到文档根节点，永远返回空串。
 *
 * html 已经知道时就别再过一次桥（__listOf 是从宿主一口气拿到整串 HTML 的，
 * 见桥里的 list op）。
 */
function __wrapElement(handle, html) {
  var text = html === undefined || html === null
    ? String(__jsoupCall('outerHtml', handle, []).value)
    : String(html)
  var boxed = new String(text)
  var methods = JS_LIST_SURFACE
  for (var i = 0; i < methods.length; i++) {
    (function (name) {
      boxed[name] = function () {
        var reply = __jsoupCall(name, handle, Array.prototype.slice.call(arguments))
        if (reply.kind !== 'handle') return __valueOf(name, reply)
        if (reply.handle === null) return []
        return __listOf(reply.handle)
      }
    })(methods[i])
  }
  return boxed
}

/**
 * 把一个集合句柄变成「数组 + 集合级 jsoup 方法」
 *
 * 走桥的 list op **一次**拿回「每个元素的句柄 + 它自己的 outerHTML」。
 * 老写法是 size 一次、然后每个元素 get(i) 与 outerHtml 各一次 ——
 * 🎨漫画搬运 的目录 459 个条目就是 919 次额外往返（第七十四轮实测每条约 2.35ms）。
 * 现在整串一次往返，宿主侧顺手把句柄开好、HTML 取好。
 */
function __listOf(handle) {
  var reply = __jsoupCall('list', handle, [])
  var items = reply.items || []
  var out = []
  for (var i = 0; i < items.length; i++) {
    // 句柄号直接来自宿主（不是 JsoupElements 包装对象），正是下面那层要的东西
    out.push(__wrapElement(items[i].handle, items[i].html))
  }
  return __attachList(handle, out)
}

/**
 * jsoup 的 Attributes：一个数组，每项是 Attribute
 *
 * 宿主给的只是 {key, value} 一串（最小契约），Attribute 那层在沙箱里补。
 * Attributes 在 jsoup 里就是 ArrayList of Attribute，所以 Array.from(...)、
 * [i]、length 天然就有；要补的是：
 *
 *   - 每项的 getKey() / getValue() / toString()
 *     （📂贝壳读书 的目录规则正是靠 toString() 拿到 key="value" 再抠出值）
 *   - 集合级的 size() / hasKey(k) / get(i 或 键名) —— jsoup 的 Attributes 有这三个，
 *     而数组原生没有（length 有、size() 没有）
 *
 * 加了这三个名字之后 for (i in attrs) 会把它们一起枚举出来。这里按**属性表**处理，
 * 与 __attachList 上那批集合级方法同一个取舍：语料里没人对属性表用 for...in，
 * 而那三处写法的收益是实打实的。
 */
function __attrList(pairs) {
  var out = []
  var list = pairs || []
  for (var i = 0; i < list.length; i++) {
    (function (pair) {
      out.push({
        getKey: function () { return String(pair.key) },
        getValue: function () { return String(pair.value === undefined || pair.value === null ? '' : pair.value) },
        // jsoup 的 Attribute.toString() 就是 key="value"
        toString: function () { return String(pair.key) + '="' + String(pair.value === undefined || pair.value === null ? '' : pair.value) + '"' },
      })
    })(list[i])
  }
  out.size = function () { return out.length }
  out.hasKey = function (key) {
    for (var i = 0; i < out.length; i++) if (out[i].getKey() === String(key)) return true
    return false
  }
  // jsoup 是重载：get(int) 给 Attribute、get(String) 给值
  out.get = function (key) {
    if (typeof key === 'number') return out[key]
    for (var i = 0; i < out.length; i++) if (out[i].getKey() === String(key)) return out[i].getValue()
    return null
  }
  return out
}

/** N 段 HTML → 数组形态的 Elements（宿主侧按规则命中了 N 个节点） */
function __elemsFrom(htmls) {
  var reply = __jsoupCall('parseFragments', null, [htmls])
  if (reply.handle === null || reply.handle === undefined) return []
  return __listOf(reply.handle)
}

/**
 * org.jsoup.Jsoup.parse(整页) 给的是**数组形态**的包装，不是裸的 JsoupElements
 *
 * 为什么：jsoup 那边 Document 是 Element，而 select() 返回的 Elements
 * **本身就是一个 List** —— 所以书源里
 *
 *     org.jsoup.Jsoup.parse(k).select("a")[0].attr("href")
 *
 * 这种写法是成立的（线上 🎨漫画搬运 的目录规则就是这么写的）。而裸的 JsoupElements
 * 既不能下标也没有 length： [0] 恒为 undefined，接着 .attr(...) 就报在 undefined 上，
 * 报错指向规则里那一行，看不出缺的是「这个返回值得能下标」。
 *
 * 数组形态（__listOf）同时具备下标、length 与集合级方法，正是这里要的；
 * 而且它本来就是脚本里 result 的形态 —— 两个入口从此形状一致。
 * 代价很小：文档句柄的子节点就 head / body 两个。
 */
var org = {
  jsoup: {
    Jsoup: {
      parse: function (html) { return __listOf(__jsoupCall('parse', null, [String(html)]).handle) },
      parseBodyFragment: function (html) {
        return __listOf(__jsoupCall('parseBodyFragment', null, [String(html)]).handle)
      },
      clean: function (html) { return String(__jsoupCall('clean', null, [String(html)]).value) },
    },
    nodes: {},
    select: {},
  },
}

// ---------------------------------------------------------------- Packages
//
// Java 反射桥。引擎里没有 JVM，所以只按需实现「书源真正会用到的那几个类」：
// MD5 签名（七猫小说·API）、String.getBytes、System.currentTimeMillis、Base64。
// 其余一律抛出**带类名**的错误，让「不支持」与「规则写错」分得开。

var Packages = (function () {
  function JString(value) {
    var self = this instanceof JString ? this : {}
    var text = value === undefined || value === null ? '' : String(value)
    self.length = function () { return text.length }
    self.getBytes = function () { return JSON.parse(__host.utf8Bytes(text)) }
    self.toString = function () { return text }
    self.substring = function (a, b) {
      return b === undefined ? text.substring(a) : text.substring(a, b)
    }
    self.replace = function (a, b) { return String(text).split(String(a)).join(String(b)) }
    return self
  }

  function JStringBuilder() {
    var buffer = ''
    return {
      append: function (x) { buffer += String(x); return this },
      toString: function () { return buffer },
      length: function () { return buffer.length },
      reverse: function () { buffer = buffer.split('').reverse().join(''); return this },
    }
  }

  function bytesOf(value) {
    if (value && typeof value === 'object' && typeof value.length === 'number') {
      var out = []
      for (var i = 0; i < value.length; i++) out.push(Number(value[i]) & 0xff)
      return out
    }
    return JSON.parse(__host.utf8Bytes(String(value === undefined || value === null ? '' : value)))
  }

  function digest(algorithm, bytes) {
    var raw = __host.digest(JSON.stringify([String(algorithm), bytesOf(bytes)]))
    var reply = JSON.parse(raw)
    if (!reply.ok) throw new Error(reply.error)
    return reply.value
  }

  function unsupported(className) {
    var message = '本引擎不支持 Java 类 ' + className + '（引擎内没有 JVM）'
    return new Proxy({}, {
      get: function () { throw new Error(message) },
    })
  }

  return {
    java: {
      lang: {
        String: JString,
        StringBuilder: JStringBuilder,
        System: {
          currentTimeMillis: function () { return Date.now() },
          getProperty: function (name) { return String(name) === 'line.separator' ? '\\n' : '' },
          arraycopy: function () {},
        },
        Thread: { sleep: function () {} },
        Integer: {
          parseInt: function (s) { var n = parseInt(String(s), 10); return isNaN(n) ? 0 : n },
          toHexString: function (n) { return (Number(n) >>> 0).toString(16) },
          valueOf: function (s) { return parseInt(String(s), 10) || 0 },
        },
        Long: { parseLong: function (s) { return parseInt(String(s), 10) || 0 } },
        Math: { max: Math.max, min: Math.min, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, random: Math.random, pow: Math.pow },
        Character: { toString: function (c) { return String(c) } },
      },
      security: {
        MessageDigest: {
          getInstance: function (algorithm) {
            return {
              digest: function (bytes) { return digest(algorithm, bytes) },
              update: function () {},
            }
          },
        },
      },
      util: {
        Base64: {
          getEncoder: function () {
            return {
              encodeToString: function (bytes) {
                var arr = bytesOf(bytes)
                var text = ''
                for (var i = 0; i < arr.length; i++) text += String.fromCharCode(arr[i])
                return java.base64Encode(text)
              },
              encode: function (bytes) { return this.encodeToString(bytes) },
            }
          },
          getDecoder: function () {
            return {
              decode: function (s) {
                var text = java.base64Decode(String(s))
                var out = []
                for (var i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0xff)
                return out
              },
            }
          },
        },
        Arrays: {
          asList: function () { return Array.prototype.slice.call(arguments) },
          sort: function (arr) { if (arr && arr.sort) arr.sort(); return arr },
        },
        HashMap: function () { return __toJavaMap('{}') },
        UUID: { randomUUID: function () { return String(Math.random()).slice(2) + String(Date.now()) } },
        Objects: { toString: function (o) { return String(o) } },
      },
      math: { BigDecimal: function (v) { return Number(v) } },
      net: { URLEncoder: { encode: function (s, cs) { return encodeURIComponent(String(s)) } } },
      io: { File: function (path) { this.path = String(path); this.exists = function () { return false } } },
      lang_reflect: {},
    },
    javafx: unsupported('javafx.*'),
    android: unsupported('android.*'),
    javax: unsupported('javax.*'),
    org: unsupported('Packages.org.*'),
  }
})()

// ---------------------------------------------------------------- result 的两种语义
//
// 只有脚本真的把 result 当 jsoup 对象用（result.select(...) / result.size()）时，
// analyze.ts 才会把 __resultAsJsoup 置为 true。放在最后，因为要用到上面的 org.jsoup。
//
// 包成什么**看绑进来的类型**：
//   - 字符串（命中 1 个、或脚本按字符串用）→ __boxHtml，一份文档 + jsoup 方法
//   - 数组（多命中、脚本按 jsoup 用）      → __elemsFrom，N 个元素 + 集合级方法
//
// 这几句挪到 PER_EVAL_PRELUDE 里了（第五十九轮）：result 每次求值都不一样，
// 而它用到的 org.jsoup 是静态的
`

/**
 * **每次求值**要重跑的那一小段（第五十九轮）
 *
 * 背景：一次沙箱求值的固定代价约 5.6ms，其中 **5.3ms 是重新解析上面那 52KB 预置** ——
 * 而目录里「逐条字段」那种规则（一本两千章的书 × 三条 `@js:` 字段 = 上万次求值）
 * 正是它当年逼出了 `MAX_MARKED_CHAPTERS = 300` 那道有损上限（第五十九轮已经放开）
 *
 * 所以预置拆成两段：
 *   - 静态段（JAVA_PRELUDE / GLOBALS_PRELUDE）：函数与对象定义，**一个请求只解析一次**
 *   - 本段：每次都把「这次求值的数据」装进那几个全局对象，并清掉上一次的回传值
 *
 * 三条约束，缺一条就会出**静默错值**（而不是报错）：
 *   1. **顺序**：两张变量表先换新（`__build*` 要读它们），再重新造那几个对象
 *   2. **只清「回传值」**：`__xxxOut` 这些是宿主求值后读的，不清就会把上一次写过的
 *      登录头 / 书变量 / cookie 改动再回传一遍；而 `result` / `book` / `__xxx` 这些
 *      **输入**一个字都不能动（它们刚由宿主 setProp 注进来）
 *   3. **必须是「造」而不是「改」**：宿主注入的裸数据用的名字正好是 `book` / `chapter`，
 *      会直接把上一轮造好的对象盖掉 —— 于是只能重新造一个。这一条是冒烟第 43 段
 *      逼出来的：第一版写成「就地刷新」，报的是 `book.__refresh` 不是函数
 *
 * 注意：这一段也是模板字符串的一部分，注释里**不能写反引号**。
 *
 * 另外：下面这两段模板里**故意不写注释**。它们是每次求值都要重新解析的文本，
 * 按实测「解析 1KB 约 0.1ms」算，注释也要钱（第六十轮把注释挪到这里的 TS 注释里，
 * 同一批求值的这段从 0.18ms 降到 0.05ms 量级）。
 */
const PER_EVAL_PRELUDE_BASE = `
__refreshVars()
delete globalThis.__sourceVariableOut
delete globalThis.__loginHeaderOut
delete globalThis.__loginInfoOut
delete globalThis.__cookieJarOut
book = __buildBook()
chapter = __buildChapter()
source = __buildSource()
cookie = __buildCookie()
cache = __buildCache()
infoMap = globalThis.__infoMap || {}
`

/**
 * 两段预置**共用的尾段**（第五十九轮）
 *
 * 这两步依赖「这次求值的 result」，所以复用路径要重跑；而**单独求值那条路**
 * （不开批的绝大多数求值）也必须跑 —— 第一版只把它放进 PER_EVAL_PRELUDE，
 * 于是普通求值里 `result` 不再被包成 jsoup 对象、登录表单也不再铺进去，
 * 冒烟第 40 段那几条与第 45 段第 ④ 条当场报出来。
 * 所以它单独成一段，由两处**拼**上去（`GLOBALS_PRELUDE + PER_EVAL_TAIL`），
 * 免得两边写法漂移。
 *
 * 与上面那段同理：模板里不写注释（每次求值都要解析它）。
 */
const PER_EVAL_TAIL = `
if (globalThis.__resultAsJsoup) {
  if (Array.isArray(globalThis.result)) {
    globalThis.result = __elemsFrom(globalThis.result)
  } else if (typeof globalThis.result === 'string') {
    globalThis.result = __boxHtml(globalThis.result)
  }
}
if (globalThis.__loginFields !== undefined && globalThis.result === undefined) {
  globalThis.result = __toJavaMap(globalThis.__loginFields)
}
`

/** 复用路径每次求值要重跑的那一段（见上面 `PER_EVAL_PRELUDE_BASE` 与 `PER_EVAL_TAIL`） */
const PER_EVAL_PRELUDE = PER_EVAL_PRELUDE_BASE + PER_EVAL_TAIL

/**
 * `java.getString(规则)` 的能力
 *
 * 由规则求值层注入 —— 「当前节点」只有那一层知道。
 *
 * **实现里不能再进沙箱**：asyncify 不支持嵌套挂起（见 runInSandbox 里的说明），
 * 所以传入的规则若含 `@js:` / `<js>` 必须直接报错，而不是进去再挂起一次。
 */
export type SandboxGetString = (rule: string, content?: string) => Promise<string>

/**
 * `java.getElements(规则)` 的能力：把规则求值成**一串节点的 outerHTML**
 *
 * 由规则求值层注入（命中哪些节点只有那一层知道）。返回 outerHTML 而不是节点对象，
 * 是因为节点跨不了沙箱边界 —— 脚本那侧用 `org.jsoup` 的桥把它解析回 Elements。
 */
export type SandboxGetElements = (rule: string, content?: string) => Promise<string[]>

export interface SandboxLimits {
    /** 脚本执行时限（毫秒） */
    timeoutMs?: number
    memoryLimitBytes?: number
    stackLimitBytes?: number
    /** 取网能力；不传时 java.ajax 会明确报错 */
    http?: SandboxHttp
    /** 规则求值能力；不传时 java.getString 会明确报错 */
    getString?: SandboxGetString
    /** 节点级规则求值能力；不传时 java.getElements 会明确报错 */
    getElements?: SandboxGetElements
    /**
     * 本次求值所属的会话（按请求隔离，见 `SandboxSession` 的说明）
     *
     * 不传会临时开一个只服务于本次求值的会话：结果正确，但会白多实例化一个
     * WASM 模块，所以真实调用路径都从 `RuleContext.sandbox` 传进来。
     */
    session?: SandboxSession
    /**
     * 书源自带的 JS 库（`jsLib`），会在规则代码之前先跑一遍
     *
     * 线上 35 条带发现页的书源有它，而且那些源里 `GetUL()`、`host()`、`QM_HEADERS`
     * 之类的名字**全部来自这里**。不先执行它，规则里的这些名字一个都不存在，
     * 报出来的却是一句与 jsLib 毫无关系的「'host' is not defined」。
     *
     * 它执行失败**不会**直接中断本次求值：很多库是「先定义函数、后面才算常量」，
     * 即使中途失败，已定义的部分仍然有用。失败原因会挂在 `__jsLibError` 上，
     * 规则本身也失败时一并附在错误信息里。
     */
    preludeJs?: string
    /**
     * `source.setVariable(整串)` 的落库路径（由上层注入，见 `RuleContext`）
     *
     * 不注入时书源变量只活在本请求内 —— 「设置成功、下次进来又没了」。
     */
    persistSourceVariable?: (value: string) => void | Promise<void>
    /**
     * `book.putVariable(名字, 值)`（含 `chapter.putVariable`）的落库路径
     *
     * 与 `persistSourceVariable` 是**两条不同的路**：那一条写的是书源自己的一段
     * 自由字符串（作用域=源），这一条写的是「这本书」的名字→值表。
     * 不注入时书的变量只活在本请求内 —— 对「探一次规则形状、下一章读回来」那种
     * 用法是可接受的降级（每章重探一次），对用户手填的 `custom` 反而更接近本意。
     */
    persistBookVariable?: (name: string, value: string) => void | Promise<void>
    /**
     * 「**别的请求会读**」的会话变量键（`@get:{键}` / `java.get("键")`）
     *
     * 由 `globals.ts` 从 `RuleContext.infoVarCrossKeys` 转进来。JS 的
     * `java.put("键", 值)` 平时只写本次请求的会话表（与 `@put:` 同一个取向），
     * 只有这几个键额外落一次 `book_variables` —— 否则「详情那次 put、目录那次 get」
     * 这种写法（📂少年小说网 的 `html`、📂传奇中文 的 `page`、📂就去看网 的 8 个键）
     * 在目录那趟请求里读到的是空串。
     *
     * 不传就是不落库，行为与以前一样。见 `collectSourceVars`。
     */
    crossRequestInfoKeys?: ReadonlySet<string>
    /**
     * **搜索里**逐条落跨请求变量的通道（`RuleContext.itemVarSink` 转进来的）
     *
     * 给了它就走它、并且**不做**「一次请求只落一次」的去重：搜索里的键是按
     * **每一条搜索结果**各落一次的（每条是另一本书）。见 `collectSourceVars`。
     */
    itemVarSink?: ItemVarSink
    /**
     * cookie 罐（书源开着 `enabledCookieJar` 时才有，见 `BookSource.cookieJar`）
     *
     * 沙箱里 `cookie.*` 的起点是它，求值结束后改动由 `collectCookies` 收回并落库。
     * 没有它时预置里那一份是**本次求值私有的**（老行为）。
     */
    cookieJar?: CookieJar
    /** cookie 罐变过之后就写回库（由注册表装上，见 `data/db.ts`） */
    persistCookies?: () => void | Promise<void>
    /**
     * 登录态（`source.putLoginHeader` / `putLoginInfo`）的落库路径
     *
     * 由注册表装上（见 `data/db.ts` 的 `rowToSource`）：书源那两条列与 cookie 罐不同，
     * **不按开关过滤** —— 它们本来只在书源真的调过 put* 之后才有值。
     */
    persistLogin?: (patch: { header?: string; info?: string }) => void | Promise<void>
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
    /**
     * 会话由调用方按请求注入。
     *
     * 没注入时**临时开一个只有本次求值的会话**：这是「忘了传」时的兜底 ——
     * 正确（不与任何人共享模块）但会多实例化一个 WASM 模块，所以真实调用路径
     * 都应当从 `RuleContext.sandbox` 传进来。
     */
    const session = limits.session ?? createSandboxSession()
    return withSession(session, () =>
        executeInSandbox(session.module, code, globals, limits, session),
    )
}

async function executeInSandbox(
    modulePromise: Promise<QuickJSAsyncWASMModule>,
    code: string,
    globals: Record<string, unknown>,
    limits: SandboxLimits,
    session: SandboxSession,
): Promise<unknown> {
    const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const memoryLimit = limits.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT
    const stackLimit = limits.stackLimitBytes ?? DEFAULT_STACK_LIMIT
    const http = limits.http
    const getString = limits.getString
    const getElements = limits.getElements
    const totalTimeoutMs = http?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
    const maxHttpCalls = http?.maxCalls ?? DEFAULT_MAX_HTTP_CALLS

    const QuickJS = await modulePromise

    /**
     * 复用同一个批量会话的 runtime + context（第五十九轮，见 `SandboxBatch`）
     *
     * 调用方在循环外面开了批的话，这里就能按**这一份 jsLib** 找回那一批（第六十一轮
     * 起一批绑一份 jsLib）：静态预置与 jsLib 只在**这一批的第一次求值**里跑，之后每次
     * 只重跑 PER_EVAL_PRELUDE —— 省下的正是「重新解析 52KB 预置」那 5.3ms（一次求值
     * 总共才 5.64ms）。
     *
     * 查表用的键与 `openSandboxBatch` 建批时用的是**同一个字段**（`preludeJs`）：
     * 拿不到就是没开批（比如这一份 jsLib 没人在外面开），照旧走独享路径。
     */
    const batchKey = limits.preludeJs ?? ''
    // 够次数就换一个 context（见 `BATCH_ROTATE_EVALS`）—— 换在求值**之前**，
    // 不能换在求值中间
    const current = session.batches.get(batchKey)
    if (current && current.runs >= BATCH_ROTATE_EVALS) {
        await rotateSandboxBatch(session, batchKey)
    }
    const batch = session.batches.get(batchKey)
    const reuse = batch !== undefined

    const runtime = reuse ? batch.runtime : QuickJS.newRuntime()
    if (!reuse) {
        runtime.setMemoryLimit(memoryLimit)
        runtime.setMaxStackSize(stackLimit)
    }

    // 两套时限：
    //   deadline  只卡 VM 里跑的代码（中断回调只管得到这里）
    //   hardDeadline 卡整次求值，含宿主侧的等待
    //
    // 「只卡 VM」要**减掉宿主函数的耗时**才算数：中断回调看到的只有墙上时间，
    // 而宿主侧那些活（cheerio 解析、JSON 序列化）都发生在回调的两次触发之间。
    // 一次 `jsoup` 桥调用是微秒级，可 📂漫画搬运 的目录规则要调**上万次**
    // （459 个条目 × 两次 `Jsoup.parse` + 每次好几个 op），宿主侧实测 ~1.1s、
    // 而 VM 侧真正跑的只有几十毫秒 —— 不减这一项，它永远卡在 1200ms 的 deadline 上。
    const started = Date.now()
    const deadline = started + timeoutMs
    const hardDeadline = started + totalTimeoutMs
    const busy = { ms: 0 }

    let timedOut = false
    if (reuse) {
        // 复用路径：中断回调是整批共用的那一个（见 openSandboxBatch），这里只重设时限。
        // **不能**把它摘掉 —— 摘掉之后这一批剩下的求值就再也没有超时保护了。
        batch.timedOut = false
        batch.deadline = deadline
        batch.hardDeadline = hardDeadline
        batch.busy = busy
        batch.runs += 1
    } else {
        runtime.setInterruptHandler(() => {
            if (Date.now() - busy.ms > deadline || Date.now() > hardDeadline) {
                timedOut = true
                return true
            }
            return false
        })
    }

    /** 「这次是不是被超时打断的」—— 复用与独享两条路把这个答案放在两个地方 */
    const timedOutNow = () => (reuse ? batch.timedOut : timedOut)

    const vm = reuse ? batch.vm : runtime.newContext()
    const logs: string[] = []
    let httpCalls = 0

    try {
        // 宿主桥。注意句柄所有权：newFunction / newAsyncifiedFunction 返回的句柄归
        // **调用方**所有，setProp 只是让它被属性引用一次。不 dispose 的话，runtime
        // 销毁时会因为 GC 对象链表非空而断言失败（list_empty(&rt->gc_obj_list)），
        // 表现为整个请求 Aborted，报错信息里完全不会提到句柄。
        const host = vm.newObject()

        /**
         * 记一笔宿主耗时（`busy.ms` 被中断回调用作「VM 实际跑了多久」的修正项）
         *
         * 同步与异步各一份：异步那位必须等 `await` 结束才算完，否则记的是
         * 「派出去」的那一瞬间。
         */
        const counted = <T>(fn: () => T): T => {
            const t0 = Date.now()
            try {
                return fn()
            } finally {
                busy.ms += Date.now() - t0
            }
        }
        const countedAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
            const t0 = Date.now()
            try {
                return await fn()
            } finally {
                busy.ms += Date.now() - t0
            }
        }

        const defineHostFn = (
            name: string,
            impl: (arg: QuickJSHandle) => QuickJSHandle | void,
        ): void => {
            const fn = vm.newFunction(name, (arg) => counted(() => impl(arg)))
            vm.setProp(host, name, fn)
            fn.dispose()
        }

        /** 多参数版本：`timeFormat(时间, 格式, 偏移)` 要用 */
        const defineHostFnN = (
            name: string,
            impl: (...args: QuickJSHandle[]) => QuickJSHandle | void,
        ): void => {
            const fn = vm.newFunction(name, (...args) => counted(() => impl(...args)))
            vm.setProp(host, name, fn)
            fn.dispose()
        }

        /**
         * base64 编解码**按 UTF-8 字节**做
         *
         * 直接用 `btoa(str)` 是错的：它只接受 Latin1 范围内的字符，
         * 碰到中文直接抛 `InvalidCharacterError`。而书源里对中文做 base64
         * 恰恰是最常见的用法（拼签名、拼请求体）。全量探测里就有一条源
         * （晋江文学）栽在这上面，报的还是 `btoa() can only operate on characters
         * in the Latin1 range` 这种与书源毫无关系的错。
         */
        defineHostFn('b64encode', (arg) => vm.newString(base64OfUtf8(String(vm.dump(arg)))))
        defineHostFn('b64decode', (arg) => {
            try {
                return vm.newString(utf8OfBase64(String(vm.dump(arg))))
            } catch {
                // 不是合法 base64：给空串，让后续规则报「取不到内容」，
                // 而不是让宿主抛异常把整次求值带走
                return vm.newString('')
            }
        })

        /**
         * base64 → **原始字节**（JSON 数组）
         *
         * 与 `b64decode` 分开是必要的：那个解成 UTF-8 字符串，二进制密钥
         * 过一遍就会变成 U+FFFD。书源拿字节数组当 AES 的 key/iv，必须是原样的字节。
         */
        defineHostFn('base64Bytes', (arg) => {
            let reply: { ok: boolean; value?: number[]; error?: string }
            try {
                reply = { ok: true, value: Array.from(bytesOfBase64(String(vm.dump(arg)))) }
            } catch (err) {
                reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
            }
            return vm.newString(JSON.stringify(reply))
        })
        defineHostFn('md5', (arg) => vm.newString(md5Hex(String(vm.dump(arg)))))

        /**
         * 对称加解密（同步桥）
         *
         * 算法与形状都在宿主侧（`lib/aes.ts` 纯计算 + `lib/symmetric.ts` 形状适配），
         * 这里只做「JSON 进、JSON 出」。放在宿主侧的原因：WebCrypto 是异步的，
         * 而书源里 `createSymmetricCrypto(...)` 是同步用法。
         *
         * 出错走 `{ok:false}` 交给脚本侧抛 —— 密钥不对、算法不支持这类问题
         * 必须让书源看见，而不是解出一段乱码。
         */
        defineHostFn('crypto', (arg) => {
            let reply: { ok: boolean; value?: number[] | string; error?: string }
            try {
                const request = JSON.parse(String(vm.dump(arg))) as SymmetricRequest
                reply = { ok: true, value: runSymmetric(request) }
            } catch (err) {
                reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
            }
            return vm.newString(JSON.stringify(reply))
        })
        defineHostFn('log', (arg) => {
            logs.push(String(vm.dump(arg)))
        })

        /**
         * UTF-8 字节。同步桥 —— `Packages.java.lang.String.getBytes()` 用它。
         *
         * 返回 JSON 数组而不是别的形状：脚本侧要拿它当「Java 字节数组」用
         * （`b.length`、`b[i]`），普通 JS 数组正好满足。
         */
        defineHostFn('utf8Bytes', (arg) =>
            vm.newString(
                JSON.stringify(Array.from(new TextEncoder().encode(String(vm.dump(arg))))),
            ),
        )

        /**
         * 摘要的原始字节。目前只有 MD5 —— 它是唯一能在**同步**路径上算出来的
         * （WebCrypto 的 `crypto.subtle.digest` 是异步的，而同步桥里不能等 Promise）。
         * 其余算法明确报错，绝不返回一个长度对得上的假字节。
         */
        defineHostFn('digest', (arg) => {
            let reply: { ok: boolean; value?: number[]; error?: string }
            try {
                const [algorithm, bytes] = JSON.parse(String(vm.dump(arg))) as [string, number[]]
                const name = String(algorithm).toUpperCase().replace(/-/g, '')
                if (name !== 'MD5') throw new Error(`摘要算法 ${algorithm} 未实现（只支持 MD5）`)
                reply = { ok: true, value: Array.from(md5Bytes(Uint8Array.from(bytes ?? []))) }
            } catch (err) {
                reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
            }
            return vm.newString(JSON.stringify(reply))
        })

        /**
         * `org.jsoup` 的桥：整页 HTML 交给宿主侧的 cheerio 解析，脚本拿整数句柄操作。
         *
         * 同步桥就够 —— cheerio 的解析与选择器查询全是同步的，
         * 不受 asyncify「不能嵌套挂起」的限制。
         */
        const jsoup = new JsoupBridge()
        defineHostFn('jsoup', (arg) => {
            let reply: unknown
            try {
                const payload = JSON.parse(String(vm.dump(arg))) as {
                    op: string
                    handle: number | null
                    args: unknown[]
                }
                reply = jsoup.run(payload.op, payload.handle ?? null, payload.args ?? [])
            } catch (err) {
                reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
            }
            return vm.newString(JSON.stringify(reply))
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
        const getStringFn = vm.newAsyncifiedFunction('getString', async (arg) =>
            countedAsync(async () => {
                const raw = String(vm.dump(arg))
                return vm.newString(await handleGetString(raw, { getString }))
            }),
        )
        vm.setProp(host, 'getString', getStringFn)
        getStringFn.dispose()

        /**
         * `java.getElements(规则)` 的桥
         *
         * 与 getString 同一套路（命中哪些节点只有规则求值层知道），
         * 只是交回去的不是字符串而是**每个节点的 outerHTML** —— 脚本那侧再解析成 Elements。
         * 同样是 asyncify 函数，因此规则里不能再套 JS（见 analyze.ts 的 getElements 实现）。
         */
        const getElementsFn = vm.newAsyncifiedFunction('getElements', async (arg) =>
            countedAsync(async () => {
                const raw = String(vm.dump(arg))
                return vm.newString(await handleGetElements(raw, { getElements }))
            }),
        )
        vm.setProp(host, 'getElements', getElementsFn)
        getElementsFn.dispose()

        /**
         * SHA-256 的同步桥（脚本里同步、宿主侧 await）
         *
         * WebCrypto 的 `subtle.digest` 只给 Promise，所以这条桥必须是 asyncify 的；
         * 而沙箱本来就是 asyncify 的，写法与上面几条异步桥完全一样。
         * 给 `java.digestHex(str, 'SHA-256')` 用（线上 5 处）。
         */
        const sha256Fn = vm.newAsyncifiedFunction('sha256', async (arg) =>
            countedAsync(async () => {
                const text = String(vm.dump(arg))
                return vm.newString(await sha256Hex(text))
            }),
        )
        vm.setProp(host, 'sha256', sha256Fn)
        sha256Fn.dispose()

        /**
         * 摘要与 HMAC 的同步桥（脚本里同步、宿主侧 await）
         *
         * 一次调用同时服务 `java.digestBase64Str` / `java.HMacHex` / `java.HMacBase64`：
         * 它们的输入输出约定一样，只有算法与要不要密钥不同，所以合成一条桥就够了 ——
         * 沙箱那侧三个成员都只是拼一个 JSON 而已（见 JAVA_PRELUDE）。
         */
        const hashFn = vm.newAsyncifiedFunction('hash', async (arg) =>
            countedAsync(async () => {
                const requestJson = String(vm.dump(arg))
                return vm.newString(await runHash(JSON.parse(requestJson) as HashRequest))
            }),
        )
        vm.setProp(host, 'hash', hashFn)
        hashFn.dispose()

        const takeCall = () => {
            httpCalls += 1
            if (httpCalls > maxHttpCalls) {
                throw new SandboxError(`单次规则最多允许 ${maxHttpCalls} 次网络请求，已超出`)
            }
        }

        const requestFn = vm.newAsyncifiedFunction('request', async (arg) =>
            countedAsync(async () => {
                const optionsJson = String(vm.dump(arg))
                const response = await handleHttpRequest(optionsJson, {
                    http,
                    now: () => Date.now(),
                    hardDeadline,
                    takeCall,
                })
                return vm.newString(response)
            }),
        )
        vm.setProp(host, 'request', requestFn)
        requestFn.dispose()

        /**
         * 同步桥：把地址解析成**绝对地址**（`java.connect(...).raw().request().url()`）
         *
         * 同步、且**不发请求** —— 那 9 个只在 URL 模板里取地址的源，不该为拿一个地址
         * 多打一次网络（Legado 的 AnalyzeUrl 也是发请求之前就把地址定下来的）。
         */
        const resolveUrlFn = vm.newFunction('resolveUrl', (arg) =>
            counted(() => {
                const url = String(vm.dump(arg))
                return vm.newString(resolveSandboxUrl(url, http))
            }),
        )
        vm.setProp(host, 'resolveUrl', resolveUrlFn)
        resolveUrlFn.dispose()

        /**
         * 异步桥：取回**响应本身**（状态码 + 响应头 + 正文），HTTP 非 2xx **不抛错**
         *
         * `java.connect` 用它 —— 书源要做 `res.code() == 403`、`res.raw().headers('Set-Cookie')`
         * 这类判断，抛错等于把「判断」变成了「异常」。
         */
        const fetchFullFn = vm.newAsyncifiedFunction('fetchFull', async (arg) =>
            countedAsync(async () => {
                const optionsJson = String(vm.dump(arg))
                const response = await handleHttpResponse(optionsJson, {
                    http,
                    now: () => Date.now(),
                    hardDeadline,
                    takeCall,
                })
                return vm.newString(response)
            }),
        )
        vm.setProp(host, 'fetchFull', fetchFullFn)
        fetchFullFn.dispose()

        vm.setProp(vm.global, '__host', host)
        host.dispose()

        /**
         * 注入这次的全局，并且**先把上一次注入的那些名字删掉**（第六十轮合成一次求值）
         *
         * 删是必须的：这一次没注入 `result`（比如一段不带 result 的代码）时，上一次那个
         * `result` 还挂在全局上，规则会读到**上一次的值** —— 而且不报错。
         *
         * 两次「过边界」以前是分开的（一次删、一次注入），现在拼进同一段脚本：
         * 复用之后每次求值要过好几趟宿主↔VM 边界，每趟都是实打实的开销。
         *
         * 注入走 JSON.parse，这样数组/对象/数字的类型都能保住；一个值坏掉只跳过它
         * （与以前一样，书源里的坏值不该让整次求值挂掉）。
         */
        const statements: string[] = []
        if (reuse) {
            for (const key of batch.injected) {
                statements.push(`delete globalThis[${JSON.stringify(key)}]`)
            }
            batch.injected = []
        }
        for (const [key, value] of Object.entries(globals)) {
            if (value === undefined) continue
            let json: string
            try {
                json = JSON.stringify(value ?? null)
            } catch {
                continue
            }
            statements.push(
                `globalThis[${JSON.stringify(key)}] = JSON.parse(${JSON.stringify(json)})`,
            )
            // 记下来，下一次求值前要删掉（见上面那段）
            if (reuse) batch.injected.push(key)
        }
        if (statements.length > 0) {
            const applied = vm.evalCode(statements.join(';'))
            if (applied.error) applied.error.dispose()
            else applied.value.dispose()
        }

        if (reuse && batch.ready) {
            /**
             * 复用路径的第 2..n 次：静态预置已经在 context 里了，只把**这次的数据**装进去
             *
             * 这一段是这一轮的关键：省掉「重新解析 52KB 预置」那 5.3ms，
             * 只重跑 PER_EVAL_PRELUDE（实测 0.01ms 量级）。
             */
            const per = vm.evalCode(PER_EVAL_PRELUDE)
            if (per.error) {
                const dumped = vm.dump(per.error)
                per.error.dispose()
                // 用 describeSandboxError 而不是 String(dump)：后者对错误对象只会给
                // 一句 [object Object]，而这一段出错的排查成本很高（只在复用路径上）
                throw new SandboxError(
                    `沙箱预置失败（每次求值那段）：${describeSandboxError(dumped)}`,
                )
            }
            per.value.dispose()
        } else {
            // 两段预置：先 java（它要用 __host），再它依赖 java 的那几个全局对象
            // （这两段各自的结尾都会把这次求值的数据装进那几个全局对象；
            //  尾段是两段路径共用的，见 PER_EVAL_TAIL）
            for (const [label, source] of [
                ['java 助手', JAVA_PRELUDE],
                ['全局对象', GLOBALS_PRELUDE + PER_EVAL_TAIL],
            ] as const) {
                const prelude = vm.evalCode(source)
                if (prelude.error) {
                    const msg = String(vm.dump(prelude.error))
                    prelude.error.dispose()
                    throw new SandboxError(`沙箱预置失败（${label}）：${msg}`)
                }
                prelude.value.dispose()
            }
        }

        /**
         * 书源自己的 JS 库（jsLib）
         *
         * 必须在这里跑完再跑规则代码，因为规则里的 `GetUL()` / `host()` / `QM_HEADERS`
         * 都是它定义的。用 evalCodeAsync 而不是 evalCode：库内部也可能调 java.ajax。
         *
         * 失败不中断：库常常「前面定义函数、后面算常量」，中途失败时已定义的部分照样可用。
         * 把失败原因挂成全局，规则再失败时一并报出来，这样「缺的名字来自哪」一眼可见。
         */
        if ((!reuse || !batch.ready) && limits.preludeJs && limits.preludeJs.trim() !== '') {
            const lib = await vm.evalCodeAsync(limits.preludeJs)
            if (lib.error) {
                const dumped = vm.dump(lib.error)
                lib.error.dispose()
                const message = `jsLib 执行失败：${describeSandboxError(dumped)}`
                logs.push(message)
                const setError = vm.evalCode(`globalThis.__jsLibError = ${JSON.stringify(message)}`)
                if (setError.error) setError.error.dispose()
                else setError.value.dispose()
            } else {
                lib.value.dispose()
            }
        }

        /**
         * 复用路径：静态预置与 jsLib 都跑完了，给这一批打上标记 ——
         * 后面的求值直接走「只重跑 PER_EVAL_PRELUDE」那条路
         */
        if (reuse) batch.ready = true

        // evalCodeAsync 会在脚本调用 asyncify 函数时自动驱动挂起的任务，
        // 直到脚本跑完；不需要手工轮询 executePendingJobs
        const outcome = await vm.evalCodeAsync(code)

        if (outcome.error) {
            const dumped = vm.dump(outcome.error)
            outcome.error.dispose()
            const message = `规则脚本执行出错：${describeSandboxError(dumped)}`
            // 规则失败时把 jsLib 的失败原因一并带上：书源里「'X' is not defined」
            // 十有八九是 jsLib 没能定义它，分开报会让人往规则本身找原因
            const libError = readGlobalString(vm, '__jsLibError')
            throw new SandboxError(libError ? `${message}｜${libError}` : message)
        }

        const value = vm.dump(outcome.value)
        outcome.value.dispose()
        return value
    } catch (err) {
        if (timedOutNow()) {
            throw new SandboxError(`规则脚本超时（>${timeoutMs}ms），已中断`)
        }
        throw err
    } finally {
        // 变量要在**销毁 VM 之前**收回：书源里「搜索脚本先 put、后面的规则再 get」
        // 全靠这一步跨过两次求值（见 SandboxSession.vars）
        collectSourceVars(vm, session, limits)
        await collectSourceVariable(vm, limits)
        await collectBookVars(vm, session, limits)
        await collectCookies(vm, limits)
        await collectLogin(vm, limits, session)
        /**
         * 把这次求值的日志（`java.toast` / `java.log`）留一份在会话上
         *
         * 存在的理由只有一个：**登录接口要把书源自己那句话带回去**
         * （「已切换线路：xxx」「账号密码为空」）—— 那些提示是书源写给用户看的，
         * 而它唯一的出口就是 toast。不留这一份，接口只能回一句「跑完了」。
         */
        session.lastLogs = logs
        // 复用路径下**不销毁** runtime / context（那是整批共用的，由 closeSandboxBatch 收尾）
        releaseHostBridge(vm, runtime, batch)
    }
}

/**
 * 把这次求值里更新过的书源变量收回到会话
 *
 * 读取端是预置脚本里的 `globalThis.__varsOut`（一张普通对象表）。
 * 任何一步失败都只能咽掉 —— 这里发生在求值之后，结果或错误都已经定了，
 * 再抛一个「收变量失败」只会把真正的失败原因盖掉。
 *
 * 顺带把**跨请求的那些键**落一次库（`__varsDirty` 里记的那几个）：会话表只活这次
 * 请求，而 `ruleBookInfo` 里 `java.put("html", …)`、`ruleToc` 里 `java.get("html")`
 * 是两次请求 —— 只靠会话，目录那趟读到的是空串，而书源**不会报错**，
 * 只是目录安静地少一截（📂少年小说网 少的是开头 100 章，见 README 第七十三轮）。
 *
 * 只落 `__varsDirty` 里记过的键，而不是整张 `__varsOut`：那张表里垫着从
 * `book_variables` 读来的值，整张落等于每次翻页都把同样的东西重写一遍。
 */
function collectSourceVars(
    vm: QuickJSAsyncContext,
    session: SandboxSession,
    limits: SandboxLimits,
): void {
    try {
        const handle = vm.evalCode(
            'JSON.stringify({ all: globalThis.__varsOut || {}, dirty: globalThis.__varsDirty || {} })',
        )
        if (handle.error) {
            handle.error.dispose()
            return
        }
        const text = String(vm.dump(handle.value) ?? '')
        handle.value.dispose()
        const parsed = JSON.parse(text) as {
            all?: Record<string, unknown>
            dirty?: Record<string, unknown>
        }
        for (const key of Object.keys(parsed.all ?? {})) {
            session.vars[key] = String(parsed.all?.[key] ?? '')
        }
        const keys = limits.crossRequestInfoKeys
        const sink = limits.itemVarSink
        /**
         * 搜索那一趟走这条岔路（给的是 `RuleContext.itemVarSink`）
         *
         * 它**不做**「一次请求只落一次」那道去重，因为搜索里的同一个键是**逐条**写的、
         * 每条属于另一本书（📂阿巴小说 的 `bid`、🔊潇社音乐 的 `json`…）。
         * 去重会把第 2 条之后的全部丢掉 —— 而 `__varsDirty` 是**每次求值重置**的，
         * 所以这里天然只含「这次求值真的写过的键」，不需要那层保护。
         */
        if (sink) {
            for (const key of Object.keys(parsed.dirty ?? {})) {
                const value = String(parsed.all?.[key] ?? '')
                if (value === '' || !(keys?.has(key) ?? false)) continue
                sink.push(key, value)
            }
            return
        }

        const persist = limits.persistBookVariable
        if (!keys || keys.size === 0 || !persist) return
        const target = { keys, persist, saved: (session.crossVarSaved ??= new Set<string>()) }
        for (const key of Object.keys(parsed.dirty ?? {})) {
            // 值从 `all` 里取：`dirty` 只记「写过这个键」，值仍是 `__varsOut` 里那一份
            persistCrossVar(target, key, String(parsed.all?.[key] ?? ''))
        }
    } catch {
        /* 收不回来不影响这次求值的结果 */
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
function releaseHostBridge(
    vm: QuickJSAsyncContext,
    runtime: QuickJSAsyncRuntime,
    batch?: SandboxBatch,
): void {
    try {
        if (batch) {
            /**
             * 复用路径：清理阶段也别被超时打断 —— 但**不能**把中断回调摘掉，
             * 那一个是整批共用的，摘掉之后这一批剩下的求值就没有超时保护了。
             * 于是改成把两个时限推到无穷（下次求值会重新设）。
             */
            batch.deadline = Number.POSITIVE_INFINITY
            batch.hardDeadline = Number.POSITIVE_INFINITY
        } else {
            // 清理阶段不该再被超时打断（脚本可能因为超时才走到这里）
            runtime.setInterruptHandler(() => false)
        }

        const cleanup = vm.evalCode('delete globalThis.__host')
        if (cleanup.error) cleanup.error.dispose()
        else cleanup.value.dispose()
    } catch {
        // 脚本已经把 VM 弄坏了也不影响结果：下面照常销毁
    }

    // 复用路径到此为止：runtime / context 是整批共用的，交给 closeSandboxBatch
    if (batch) return

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

/**
 * 沙箱内 `java.getElements` 的实际执行：把规则交给上层注入的节点级求值能力
 *
 * 形状与 `handleGetString` 完全一致（错误也走 `{ok:false}` 再由脚本侧抛出），
 * 只是 value 是字符串数组。
 */
async function handleGetElements(
    payloadJson: string,
    ctx: { getElements?: SandboxGetElements },
): Promise<string> {
    let rule = ''
    let content: string | undefined

    try {
        const parsed = JSON.parse(payloadJson) as [unknown, unknown]
        rule = String(parsed[0] ?? '')
        const raw = parsed[1]
        content = raw === null || raw === undefined ? undefined : String(raw)
    } catch {
        return JSON.stringify({ ok: false, error: 'java.getElements 的参数不是合法 JSON' })
    }

    if (rule === '') return JSON.stringify({ ok: false, error: 'java.getElements 缺少规则' })

    if (!ctx.getElements) {
        return JSON.stringify({
            ok: false,
            error: '当前上下文未提供节点级规则求值能力（java.getElements 不可用）',
        })
    }

    try {
        return JSON.stringify({ ok: true, value: await ctx.getElements(rule, content) })
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

    /**
     * **整次求值还剩多少，就只给这次取网多少**（第六十轮）
     *
     * 以前只在发请求**之前**看一眼预算，请求本身则用取网层的默认 20 秒 ——
     * 于是搜索里一条 `@js:java.ajax(...)` 能把一次搜索拖到 20 秒以上
     * （第六十轮体检抽到的两个源：📂夜伴书屋 21.4 秒、🎨拷贝漫画 20.8 秒）。
     */
    const remaining = ctx.hardDeadline - ctx.now()
    if (remaining <= 0) {
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
            timeoutMs: remaining,
        })
        return JSON.stringify({ ok: true, body: text })
    } catch (err) {
        return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        })
    }
}

/**
 * 沙箱内 `java.connect` 的实际执行：取回**响应本身**（状态码 / 响应头 / 正文）
 *
 * 与上面那条的关键差别只有一个，但它是这一条存在的全部理由：**HTTP 非 2xx 不当成失败**。
 * 书源用 `res.code() == 403` 判断要不要换 cookie、用 `res.raw().headers('Set-Cookie')`
 * 取新 cookie（📂天籁小说 整条 searchUrl 就是干这个），抛错会把判断变成异常。
 *
 * 网络层真失败（超时、连不上）仍然报 `ok:false`，脚本那侧 `.body()` 拿到错误文本、
 * `.code()` 拿到 0 —— 与 Legado 失败时返回 `StrResponse(url, 错误信息)` 一致。
 */
async function handleHttpResponse(
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

    if (!ctx.http?.fetchResponse) {
        return JSON.stringify({
            ok: false,
            error: '当前上下文未提供取网能力（java.connect 不可用）',
        })
    }

    // 与 java.ajax 那条同理：整次求值还剩多少，就只给这次取网多少（见 handleHttpRequest）
    const remaining = ctx.hardDeadline - ctx.now()
    if (remaining <= 0) {
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
        const response = await ctx.http.fetchResponse(url, {
            method: options.method,
            body: options.body,
            headers: options.headers,
            timeoutMs: remaining,
        })
        return JSON.stringify({
            ok: true,
            url: response.url,
            status: response.status,
            headers: response.headers,
            body: response.body,
            // 第一跳重定向（若有）：沙箱那一侧拿它兜 header('Location')
            ...(response.redirectedFrom ? { redirectedFrom: response.redirectedFrom } : {}),
        })
    } catch (err) {
        return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        })
    }
}

/**
 * 沙箱内 `java.connect(...).url()` 用的地址解析（同步、不发请求）
 *
 * 拿不到取网能力时原样返回：宁可能得到一个相对地址，也不要让规则在这里报错 ——
 * `{{java.connect(source.getKey()).raw().request().url()}}` 那条路上的失败
 * 会直接让整条 searchUrl 变成一句错误信息。
 */
function resolveSandboxUrl(url: string, http?: SandboxHttp): string {
    if (!http?.resolveUrl) return String(url)
    try {
        return String(http.resolveUrl(String(url)))
    } catch {
        return String(url)
    }
}

/**
 * 把这次求值里改过的**书源变量**交给上层落库
 *
 * 读取端是预置脚本写的 `globalThis.__sourceVariableOut`：`source.setVariable(整串)`
 * 每次都覆盖它。**`undefined` 表示这次求值没碰过它**，所以不能拿「空串」当没设置 ——
 * 书源清空自己的变量（`setVariable('')`）是合法操作，必须与「没动」分开。
 *
 * 只有在上层给了落库路径时才做（`RuleContext.persistSourceVariable`，见 index.ts）：
 * 引擎自己不该碰数据库。落库**要等**（调用方 await）—— 响应一返回，Worker 会掐掉
 * 还在飞的 promise，那时用户看到的是「设置成功了」，下次进来却发现没生效。
 *
 * 与 `collectSourceVars` 一样：任何一步失败都只能咽掉，结果或错误都已经定了。
 */
async function collectSourceVariable(
    vm: QuickJSAsyncContext,
    limits: SandboxLimits,
): Promise<void> {
    if (!limits.persistSourceVariable) return
    try {
        const handle = vm.evalCode(
            'typeof globalThis.__sourceVariableOut === "string" ? globalThis.__sourceVariableOut : null',
        )
        if (handle.error) {
            handle.error.dispose()
            return
        }
        const dumped = vm.dump(handle.value)
        handle.value.dispose()
        if (dumped === null || dumped === undefined) return
        await limits.persistSourceVariable(String(dumped))
    } catch {
        /* 落库失败不影响这次求值的结果（书源那侧已经拿到它要的值了） */
    }
}

/**
 * 把这次求值里写过的**书的变量**交给上层落库
 *
 * 读取端是预置脚本里的 `globalThis.__bookVarsDirty`：`book.putVariable(名字, 值)`
 * 每写一次就记一笔。只写改动过的名字 —— 与书源变量那条「整串覆盖」不同，
 * 这里是**一张按名字索引的表**，把没动过的名字原样回传没有意义，还会多打几条 UPDATE。
 *
 * 为什么要落库：📂掌阅书城 / 📂就去看网 / 📂言情小说 的正文规则会先探「第几个选择器
 * 能解析出来」，再 `book.putVariable("序", i)` 记下 —— 一章一次请求，下一章先读 `序`
 * 就不必重探。不落库的话每章都要重探一遍：结果仍然对，只是白花 CPU 与上游请求。
 *
 * 与 `collectSourceVariable` 一样：只有上层给了落库路径才做（`RuleContext.persistBookVariable`），
 * 落库**要等**（调用方 await）—— 响应一返回，Worker 会掐掉还在飞的 promise。
 * 任何一步失败都只能咽掉：结果或错误都已经定了，这里再抛一个只会盖掉真正的失败原因。
 */
async function collectBookVars(
    vm: QuickJSAsyncContext,
    session: SandboxSession,
    limits: SandboxLimits,
): Promise<void> {
    const persist = limits.persistBookVariable
    try {
        const handle = vm.evalCode('JSON.stringify(globalThis.__bookVarsDirty || {})')
        if (handle.error) {
            handle.error.dispose()
            return
        }
        const text = String(vm.dump(handle.value) ?? '')
        handle.value.dispose()
        const parsed = JSON.parse(text) as Record<string, unknown>
        for (const name of Object.keys(parsed)) {
            const value = String(parsed[name] ?? '')
            // 先落到会话：同一次请求里后面的求值要立刻读到（跨请求的那一份走 persist）
            session.bookVars[name] = value
            if (persist) await persist(name, value)
        }
    } catch {
        /* 落库失败不影响这次求值的结果（书源那侧已经拿到它要的值了） */
    }
}

/**
 * 把这次求值里改过的 **cookie** 收回罐子（并写回库）
 *
 * 读取端是预置脚本写的 `globalThis.__cookieJarOut`：`cookie.setCookie` / `replaceCookie` /
 * `removeCookie` 每改一个主机就记一笔（空串表示删掉）。
 *
 * 只收回**改过的主机**，不是整份快照 —— 这一点很要紧：这次求值期间书源可能自己发过请求
 * （`java.ajax`），取网层已经把响应里的 `Set-Cookie` 收进了同一个罐子；拿求值开始时的
 * 快照整个覆盖回去，会把刚收到的那些悄悄抹掉。
 *
 * 落库要等（`await`）：Worker 的响应一返回，还在飞的 promise 会被掐掉，
 * 而「搜索那一趟拿到会话 cookie」正是后面几趟要用的东西。失败只能咽掉 ——
 * 这里发生在求值之后，再抛一个只会盖掉真正的失败原因。
 */
async function collectCookies(vm: QuickJSAsyncContext, limits: SandboxLimits): Promise<void> {
    const jar = limits.cookieJar
    if (!jar) return
    try {
        const handle = vm.evalCode('JSON.stringify(globalThis.__cookieJarOut || {})')
        if (handle.error) {
            handle.error.dispose()
            return
        }
        const text = String(vm.dump(handle.value) ?? '')
        handle.value.dispose()
        const parsed = JSON.parse(text) as Record<string, unknown>
        let changed = false
        for (const host of Object.keys(parsed)) {
            const value = String(parsed[host] ?? '')
            if (value === '') {
                if (jar.hosts[host] !== undefined) {
                    delete jar.hosts[host]
                    changed = true
                }
            } else if (jar.hosts[host] !== value) {
                jar.hosts[host] = value
                changed = true
            }
        }
        if (changed && limits.persistCookies) await limits.persistCookies()
    } catch {
        /* cookie 收不回来只影响下一次请求带不带它，不该盖掉这次求值的结果 */
    }
}

/**
 * 把这次求值里改过的**登录态**交给上层落库
 *
 * 读取端是预置脚本写的 `globalThis.__loginHeaderOut` / `__loginInfoOut`：
 * `putLoginHeader` / `putLoginInfo` / `removeLogin*` 每改一次就记一笔。
 *
 * 为什么必须落库：登录是**一次**动作，而搜索 / 详情 / 目录 / 正文是**四次互不相干的请求** ——
 * 不落库的话用户看到的是「登录成功了，翻一页又要重新登录」。取网层随后会把
 * `loginHeader` 解析成请求头带上（见 `planFromResolvedUrl`）。
 *
 * 与 `collectCookies` 一样：只有上层给了落库路径才做，落库**要等**（响应一返回，
 * 还在飞的 promise 会被掐掉），失败只能咽掉。
 */
async function collectLogin(
    vm: QuickJSAsyncContext,
    limits: SandboxLimits,
    session: SandboxSession,
): Promise<void> {
    const patch: { header?: string; info?: string } = {}
    try {
        for (const [global, key] of [
            ['__loginHeaderOut', 'header'],
            ['__loginInfoOut', 'info'],
        ] as const) {
            const handle = vm.evalCode(
                `typeof globalThis.${global} === "string" ? globalThis.${global} : null`,
            )
            if (handle.error) {
                handle.error.dispose()
                continue
            }
            const dumped = vm.dump(handle.value)
            handle.value.dispose()
            if (dumped === null || dumped === undefined) continue
            patch[key] = String(dumped)
        }
    } catch {
        /* 读不到全局就当这次没写登录态 */
    }

    // 「这一趟改没改登录态」先记在会话上 —— 登录接口用它报 `loggedIn`。
    // 必须在 `persistLogin` 那个早退之前做：即使上层没给落库路径，这次求值
    // 也确实改过（只是没存下来），这个事实不该丢。
    if (patch.header !== undefined || patch.info !== undefined) session.loginOut = patch

    const persist = limits.persistLogin
    if (!persist || (patch.header === undefined && patch.info === undefined)) return
    try {
        await persist(patch)
    } catch {
        /* 落库失败不影响这次求值的结果（书源那侧已经拿到它要的值了） */
    }
}

/**
 * 把沙箱抛出的异常描述成一行
 *
 * QuickJS 的 `TypeError: not a function` 只说「不是函数」，不说**是哪一个** ——
 * 而书源脚本动辄几十行，光凭这句话根本定位不到。这里补上错误类型与出错行号：
 * 类型能区分 `ReferenceError`（缺全局，比如 `source` 还没实现）
 * 与 `TypeError`（调了不存在的方法），行号直接指向脚本里的那一句。
 */
function describeSandboxError(dumped: unknown): string {
    if (dumped === null || dumped === undefined) return String(dumped)
    if (typeof dumped !== 'object') return String(dumped)

    const box = dumped as { name?: unknown; message?: unknown; stack?: unknown }
    const name = typeof box.name === 'string' && box.name !== '' ? `${box.name}: ` : ''
    const message = box.message === undefined ? JSON.stringify(dumped) : String(box.message)
    return `${name}${message}${frameOf(box.stack)}`
}

/**
 * 读一个字符串类型的沙箱全局，读不到就返回空串
 *
 * 用在**已经出错**之后的收尾阶段，所以任何一步失败都只能咽掉 ——
 * 这里再抛一个错会把真正的失败原因盖掉。
 */
function readGlobalString(vm: QuickJSAsyncContext, name: string): string {
    try {
        const handle = vm.evalCode(
            `typeof globalThis.${name} === 'string' ? globalThis.${name} : ''`,
        )
        if (handle.error) {
            handle.error.dispose()
            return ''
        }
        const value = String(vm.dump(handle.value) ?? '')
        handle.value.dispose()
        return value
    } catch {
        return ''
    }
}

/** 取堆栈里第一个带行号的帧，形如「（脚本第 3 行）」 */
function frameOf(stack: unknown): string {
    if (typeof stack !== 'string') return ''
    for (const line of stack.split('\n')) {
        if (!line.includes('at ')) continue
        const m = /:(\d+)(?::\d+)?/.exec(line)
        if (m?.[1]) return `（脚本第 ${m[1]} 行）`
    }
    return ''
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
