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

import type { SandboxHttp } from './types'
import { base64OfUtf8, bytesOfBase64, utf8OfBase64 } from '../lib/base64'
import { DEFAULT_TIME_OFFSET_HOURS, formatJavaTime } from '../lib/javatime'
import { md5Bytes, md5Hex, sha256Hex } from '../lib/hash'
import { runSymmetric, type SymmetricRequest } from '../lib/symmetric'
import { JsoupBridge } from './jsoupBridge'

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
     * **会话级书源变量**：`java.put` / `java.get(key)` / `source.setVariable` 共用这一张表
     *
     * 为什么要有它：书源里「先存后取」是常规写法 —— 搜索地址的脚本里
     * `java.put('单', …)` 记下这次搜索的形态，同一个源后面的字段规则再
     * `java.get('单')` 读回来分情况处理。变量只活在单次求值里的话，后一次读到空串，
     * 规则会**静默**走到另一条分支。语料上这类调用是 130 处 `java.put` + 141 处一参
     * `java.get`，不是边角。
     *
     * 生命周期刻意与 cookie/cache 不同（那两个是「单次求值」，见 GLOBALS_PRELUDE 的说明）：
     * 变量是**按请求**活的，因为要跨求值。仍然**不落库、不跨请求** ——
     * 真正的跨请求持久化需要一张按书源隔离的表，那是另一件事。
     */
    vars: Record<string, string>
}

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
    }
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
// ---------------------------------------------------------------- 书源变量
//
// java.put(k, v) / java.get(k) / source.setVariable 共用这一张表。
// 求值开始时由宿主注入（__sourceVars 里带着本次请求前面几次求值写过的值），
// 求值结束时宿主再把它收回去 —— 「搜索脚本先存、字段规则后读」就靠这一步跨过去。
// 注意：这一段是模板字符串的一部分，注释里**不能写反引号**。
var __varsOut = (function () {
  try { return JSON.parse(String(globalThis.__sourceVars || '{}')) || {} } catch (e) { return {} }
})()

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
  get: function (a, b) {
    if (arguments.length >= 2) return java.__req({ url: String(a), headers: b || {} })
    var v = __varsOut[String(a)]
    return v === undefined || v === null ? '' : String(v)
  },
  // 存变量。线上 130 处 —— 本引擎以前**根本没有这个函数**，所以每一处都是
  // TypeError: not a function（QuickJS 还说不出是哪一个）。
  put: function (key, value) {
    __varsOut[String(key)] = value === undefined || value === null ? '' : String(value)
  },
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
  getStringList: function (rule, content) {
    var joined = java.getString(rule, content)
    if (joined === '') return []
    return String(joined).split('\\n')
  },
  // 连接式取网。Legado 的形状是 java.connect(url).header(k,v).get().body()
  connect: function (url) {
    var self = { url: String(url), method: 'GET', headers: {}, bodyText: null }
    var api = {
      url: function (u) { self.url = String(u); return api },
      header: function (k, v) { self.headers[String(k)] = String(v); return api },
      headers: function (o) { for (var k in o) { self.headers[k] = String(o[k]) } return api },
      method: function (m) { self.method = String(m).toUpperCase(); return api },
      timeout: function () { return api },
      get: function () { return result() },
      post: function (body) {
        self.method = 'POST'
        self.bodyText = body === undefined || body === null ? '' : String(body)
        return result()
      },
      body: function () {
        return java.__req({
          url: self.url,
          method: self.method,
          body: self.bodyText === null ? undefined : self.bodyText,
          headers: self.headers,
        })
      },
    }
    function result() { return api }
    return api
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
  aesDecodeToString: function (data, key, transformation, iv) {
    return java.__crypto('decryptHex', transformation, key, iv, data)
  },
  aesEncodeToString: function (data, key, transformation, iv) {
    return java.__crypto('encryptHex', transformation, key, iv, data)
  },
  aesBase64EncodeToString: function (data, key, transformation, iv) {
    return java.__crypto('encryptBase64ToString', transformation, key, iv, data)
  },

  // 简繁转换。**没有字典表就不做**：原样返回并记一条日志。
  //
  // 为什么不塞一张「常用字」小表：转换是**逐字映射**，表不全就会出现「半简半繁」
  // 的正文 —— 那比整篇繁体更让人以为是站点排版坏了。而完整的对照表（OpenCC 的
  // TSCharacters 有五千多条，含大量罕用字）不适合手抄进源码，抄错几个字的代价
  // 是静默给出错字。所以宁可不转，也不给一个看起来像那么回事的半成品。
  t2s: function (s) { __host.log('[t2s] 未做简繁转换，原样返回'); return String(s) },
  s2t: function (s) { __host.log('[s2t] 未做简繁转换，原样返回'); return String(s) },

  // 以下都需要 WebView / 浏览器，本引擎没有对应能力。
  // **明确报错**，而不是给一个空实现 —— 空实现会让书源表现成
  // 「规则跑通了但一本书都没有」，那是最难定位的一类症状。
  webView: function () { throw new Error('本引擎不支持 java.webView（需要 WebView 渲染）') },
  startBrowserAwait: function () { throw new Error('本引擎不支持 java.startBrowserAwait（需要浏览器）') },
  startBrowser: function () { throw new Error('本引擎不支持 java.startBrowser（需要浏览器）') },
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
  getFile: function () { throw new Error('本引擎不支持 java.getFile（没有可持久化的文件系统）') },
  queryTTF: function () { throw new Error('本引擎不支持 java.queryTTF（字体混淆）') },
  alert: function (s) { __host.log('[alert] ' + String(s)) },
  logType: function (s) { __host.log(String(s)) },

  // ---------------------------------------------------------------- 语料里在调、但没法实现
  //
  // 这些是扫全量书源**数出来**的（java.xxx( 的分布），都属于「需要 App / Android /
  // 浏览器」的能力。给它们一个**带名字**的报错，因为 QuickJS 只会说
  // TypeError: not a function，不说哪一个 —— 脚本动辄几十行，照那句话定位不到。
  //
  // 为什么是报错而不是返回空：这里没有一个「安全的中性值」。拿空 UA 去拼签名、
  // 拿空验证码去登录，错误都会跑到下游，症状离原因更远。宁可在这里失败，
  // 让报错直接说出缺的是哪一个能力。
  //
  // **唯一故意留空的是 java.ajaxTestAll**：🔞 Linpx 与 🔞兽人小说站用它做能力探测
  // （typeof java.ajaxTestAll === 'function'）。给它一个函数，探测就会从
  // 「没有这个能力 → 走另一条路」变成「有 → 调用 → 抛错」，把本来能跑的源弄坏。
  // 不确定的成员，缺着比乱补安全。
  androidId: function () { throw new Error('java.androidId 需要 Android 运行时，本引擎没有') },
  getVerificationCode: function () {
    throw new Error('java.getVerificationCode 需要图形验证码界面，本引擎没有')
  },
  showBrowser: function () { throw new Error('java.showBrowser 需要浏览器界面，本引擎没有') },
  head: function () { throw new Error('java.head 本引擎没有实现（现有的是 ajax / get / post）') },
  getCookie: function () { throw new Error('java.getCookie 本引擎没有实现（用 cookie.getCookieMap 代替）') },
  getStrResponse: function () {
    throw new Error('java.getStrResponse 需要 App 的响应对象，本引擎没有')
  },
  HMacBase64: function () { throw new Error('java.HMacBase64 本引擎没有实现') },
  ruleUrl: function () { throw new Error('java.ruleUrl 需要 App 的界面跳转，本引擎没有') },
  webview: function () { throw new Error('本引擎不支持 java.webview（需要 WebView 渲染）') },

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

// ---------------------------------------------------------------- source

var source = (function () {
  var data = globalThis.__source || {}
  // 与 java.put / java.get(key) 共用同一张变量表（见 JAVA_PRELUDE 开头的说明）——
  // 两条路各存一份的话，「脚本里 put、规则里 getVariable」就会读不到
  var vars = globalThis.__varsOut || {}

  var obj = {}
  for (var k in data) {
    if (k === 'key') continue
    obj[k] = data[k]
  }
  obj.key = data.key === undefined || data.key === null ? '' : String(data.key)

  obj.getKey = function () { return String(obj.key || '') }
  obj.getVariable = function (name) {
    // 不带参数时返回**整个变量表的 JSON 串** —— 七猫小说·API 就是这么读的
    if (name === undefined || name === null) return JSON.stringify(vars)
    var v = vars[String(name)]
    return v === undefined || v === null ? '' : String(v)
  }
  obj.setVariable = function (name, value) {
    vars[String(name)] = value === undefined || value === null ? '' : String(value)
  }
  obj.putVariable = obj.setVariable
  obj.get = obj.getVariable
  obj.put = obj.setVariable
  obj.getVariableMap = function () { return vars }
  obj.getHeaderMap = function () { return __toJavaMap(obj.header) }
  obj.getLoginHeader = function () { return String(obj.__loginHeader || '') }
  obj.getLoginHeaderMap = function () { return __toJavaMap(obj.__loginHeader) }
  obj.putLoginHeader = function (header) {
    obj.__loginHeader = header === undefined || header === null ? '' : String(header)
  }
  obj.getLoginInfoMap = function () { return {} }
  obj.putLoginInfo = function () {}
  obj.refreshExplore = function () { java.refreshExplore() }
  obj.setExploreScreen = function () {}
  return obj
})()

// ---------------------------------------------------------------- cookie / cache
//
// 只在本次求值内有效（见上面 GLOBALS_PRELUDE 的说明）。取不到时返回空串，
// 与 Legado 的语义一致 —— 返回 null 会让 cookie.getCookie(u).length 这类写法报错。

var cookie = (function () {
  var jar = {}
  return {
    getCookie: function (url) { var v = jar[String(url)]; return v === undefined ? '' : v },
    setCookie: function (url, value) { jar[String(url)] = String(value) },
    replaceCookie: function (url, value) { jar[String(url)] = String(value) },
    removeCookie: function (url) { delete jar[String(url)] },
    getCookieMap: function () { return jar },
  }
})()

var cache = (function () {
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
})()

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

var JS_METHODS = [
  'select', 'get', 'first', 'last', 'eq', 'children', 'child', 'childNodeSize',
  'parent', 'parents', 'nextElementSibling', 'prevElementSibling', 'nextAll', 'prevAll',
  'siblingElements', 'not', 'filter', 'clone', 'has', 'is',
  'size', 'isEmpty', 'text', 'ownText', 'textNodes', 'eachText',
  'html', 'outerHtml', 'attr', 'hasAttr', 'val', 'className', 'hasClass',
  'tagName', 'id', 'index', 'matches', 'matchesOwn',
  'remove', 'addClass', 'removeClass', 'append', 'prepend',
]
for (var __i = 0; __i < JS_METHODS.length; __i++) {
  (function (name) {
    JsoupElements.prototype[name] = function () {
      var reply = __jsoupCall(name, this.__id, Array.prototype.slice.call(arguments))
      if (reply.kind === 'handle') return reply.handle === null ? null : new JsoupElements(reply.handle)
      return reply.value
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
    if (reply.kind !== 'handle') return reply.value
    return reply.handle === null ? [] : __listOf(reply.handle)
  }
  var api = {}
  var methods = [
    'select', 'get', 'first', 'last', 'eq', 'children', 'child', 'childNodeSize',
    'parent', 'parents', 'nextElementSibling', 'prevElementSibling', 'nextAll', 'prevAll',
    'siblingElements', 'not', 'filter', 'has', 'is',
    'size', 'isEmpty', 'text', 'ownText', 'textNodes', 'eachText',
    'html', 'outerHtml', 'attr', 'hasAttr', 'val', 'className', 'hasClass',
    'tagName', 'id', 'index', 'matches', 'matchesOwn',
  ]
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
  var methods = [
    'select', 'get', 'first', 'last', 'eq', 'children', 'child', 'childNodeSize',
    'parent', 'parents', 'nextElementSibling', 'prevElementSibling', 'nextAll', 'prevAll',
    'siblingElements', 'not', 'has', 'is',
    'size', 'isEmpty', 'text', 'ownText', 'textNodes', 'eachText',
    'html', 'outerHtml', 'attr', 'hasAttr', 'val', 'className', 'hasClass',
    'tagName', 'id', 'index', 'matches', 'matchesOwn',
  ]
  for (var i = 0; i < methods.length; i++) {
    (function (name) {
      out[name] = function () {
        var reply = __jsoupCall(name, handle, Array.prototype.slice.call(arguments))
        // 返回句柄的集合级方法（select / first / get / not …）继续给「数组形态」，
        // 否则 result.select('a')[0] 这种写法又会退回到不能下标的 JsoupElements
        if (reply.kind !== 'handle') return reply.value
        return reply.handle === null ? [] : __listOf(reply.handle)
      }
    })(methods[i])
  }
  out.toString = function () { return String(__jsoupCall('toString', handle, []).value) }
  return out
}

/**
 * 单个元素句柄 → 「盒装字符串 + 作用在它自己身上的 jsoup 方法」
 *
 * 复用 __htmlApi 那套方法名，但把它们指到**这个元素**的句柄上：
 * 指向文档的话 e.attr('href') 会问到文档根节点，永远返回空串。
 */
function __wrapElement(handle) {
  var html = String(__jsoupCall('outerHtml', handle, []).value)
  var boxed = new String(html)
  var methods = [
    'select', 'get', 'first', 'last', 'eq', 'children', 'child', 'childNodeSize',
    'parent', 'parents', 'nextElementSibling', 'prevElementSibling', 'nextAll', 'prevAll',
    'siblingElements', 'not', 'has', 'is',
    'size', 'isEmpty', 'text', 'ownText', 'textNodes', 'eachText',
    'html', 'outerHtml', 'attr', 'hasAttr', 'val', 'className', 'hasClass',
    'tagName', 'id', 'index', 'matches', 'matchesOwn',
  ]
  for (var i = 0; i < methods.length; i++) {
    (function (name) {
      boxed[name] = function () {
        var reply = __jsoupCall(name, handle, Array.prototype.slice.call(arguments))
        if (reply.kind !== 'handle') return reply.value
        if (reply.handle === null) return []
        return __listOf(reply.handle)
      }
    })(methods[i])
  }
  return boxed
}

/** 把一个集合句柄变成「数组 + 集合级 jsoup 方法」 */
function __listOf(handle) {
  // 逐个元素都直接走桥拿**裸句柄号**：JsoupElements 那层的 get(i) 返回的是包装对象，
  // 把它当句柄号传回去会变成「jsoup 对象已失效」
  var n = Number(__jsoupCall('size', handle, []).value)
  var out = []
  for (var i = 0; i < n; i++) {
    var reply = __jsoupCall('get', handle, [i])
    if (reply.handle === null || reply.handle === undefined) continue
    out.push(__wrapElement(reply.handle))
  }
  return __attachList(handle, out)
}

/** N 段 HTML → 数组形态的 Elements（宿主侧按规则命中了 N 个节点） */
function __elemsFrom(htmls) {
  var reply = __jsoupCall('parseFragments', null, [htmls])
  if (reply.handle === null || reply.handle === undefined) return []
  return __listOf(reply.handle)
}

var org = {
  jsoup: {
    Jsoup: {
      parse: function (html) { return new JsoupElements(__jsoupCall('parse', null, [String(html)]).handle) },
      parseBodyFragment: function (html) {
        return new JsoupElements(__jsoupCall('parseBodyFragment', null, [String(html)]).handle)
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
if (globalThis.__resultAsJsoup) {
  if (Array.isArray(globalThis.result)) {
    globalThis.result = __elemsFrom(globalThis.result)
  } else if (typeof globalThis.result === 'string') {
    globalThis.result = __boxHtml(globalThis.result)
  }
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
        const getStringFn = vm.newAsyncifiedFunction('getString', async (arg) => {
            const raw = String(vm.dump(arg))
            return vm.newString(await handleGetString(raw, { getString }))
        })
        vm.setProp(host, 'getString', getStringFn)
        getStringFn.dispose()

        /**
         * `java.getElements(规则)` 的桥
         *
         * 与 getString 同一套路（命中哪些节点只有规则求值层知道），
         * 只是交回去的不是字符串而是**每个节点的 outerHTML** —— 脚本那侧再解析成 Elements。
         * 同样是 asyncify 函数，因此规则里不能再套 JS（见 analyze.ts 的 getElements 实现）。
         */
        const getElementsFn = vm.newAsyncifiedFunction('getElements', async (arg) => {
            const raw = String(vm.dump(arg))
            return vm.newString(await handleGetElements(raw, { getElements }))
        })
        vm.setProp(host, 'getElements', getElementsFn)
        getElementsFn.dispose()

        /**
         * SHA-256 的同步桥（脚本里同步、宿主侧 await）
         *
         * WebCrypto 的 `subtle.digest` 只给 Promise，所以这条桥必须是 asyncify 的；
         * 而沙箱本来就是 asyncify 的，写法与上面几条异步桥完全一样。
         * 给 `java.digestHex(str, 'SHA-256')` 用（线上 5 处）。
         */
        const sha256Fn = vm.newAsyncifiedFunction('sha256', async (arg) => {
            const text = String(vm.dump(arg))
            return vm.newString(await sha256Hex(text))
        })
        vm.setProp(host, 'sha256', sha256Fn)
        sha256Fn.dispose()

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

        // 两段预置：先 java（它要用 __host），再它依赖 java 的那几个全局对象
        for (const [label, source] of [
            ['java 助手', JAVA_PRELUDE],
            ['全局对象', GLOBALS_PRELUDE],
        ] as const) {
            const prelude = vm.evalCode(source)
            if (prelude.error) {
                const msg = String(vm.dump(prelude.error))
                prelude.error.dispose()
                throw new SandboxError(`沙箱预置失败（${label}）：${msg}`)
            }
            prelude.value.dispose()
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
        if (limits.preludeJs && limits.preludeJs.trim() !== '') {
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
        if (timedOut) {
            throw new SandboxError(`规则脚本超时（>${timeoutMs}ms），已中断`)
        }
        throw err
    } finally {
        // 变量要在**销毁 VM 之前**收回：书源里「搜索脚本先 put、后面的规则再 get」
        // 全靠这一步跨过两次求值（见 SandboxSession.vars）
        collectSourceVars(vm, session)
        releaseHostBridge(vm, runtime)
    }
}

/**
 * 把这次求值里更新过的书源变量收回到会话
 *
 * 读取端是预置脚本里的 `globalThis.__varsOut`（一张普通对象表）。
 * 任何一步失败都只能咽掉 —— 这里发生在求值之后，结果或错误都已经定了，
 * 再抛一个「收变量失败」只会把真正的失败原因盖掉。
 */
function collectSourceVars(vm: QuickJSAsyncContext, session: SandboxSession): void {
    try {
        const handle = vm.evalCode('JSON.stringify(globalThis.__varsOut || {})')
        if (handle.error) {
            handle.error.dispose()
            return
        }
        const text = String(vm.dump(handle.value) ?? '')
        handle.value.dispose()
        const parsed = JSON.parse(text) as Record<string, unknown>
        for (const key of Object.keys(parsed)) {
            session.vars[key] = String(parsed[key] ?? '')
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
