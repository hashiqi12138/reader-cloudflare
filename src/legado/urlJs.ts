/**
 * URL 字段里的纯文本处理
 *
 * 两件事：
 *   1. 找出 URL 字段里的 JS 片段（求值在 `source.ts` 里，要进沙箱）
 *   2. 展开 `<,...>` 可选段（第一页无页码）
 *
 * 都拆出来是为了能直接单测：`source.ts` 会把 QuickJS 的 WASM 一起拉进来，
 * 而 WASM 在 Node 单测里跑不起来。
 *
 * --- 关于 JS 片段 ---
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
 */

import { indexOfJsMarker, JS_MARKER } from '../engine/directives'

export interface UrlJs {
    /** 脚本的输入：`@js:` / `<js>` 之前那段原文，脚本里就是 `result` */
    prefix: string
    code: string
}

// 这两个正则本来就在，只是取 `@js:` 那段的位置原来用的是 `indexOf('@js:')` ——
// 于是「整条 `@JS:` 开头」认得出来、「选择器@JS:」认不出来，同一个文件里两种行为。
// 现在位置查找统一走 directives.ts（它同时也是 analyze.ts 那五处的唯一匹配源）
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

    const at = indexOfJsMarker(raw)
    if (at > 0) {
        return { prefix: raw.slice(0, at), code: raw.slice(at + JS_MARKER.length) }
    }

    return null
}

/**
 * URL 里的可选段 `<,...>`，等价于 `{{page - 1 == 0 ? "": page}}`
 *
 * 含义是「**第一页不要页码**」：线上典型写法是 `/latest/<,index_{{page}}.html>` ——
 * 第 1 页取 `/latest/`，第 2 页才取 `/latest/index_2.html`。
 *
 * 不处理的话整段（连同尖括号）会原样进 URL，被编码成 `%3C,index_1.html%3E`，
 * 得到一个**必然 404 的地址** —— 这正是线上「分类拉得出来、书列表却是空的」的一类原因。
 *
 * 只认 `<,` 开头的段：`<js>` 是脚本块、`<div>` 之类的 HTML 片段也合法，
 * 不能见尖括号就吞。
 */
const OPTIONAL_SEGMENT = /<,([^<>]*)>/g

export function applyOptionalSegments(template: string, page: number): string {
    if (!template.includes('<,')) return template
    return template.replace(OPTIONAL_SEGMENT, (_match, inner: string) => (page <= 1 ? '' : inner))
}
