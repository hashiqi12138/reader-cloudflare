/**
 * 「java 平台」兼容层
 *
 * 书源脚本里的 `java.*` 是**原项目（Legado）的 Android 平台接口**：它的实现散在
 * `help/JsExtensions.kt`（取网 / WebView / 文件 / UI / 时间）与 `help/JsEncodeUtils.kt`
 * （md5 / 摘要 / HMAC / AES / DES / 签名）里。本引擎跑在 Cloudflare Workers 上，
 * 有些能力根本没有对应物（WebView、AndroidId、文件系统），有些则是纯计算、
 * 在沙箱里就能做。
 *
 * 这一层的职责就一件事：**把「原项目的面」显式声明下来**，让三件事由同一张表驱动 ——
 *
 *   1. 沙箱预置：`absent` 的成员由 `unsupportedPrelude()` 生成**带名字报错**的桩
 *      （QuickJS 只会说 `TypeError: not a function`，不说**是哪一个**，几十行的脚本里定位不到）
 *   2. 平台适配：`PlatformCapabilities` 说明**这个平台有什么**，
 *      `PlatformHost` 说明**要接一个新平台必须实现哪几件事** —— 换平台只改这两处
 *   3. 观测与漂移：`javaSurfaceSummary()` 让线上能报出「面有多大、实现了多少」，
 *      单测断言表与沙箱预置一致（表里说实现的必须有、说故意缺的必须没有）
 *
 * 表里每一行的 `upstream` 是**原签名的原样抄写**，不是重新描述的 —— 语义对齐（例如
 * `get` 在上游只有「两参取网」这一个重载）全靠它，不看签名就只能靠猜。
 * 抄写与差集由 `scripts/` 里的一次性脚本从上游文件生成，别再手写。
 *
 * 表里没有的成员，沙箱里就是 `undefined` —— 这是**故意的默认值**：
 * 有书源用 `typeof java.xxx === 'function'` 探测能力来选分支（🔞 Linpx、🏷七猫小说 等），
 * 给它们一个「会抛错的函数」会把本来能跑的源弄坏。所以「不确定」时的安全默认是**缺着**，
 * 只有确认「这个成员上游一直有、书源会无条件调用」时才登记为 `absent`。
 */

/** 成员的支持方式 */
export type PlatformSupport =
    /** 本引擎实现了（纯计算在沙箱里，取网/摘要这类走宿主桥） */
    | 'implemented'
    /** 上游有、本平台没有：生成带名字报错的桩 */
    | 'absent'
    /** 故意不定义：有书源靠 `typeof` 探测它来选分支 */
    | 'keep-absent'

/** 一行 = 一个 `java.*` 成员 */
export interface JavaMember {
    name: string
    /** 上游签名（原样抄自 JsExtensions.kt / JsEncodeUtils.kt）；我们自加的成员为 null */
    upstream: string | null
    support: PlatformSupport
    /** absent 时：缺的是哪一类平台能力 */
    platform?: string
    /** absent 时：报错里那句人话 */
    reason?: string
    /** 实现方式与上游**不一样**的地方 —— 兼容层最该说清楚的就是这些 */
    note?: string
}

/** 平台能提供什么。换平台就是换这一张表。 */
export interface PlatformCapabilities {
    /** 取网（java.ajax / get / post / connect / ajaxAll） */
    http: boolean
    /** WebView 渲染（java.webView / startBrowser*） */
    webview: boolean
    /** Android 运行时（androidId / 验证码 / 字体混淆） */
    android: boolean
    /** 界面动作（toast / openUrl / 浏览器） */
    ui: boolean
    /** 可持久化的文件系统（缓存文件 / 解压 / 读字体） */
    filesystem: boolean
}

/**
 * 当前平台：Cloudflare Workers
 *
 * 只有「取网」这一项是有的 —— 其余四项恰恰是上游那些能力的来源，
 * 所以表里凡是需要它们的成员都登记成 `absent`（报出名字，而不是静默给空值）。
 */
