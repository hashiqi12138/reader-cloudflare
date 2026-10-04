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
