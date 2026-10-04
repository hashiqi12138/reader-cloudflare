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
