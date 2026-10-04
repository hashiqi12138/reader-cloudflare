/**
 * `loginUrl` 里那段脚本的形态归一
 *
 * 原项目的 `loginUrl` 是**直接可执行的 JS**（App 拿到它就 `evaluate`），
 * 所以语料里绝大多数是裸脚本：
 *
 *   function checkSite(){ try{ var t = Date.now(); … } }        📂台湾小说网
 *   var QQ_GROUP = "1097919737"; function login(){ … }          ⚡📂米读小说
 *
 * 但也有一批书源按**别处**的写法给它加了标记（`@js:` / `<js>…</js>`）：
 *
 *   @js:
 *   function login(){ var m=source.getLoginInfoMap()||{}; … }   📂霹雳书屋
 *
 * 那两种标记是**规则字段**的语法，在这里只是两段多余的字符 —— 不剥掉的话，
 * 沙箱会拿它们当 JS 解析，报出来的是 `SyntaxError: unexpected token '@'`，
 * 一个把人往「书源写错了」方向带的错（而书源在 App 里跑得好好的）。
 *
 * 剥的范围刻意很窄：只去掉**开头**的一个 `@js:`，以及**整段**被 `<js>…</js>`
 * 包住时的那对标签。散落在中间的 `@js:` 不动 —— 那可能是脚本自己的字符串内容。
 */

/** 直接拿去 `runInSandbox` 的脚本；空脚本返回空串（调用方据此判「没写登录脚本」） */
export function normalizeLoginScript(raw: string | undefined | null): string {
    let text = String(raw ?? '').trim()
    if (text === '') return ''

    // 整段被 <js>…</js> 包住：连标签一起去掉
    const block = /^<js(?:\s[^>]*)?>([\s\S]*?)<\/js>$/i.exec(text)
    if (block) text = block[1]!.trim()

    // 开头的 @js: 标记（大小写都认，后面可以跟空格或换行）
    text = text.replace(/^@js:\s*/i, '')

    return text.trim()
}

/**
 * 给登录脚本补上「调用 `login()`」那一步
 *
 * 登录 URL 的约定是：**脚本要实现一个 `login` 函数，由宿主调用它** ——
 * 官方文档「认证与登录」原话：「可填写登录链接或实现登录逻辑的 JavaScript。
 * 配合登录 UI 使用时，需要实现 `login` 函数。」（按钮那侧由登录 UI 触发，
 * 而 `login` 是宿主调的。）
 *
 * 量了语料：**40 条脚本型 `loginUrl` 里 33 条**就是「定义 `login()` 等着被调」，
 * 而且**没有一条自己调**。只求值不调用，那 33 条什么都不会发生（连 toast 都没有）——
 * 而这一轮要的恰恰是「跑一次登录」。
 *
 * 两处刻意收窄：
 * - 脚本里**没有** `function login(` 就原样返回（🎬🔞黄豆短剧 那种没这一层的）
 * - 脚本自己**已经在顶层调过** `login()` 的原样返回（语料 0 条，但重复跑一次登录
 *   可能真的重复提交一次请求，不值得赌）
 *
 * 追加在同一段脚本里（而不是另起一次求值），是为了共用同一套错误处理与日志收回；
 * 沙箱每次求值都是新上下文，另起一次根本看不到上一步定义的 `login`。
 */
export function loginInvocation(script: string): string {
    if (!/function\s+login\s*\(/.test(script)) return script
    // 把声明本身抠掉再找调用，免得把 `function login()` 里那个 `login(` 当成调用
    const withoutDeclarations = script.replace(/function\s+login\s*\([^)]*\)/g, '')
    if (/(^|[^.\w$])login\s*\(\s*\)/.test(withoutDeclarations)) return script
    return `${script}\n;if (typeof login === "function") { login(); }`
}

/**
 * 有的 `loginUrl` 根本不是脚本，而是**一条登录页地址**
 *
 * 语料里 116 条 `loginUrl` 有 **65 条**是这种：`https://m.uaa.com/`、`/login.php`、
 * `http://m.zhuishushenqi.com/login?source=/setting`；另有几条是「地址 + 选项」的
 * JSON 写法（`{ "url": "null" }` / `{ "url": "" }`）。App 遇到它们就是**用 WebView
 * 打开那个页面**让人手动登录，不存在「跑一段脚本」这回事。
 *
 * 本平台没有 WebView（见 README 的「WebView 那一族」），所以这种源跑不了 ——
 * 但**硬当 JS 求值只会报一句 `SyntaxError`**，把「我们打不开登录页」说成
 * 「书源的脚本写错了」，方向是错的。这里把它认出来，好让调用方给一句明白话。
 *
 * 返回地址（可能是空串，如 `{ "url": "" }`）；不是地址形态则返回 `undefined`。
 */
export function loginAddressOf(raw: string | undefined | null): string | undefined {
    const text = String(raw ?? '').trim()
    if (text === '') return undefined

    // 裸地址：`http(s)://…` 或站内相对路径 `/…`（`###挂梯` 那种尾巴也跟着，不影响判断）
    if (/^https?:\/\//i.test(text)) return text
    if (/^\/\S*$/.test(text)) return text

    // 「地址 + 选项」的 JSON 写法，例如 `{ "url": "null" }`
    if (text.startsWith('{')) {
        try {
            const parsed = JSON.parse(text) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const url = (parsed as { url?: unknown }).url
                if (typeof url === 'string') return url
            }
        } catch {
            /* 不是合法 JSON —— 按脚本处理（有些脚本就以 `{` 开头的块语句起手） */
        }
    }
    return undefined
}