export const WORKERS_PLATFORM: PlatformCapabilities = {
    http: true,
    webview: false,
    android: false,
    ui: false,
    filesystem: false,
}

/**
 * 接一个新平台要实现的宿主桥
 *
 * 这是「适配其他平台」的**唯一接缝**：沙箱那侧（`JAVA_PRELUDE`）不用改，
 * 只要在宿主侧把这几个能力实现出来、注册进沙箱的 `__host` 即可。
 *
 * 形状与 `engine/js.ts` 里 `vm.setProp(host, …)` 注册的完全一致；
 * 名字都是**动宾短语**而不是被包一层的 `bridge.*`，因为沙箱预置直接按这些名字调用。
 */
export interface PlatformHost {
    /** 同步：base64 编解码（按 UTF-8 字节） */
    b64encode(text: string): string
    b64decode(text: string): string
    /** 同步：base64 → 原始字节数组的 JSON 串 */
    base64Bytes(text: string): string
    /** 同步：字符串 → UTF-8 字节数组的 JSON 串 */
    utf8Bytes(text: string): string
    /** 同步：MD5 十六进制 */
    md5(text: string): string
    /** 异步（脚本里同步）：SHA-256 十六进制 */
    sha256(text: string): Promise<string>
    /** 同步：时间格式化（含时区偏移） */
    timeFormat(time: number, format: string | null, offset: number | null): string
    /** 同步：记一行日志 */
    log(text: string): void
    /** 异步（脚本里同步）：取一次网 */
    request(optionsJson: string): Promise<string>
    /** 异步（脚本里同步）：把一条规则求值成字符串 / 节点集 */
    getString(argsJson: string): Promise<string>
    getElements(argsJson: string): Promise<string>
    /** 同步：org.jsoup 的节点操作桥 */
    jsoup(argsJson: string): string
}

/** 线的规模：`/api/probe` 用它报出「面有多大、实现了多少」 */
export function javaSurfaceSummary(): {
    total: number
    implemented: number
    absent: number
    keepAbsent: number
} {
    return {
        total: JAVA_SURFACE.length,
        implemented: JAVA_SURFACE.filter((m) => m.support === 'implemented').length,
        absent: JAVA_SURFACE.filter((m) => m.support === 'absent').length,
        keepAbsent: JAVA_SURFACE.filter((m) => m.support === 'keep-absent').length,
    }
}

/** 某个成员在表里的登记（沙箱之外的调用方用它判断该不该有） */
export function javaMember(name: string): JavaMember | undefined {
    return JAVA_SURFACE.find((m) => m.name === name)
}

/**
 * 「本平台没有」的成员：生成**带名字**的桩
 *
 * 报错里带上名字与缺的能力，是因为 QuickJS 的 `TypeError: not a function` 不说哪一个。
 * 返回值会被拼进 `JAVA_PRELUDE` 的模板串里，所以这里**不能出现反引号与 `${`**。
 */
export function unsupportedPrelude(): string {
    return JAVA_SURFACE.filter((m) => m.support === 'absent')
        .map((m) => {
            const message = `java.${m.name}：本引擎没有这个能力（${m.reason ?? '需要 App 侧能力'}）`
            return `  ${m.name}: function () { throw new Error(${JSON.stringify(message)}) },`
        })
        .join('\n')
}

/**
 * 沙箱里应当出现的全部成员名
 *
 * 单测拿它与 `JAVA_PRELUDE` 实际定义的名字比对：`implemented` 的必须有、
 * `keep-absent` 的必须没有 —— 表和实现漂移过一次就很难再信这张表。
 */
export function declaredImplementedNames(): string[] {
    return JAVA_SURFACE.filter((m) => m.support === 'implemented').map((m) => m.name)
}

/** 表里登记为「故意不定义」的名字 */
export function declaredKeepAbsentNames(): string[] {
    return JAVA_SURFACE.filter((m) => m.support === 'keep-absent').map((m) => m.name)
}

