/**
 * URL 字段里的 JS 片段
 *
 * 顶层 URL 字段（`searchUrl`、`exploreUrl`）里可以写 JS。线上 816 条书源里
 * `searchUrl` 带 JS 的有 85 条，三种写法都要认：
 *
 *   1. 整条是 `@js:`（64 条）—— 脚本的返回值就是地址，常常还带上请求选项：
 *      `@js:qmSearch(key, page)`、`@js:var b='https://…'; b + '/search?q=' + key`
 *   2. 整条是 `<js>…</js>`（17 条）—— 同上，只是换个括号
 *   3. `<地址>,{请求选项}` 后面再跟 `@js:`（4 条）—— 脚本拿到 `result`
 *      （也就是前面那段原文）做重定向/改写，最后返回真正的地址
 *
 * 第三种最容易看错：`@js:` **前面的部分不是前缀**，而是喂给脚本的输入。
 * 所以脚本的输出不能拼回前缀后面 —— 它会得到一个「合法但完全不是那个地址」的 URL，
 * 而那种 URL 往往还能返回 200，只是内容全错。
 *
 * 这里只做「找出 JS 在哪」这件纯文本的事，求值在 `source.ts` 里（要进沙箱）。
 * 拆出来是为了能直接单测：`source.ts` 会把 QuickJS 的 WASM 一起拉进来，
 * 而 WASM 在 Node 单测里跑不起来。
 */

export interface UrlJs {
    /** 脚本的输入：`@js:` / `<js>` 之前那段原文，脚本里就是 `result` */
    prefix: string
    code: string
}

const URL_JS_PREFIX = /^\s*@js:/i
const URL_JS_BLOCK = /<js(?:\s[^>]*)?>([\s\S]*?)(?:<\/js>|$)/i

/** 这个 URL 字段里有没有 JS */
export function hasUrlJs(raw: string): boolean {
    return findUrlJs(raw) !== null
}

/** 找出 URL 字段里的 JS；没有就返回 null */
export function findUrlJs(raw: string): UrlJs | null {
    const leading = URL_JS_PREFIX.exec(raw)
    if (leading) {
        return { prefix: '', code: raw.slice(leading[0].length) }
    }

    const block = URL_JS_BLOCK.exec(raw)
    if (block) {
        return { prefix: raw.slice(0, block.index), code: block[1] ?? '' }
    }

    const at = raw.indexOf('@js:')
    if (at > 0) {
        return { prefix: raw.slice(0, at), code: raw.slice(at + '@js:'.length) }
    }

    return null
}
