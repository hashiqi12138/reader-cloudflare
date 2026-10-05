/*
 * 把一段 HTML 变成**带段落的纯文本**
 *
 * 为什么需要它：正文的取值方式里 `@html` 占了**一半以上**（线上 816 条启用源里 440 条，
 * 54%），而那一路取回来的是**原样的 HTML** —— 阅读界面是把正文当纯文本渲染的
 * （`public/js/reader.js` 按 `\n` 切段、每个段落 textContent），于是用户看到的是一堆
 * 字面的 `<p>` / `</p>` / `<br>`，而且**段落全糊在一起**。
 *
 * 线上实测（`/api/content` 真取一章）：
 *
 *   📂梦芳小说      `id.rtext@html`   3717 字 / 182 行 / `</p>`×181，正文以 `<p>` 开头
 *   🔞情豆书坊      `#nr1@html`       3808 字 / 142 行 / `</p>`×71
 *   ⚡📂笔趣全家桶   `#nr1@html`       1842 字 /   2 行，正文里连 `<script>read_top()</script>`
 *                                      都原样带着（cheerio 的 `.text()` 会把 script 里的字也算进来）
 *
 * 而 `@text`（以及不写取值时的默认值）是另一个极端：cheerio 的 `.text()` 把
 * `<br>` 直接**丢掉**（实测 `第一段<br>第二段<br><br>第三段` → `第一段第二段第三段`），
 * 段落同样糊在一起。所以两条路都读不出换行 —— 唯独 `@textNodes`（109 条，13%）
 * 因为「每个文本节点各自成一个值、再用 `\n` 拼」才碰巧是对的。
 *
 * 这里只做**一件事**：已经确定的「这段是 HTML」时，按 HTML 的语义摊平成文本 ——
 * `<br>` 与块级元素的边界各落一个换行，标签本身丢掉。取值方式仍然由书源说了算，
 * 这一层不改抽取行为（`@textNodes` 那条路取到的本来就是纯文本，`looksLikeHtml`
 * 会判成假、原样通过）。
 */

import * as cheerio from 'cheerio'

/** domhandler 的节点形状，只取用得上的几个字段 */
interface DomNode {
    type?: string
    name?: string
    data?: unknown
    children?: DomNode[]
}

/**
 * 这些元素的边界要落一个换行 —— 它们本来就是块级，浏览器里就会换行
 *
 * `br` 不在这里（它单独处理：只有结尾要换行，没有内容）。
 * 内联元素（`span` / `a` / `font` / `b` …）**不在**表里：`<span>甲</span><span>乙</span>`
 * 应当还是「甲乙」，加换行会把词切开。
 */
const BLOCK_TAGS = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'caption',
    'center',
    'dd',
    'details',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hr',
    'legend',
    'li',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'summary',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
])

/**
 * 这些节点里的字**不是正文**
 *
 * `script` / `style` 是按 `type` 判的（domhandler 给它们单独的 type），
 * 其余按标签名判。`script` 那一条不是洁癖 —— 线上真有源的正文 div 里挂着
 * `<script>read_top()</script>`，不剔掉就会读到一段 JS。
 */
const SKIP_TYPES = new Set(['comment', 'cdata', 'directive', 'doctype', 'script', 'style'])
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'iframe'])

/**
 * 「这段像 HTML 吗」
 *
 * 判据是**出现了标签形状**，而不是「含 `<`」：小说正文里出现 `<` 是有可能的
 * （`a<b`、`<3`、`<无名>`），那些都不构成 `<标签名>` 的形状，所以不会被误判。
 * 反过来说，只要出现了一个真标签（含 `<br>` 这种**没有闭合**的），就按 HTML 处理 ——
 * `<br>` 重灾区的站点正文里往往就一个 `<br>` 都没有别的标签。
 *
 * 只在**正文**这一层用（见 `src/legado/ops.ts` 的 `fetchContent`）：
 * 字段规则（书名、作者、章节名）不做这一步 —— 那里出现换行反而是坏事。
 */
const HTML_HINT =
    /<\/?(?:br|p|div|span|a|img|font|strong|em|b|i|u|s|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|blockquote|section|article|center|hr|pre|code|figure|figcaption|dl|dt|dd)\b[^>]*>/i

export function looksLikeHtml(text: string): boolean {
    return HTML_HINT.test(text)
}

/**
 * HTML → 纯文本：块级边界与 `<br>` 各落一个换行，标签丢掉，实体解开
 *
 * 实体由 cheerio 在解析时就解好了（`&nbsp;` → `\u00a0`、`&amp;` → `&`），
 * 这里不重复处理；`\u00a0` 与连续空行由 `normalizeContent` 收尾。
 *
 * 首尾多出来的换行不管：调用方下游就是 `normalizeContent`，它会丢掉空行。
 */
export function htmlToText(html: string): string {
    const $ = cheerio.load(html)
    let out = ''

    const newline = (): void => {
        if (!out.endsWith('\n')) out += '\n'
    }

    const walk = (node: DomNode): void => {
        for (const child of node?.children ?? []) {
            if (!child) continue
            if (child.type === 'text') {
                out += String(child.data ?? '')
                continue
            }
            if (SKIP_TYPES.has(String(child.type ?? ''))) continue

            const tag = String(child.name ?? '').toLowerCase()
            if (SKIP_TAGS.has(tag)) continue
            if (tag === 'br') {
                newline()
                continue
            }
            const block = BLOCK_TAGS.has(tag)
            if (block) newline()
            walk(child)
            if (block) newline()
        }
    }

    walk($.root()[0] as unknown as DomNode)
    return out
}