// ---------------------------------------------------------------------- 表

/**
 * 生成说明：这张表由上游 `JsExtensions.kt` + `JsEncodeUtils.kt` 抽出的面、
 * 减去/加上本引擎实际实现的名字得到，`upstream` 一栏是原样抄的签名。
 */
export const JAVA_SURFACE: JavaMember[] = [
    {
        name: 'aesBase64DecodeToByteArray',
        upstream: 'str: String, key: String, transformation: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'aesBase64DecodeToString',
        upstream: 'str: String, key: String, transformation: String, iv: String',
        support: 'implemented',
    },
    { name: 'aesBase64EncodeToString', upstream: null, support: 'implemented' },
    {
        name: 'aesDecodeArgsBase64Str',
        upstream: 'data: String, key: String, mode: String, padding: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'aesDecodeToByteArray',
        upstream: 'str: String, key: String, transformation: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'aesDecodeToString',
        upstream: 'str: String, key: String, transformation: String, iv: String',
        support: 'implemented',
    },
    {
        name: 'aesEncodeArgsBase64Str',
        upstream: 'data: String, key: String, mode: String, padding: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'aesEncodeToBase64ByteArray',
        upstream: 'data: String, key: String, transformation: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'aesEncodeToBase64String',
        upstream: 'data: String, key: String, transformation: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'aesEncodeToByteArray',
        upstream: 'data: String, key: String, transformation: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'aesEncodeToString',
        upstream: 'data: String, key: String, transformation: String, iv: String',
        support: 'implemented',
    },
    {
        name: 'ajax',
        upstream: 'url: Any | url: Any, callTimeout: Long?',
        support: 'implemented',
        note: '走宿主桥，超时/次数上限由引擎统一控制，不受书源 concurrentRate 影响',
    },
    {
        name: 'ajaxAll',
        upstream: 'urlList: Array<String> | urlList: Array<String>, skipRateLimit: Boolean',
        support: 'implemented',
    },
    {
        name: 'ajaxTestAll',
        upstream:
            'urlList: Array<String>, timeout: Int | urlList: Array<String>, timeout: Int, skipRateLimit: Boolean',
        support: 'keep-absent',
        reason: '故意不定义：有书源用 typeof 探测它来选分支',
    },
    { name: 'alert', upstream: null, support: 'implemented' },
    {
        name: 'androidId',
        upstream: '',
        support: 'absent',
        platform: 'android',
        reason: '需要 Android 运行时',
    },
    {
        name: 'base64Decode',
        upstream: 'str: String? | str: String?, charset: String | str: String, flags: Int',
        support: 'implemented',
    },
    {
        name: 'base64DecodeToByteArray',
        upstream: 'str: String? | str: String?, flags: Int',
        support: 'implemented',
    },
    {
        name: 'base64Encode',
        upstream: 'str: String | str: String, flags: Int',
        support: 'implemented',
    },
    {
        name: 'bytesToStr',
        upstream: 'bytes: ByteArray | bytes: ByteArray, charset: String',
        support: 'implemented',
        note: '按 UTF-8 解析',
    },
    {
        name: 'cacheFile',
        upstream: 'urlStr: String | urlStr: String, saveTime: Int',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'connect',
        upstream:
            'urlStr: String | urlStr: String, header: String? | urlStr: String, header: String?, callTimeout: Long?',
        support: 'implemented',
    },
    { name: 'copyText', upstream: null, support: 'implemented', note: '没有剪贴板，只记日志' },
    {
        name: 'createAsymmetricCrypto',
        upstream: 'transformation: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'createSign',
        upstream: 'algorithm: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'createSymmetricCrypto',
        upstream:
            'transformation: String, key: ByteArray?, iv: ByteArray? | transformation: String, key: ByteArray | transformation: String, key: String | transformation: String, key: String, iv: String?',
        support: 'implemented',
    },
    {
        name: 'deleteFile',
        upstream: 'path: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'desBase64DecodeToString',
        upstream: 'data: String, key: String, transformation: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'desDecodeToString',
        upstream: 'data: String, key: String, transformation: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'desEncodeToBase64String',
        upstream: 'data: String, key: String, transformation: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'desEncodeToString',
        upstream: 'data: String, key: String, transformation: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'digestBase64Str',
        upstream: 'data: String, algorithm: String,',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'digestHex',
        upstream: 'data: String, algorithm: String,',
        support: 'implemented',
        note: '只实现 MD5 与 SHA-256',
    },
    {
        name: 'downloadFile',
        upstream: 'url: String | content: String, url: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'encodeURI',
        upstream: 'str: String | str: String, enc: String',
        support: 'implemented',
    },
    {
        name: 'get',
        upstream:
            'urlStr: String, headers: Map<String, String> | urlStr: String, headers: Map<String, String>, timeout: Int?',
        support: 'implemented',
        note: '一参读变量、两参才取网：上游只有两参重载，但线上 141 处写法是 java.get("名字") 读变量',
    },
    {
        name: 'get7zByteArrayContent',
        upstream: 'url: String, path: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'get7zStringContent',
        upstream: 'url: String, path: String | url: String, path: String, charsetName: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'getCookie',
        upstream: 'tag: String | tag: String, key: String?',
        support: 'absent',
        platform: 'http',
        reason: '需要连接级取网，可用 cookie.getCookieMap 代替',
    },
    { name: 'getElement', upstream: null, support: 'implemented' },
    { name: 'getElements', upstream: null, support: 'implemented' },
    {
        name: 'getFile',
        upstream: 'path: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'getRarByteArrayContent',
        upstream: 'url: String, path: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'getRarStringContent',
        upstream: 'url: String, path: String | url: String, path: String, charsetName: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'getReadBookConfig',
        upstream: '',
        support: 'absent',
        platform: 'ui',
        reason: '需要 App 侧的配置/界面对象',
    },
    {
        name: 'getReadBookConfigMap',
        upstream: '',
        support: 'absent',
        platform: 'ui',
        reason: '需要 App 侧的配置/界面对象',
    },
    {
        name: 'getSource',
        upstream: '',
        support: 'absent',
        platform: 'ui',
        reason: '需要 App 侧的配置/界面对象',
    },
    { name: 'getString', upstream: null, support: 'implemented' },
    { name: 'getStringList', upstream: null, support: 'implemented' },
    {
        name: 'getTag',
        upstream: '',
        support: 'absent',
        platform: 'ui',
        reason: '需要 App 侧的配置/界面对象',
    },
    {
        name: 'getThemeConfig',
        upstream: '',
        support: 'absent',
        platform: 'ui',
        reason: '需要 App 侧的配置/界面对象',
    },
    {
        name: 'getThemeConfigMap',
        upstream: '',
        support: 'absent',
        platform: 'ui',
        reason: '需要 App 侧的配置/界面对象',
    },
    {
        name: 'getThemeMode',
        upstream: '',
        support: 'absent',
        platform: 'ui',
        reason: '需要 App 侧的配置/界面对象',
    },
    {
        name: 'getTxtInFolder',
        upstream: 'path: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    { name: 'getUA', upstream: null, support: 'implemented' },
    { name: 'getUserAgent', upstream: null, support: 'implemented' },
    {
        name: 'getVerificationCode',
        upstream: 'imageUrl: String',
        support: 'absent',
        platform: 'android',
        reason: '需要图形验证码界面（要能看图）',
    },
    {
        name: 'getWebViewUA',
        upstream: '',
        support: 'implemented',
        note: '返回一个写死的 Android WebView UA，不随书源变化',
    },
    {
        name: 'getZipByteArrayContent',
        upstream: 'url: String, path: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'getZipStringContent',
        upstream: 'url: String, path: String | url: String, path: String, charsetName: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'head',
        upstream:
            'urlStr: String, headers: Map<String, String> | urlStr: String, headers: Map<String, String>, timeout: Int?',
        support: 'absent',
        platform: 'http',
        reason: '需要连接级取网（本引擎只有 ajax / get / post）',
    },
    {
        name: 'hexDecodeToByteArray',
        upstream: 'hex: String',
        support: 'absent',
        platform: 'android',
        reason: '需要 App 侧能力',
    },
    { name: 'hexDecodeToString', upstream: 'hex: String', support: 'implemented' },
    { name: 'hexEncodeToString', upstream: 'utf8: String', support: 'implemented' },
    {
        name: 'HMacBase64',
        upstream: 'data: String, algorithm: String, key: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'HMacHex',
        upstream: 'data: String, algorithm: String, key: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    { name: 'htmlFormat', upstream: 'str: String', support: 'implemented' },
    {
        name: 'importScript',
        upstream: 'path: String',
        support: 'absent',
        platform: 'android',
        reason: '需要 Android 侧的执行环境',
    },
    { name: 'log', upstream: 'msg: Any?', support: 'implemented' },
    { name: 'logType', upstream: 'any: Any?', support: 'implemented' },
    {
        name: 'longToast',
        upstream: 'msg: Any?',
        support: 'implemented',
        note: '没有界面，只记日志',
    },
    { name: 'md5Encode', upstream: 'str: String', support: 'implemented' },
    {
        name: 'md5Encode16',
        upstream: 'str: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    { name: 'open', upstream: null, support: 'implemented' },
    { name: 'openBook', upstream: null, support: 'implemented' },
    {
        name: 'openUrl',
        upstream: 'url: String | url: String, mimeType: String? = null',
        support: 'implemented',
        note: '没有界面，只记日志',
    },
    { name: 'openWeb', upstream: null, support: 'implemented' },
    {
        name: 'post',
        upstream:
            'urlStr: String, body: String, headers: Map<String, String> | urlStr: String, body: String, headers: Map<String, String>, timeout: Int?',
        support: 'implemented',
    },
    {
        name: 'put',
        upstream: null,
        support: 'implemented',
        note: '上游 JsExtensions/JsEncodeUtils 里没有这个成员，但线上 130 处在用（存变量）',
    },
    {
        name: 'queryBase64TTF',
        upstream: 'data: String?',
        support: 'absent',
        platform: 'android',
        reason: '需要字体混淆解析（Android 侧能力）',
    },
    {
        name: 'queryTTF',
        upstream: 'data: Any?, useCache: Boolean | data: Any?',
        support: 'absent',
        platform: 'android',
        reason: '需要字体混淆解析（Android 侧能力）',
    },
    {
        name: 'randomUUID',
        upstream: '',
        support: 'implemented',
        note: '用 Math.random 拼 v4 形状，不是密码学随机',
    },
    {
        name: 'readFile',
        upstream: 'path: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'readTxtFile',
        upstream: 'path: String | path: String, charsetName: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    { name: 'refreshExplore', upstream: null, support: 'implemented' },
    { name: 'refreshTocUrl', upstream: null, support: 'implemented', note: '目录按需重取，忽略' },
    {
        name: 'replaceFont',
        upstream:
            'text: String, errorQueryTTF: QueryTTF?, correctQueryTTF: QueryTTF?, filter: Boolean | text: String, errorQueryTTF: QueryTTF?, correctQueryTTF: QueryTTF?',
        support: 'absent',
        platform: 'android',
        reason: '需要字体混淆解析（Android 侧能力）',
    },
    {
        name: 's2t',
        upstream: 'text: String',
        support: 'implemented',
        note: '只记一行日志、原样返回（不做简繁转换）',
    },
    { name: 'searchBook', upstream: null, support: 'implemented', note: '不做跨源搜索，返回空串' },
    {
        name: 'setContent',
        upstream: null,
        support: 'implemented',
        note: '设过之后 getString / getElements 在它上面求值（上游在 WebView 里生效）',
    },
    { name: 'sleep', upstream: null, support: 'implemented', note: 'Worker 里不能阻塞线程，忽略' },
    {
        name: 'startBrowser',
        upstream: 'url: String, title: String | url: String, title: String, html: String?',
        support: 'absent',
        platform: 'webview',
        reason: '需要 WebView/浏览器界面',
    },
    {
        name: 'startBrowserAwait',
        upstream:
            'url: String, title: String | url: String, title: String, refetchAfterSuccess: Boolean | url: String, title: String, refetchAfterSuccess: Boolean, html: String?',
        support: 'absent',
        platform: 'webview',
        reason: '需要 WebView/浏览器界面',
    },
    {
        name: 'strToBytes',
        upstream: 'str: String | str: String, charset: String',
        support: 'implemented',
    },
    {
        name: 't2s',
        upstream: 'text: String',
        support: 'implemented',
        note: '只记一行日志、原样返回（不做简繁转换）',
    },
    { name: 'timeFormat', upstream: 'time: Long', support: 'implemented' },
    {
        name: 'timeFormatUTC',
        upstream: 'time: Long, format: String, sh: Int',
        support: 'implemented',
    },
    { name: 'toast', upstream: 'msg: Any?', support: 'implemented', note: '没有界面，只记日志' },
    { name: 'toNumChapter', upstream: 's: String?', support: 'implemented' },
    {
        name: 'toURL',
        upstream: 'urlStr: String | url: String, baseUrl: String? = null',
        support: 'absent',
        platform: 'android',
        reason: '需要 App 侧能力',
    },
    {
        name: 'tripleDESDecodeArgsBase64Str',
        upstream: 'data: String, key: String, mode: String, padding: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'tripleDESDecodeStr',
        upstream: 'data: String, key: String, mode: String, padding: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'tripleDESEncodeArgsBase64Str',
        upstream: 'data: String, key: String, mode: String, padding: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'tripleDESEncodeBase64Str',
        upstream: 'data: String, key: String, mode: String, padding: String, iv: String',
        support: 'absent',
        platform: 'none',
        reason: '摘要/加解密，纯计算，还没实现',
    },
    {
        name: 'un7zFile',
        upstream: 'zipPath: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'unArchiveFile',
        upstream: 'zipPath: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'unrarFile',
        upstream: 'zipPath: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    {
        name: 'unzipFile',
        upstream: 'zipPath: String',
        support: 'absent',
        platform: 'filesystem',
        reason: '需要可持久化的文件系统',
    },
    { name: 'upLoginData', upstream: null, support: 'implemented', note: '没有登录态上传，忽略' },
    {
        name: 'webView',
        upstream:
            'html: String?, url: String?, js: String? | html: String?, url: String?, js: String?, cacheFirst: Boolean',
        support: 'absent',
        platform: 'webview',
        reason: '需要 WebView/浏览器界面',
    },
    {
        name: 'webViewGetOverrideUrl',
        upstream:
            'html: String?, url: String?, js: String?, overrideUrlRegex: String | html: String?, url: String?, js: String?, overrideUrlRegex: String, cacheFirst: Boolean | html: String?, url: String?, js: String?, overrideUrlRegex: String, cacheFirst: Boolean, delayTime: Long',
        support: 'absent',
        platform: 'webview',
        reason: '需要 WebView/浏览器界面',
    },
    {
        name: 'webViewGetSource',
        upstream:
            'html: String?, url: String?, js: String?, sourceRegex: String | html: String?, url: String?, js: String?, sourceRegex: String, cacheFirst: Boolean | html: String?, url: String?, js: String?, sourceRegex: String, cacheFirst: Boolean, delayTime: Long',
        support: 'absent',
        platform: 'webview',
        reason: '需要 WebView/浏览器界面',
    },
]
