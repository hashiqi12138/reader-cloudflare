/**
 * Legado「JSOUP 默认规则」的解析
 *
 * 规则形如 `class.odd.0@tag.a.0@text`：
 *   - `@` 分段，从头到尾逐级向下筛选
 *   - 每段最多三部分：类型、名称、位置。类型有 class / id / tag / text / children
 *   - 最后一段通常是「取什么」：text / textNodes / ownText / html / href / src / 任意属性名
 *   - 位置写法有三种：`class.odd.0`（点号）、`tag.div[0]`（方括号）、`[!1,3]`（排除）
 *   - `class.A B` 里的**空格表示「这两个类都要有」**（jsoup 的 `getElementsByClass`
 *     把参数按空白拆开、要求每一个都命中），线上 151 处 / 71 源
 *   - 规则最前面加 `-` 表示把整个结果列表倒置（有些站的目录是倒着排的）
 *
 * 这里只做**解析**，不碰 cheerio：把规则翻译成一份与解析器无关的计划，
 * 由 select.ts 负责执行。这样换解析实现不会牵动这里。
 */

import { EXTRACT_KINDS } from './types'

/** 选择步骤的类型 */
export type StepBy = 'class' | 'id' | 'tag' | 'text' | 'children'

/** 位置选择：单点、区间、或排除 */
export interface IndexSpec {
    /** 要保留的位置。数字表示单个序号，三元组表示 [start, end, step] 区间；null 表示该端省略 */
    picks?: Array<number | [number | null, number | null, number | null]>
    /** 要排除的序号。为了不把语义搞混，排除只支持单个序号，不支持区间 */
    excludes?: number[]
}

export interface JsoupStep {
    by: StepBy
    /** class/id/tag 的名称；text 表示用来匹配的文本；children 时为空 */
    name: string
    index: IndexSpec | null
}

export interface JsoupPlan {
    steps: JsoupStep[]
    /** 取值方式，缺省 text */
    extract: string
    /** 结果列表是否倒置 */
    reverse: boolean
}

/**
 * 这些词在第一段位置上是「选择类型」，不能被当成取值
 *
 * 注意这里**故意不含 `text`**：`text` 有两种语义，取决于位置 ——
 *   `text.下一页@href`  → 前段，按文本内容找元素
 *   `tag.a.0@text`      → 末段，取值（取文本）
 * 所以判断放在 `isExtractToken` 里按「是否带点」来区分，而不是在这里一刀切。
 */
const SELECT_KEYWORDS = new Set(['class', 'id', 'tag', 'children'])

const EXTRACT_SET = new Set<string>(EXTRACT_KINDS)

/** 判断某一段是「取值」而不是「选择」 */
function isExtractToken(token: string): boolean {
    if (token === '') return false
    // 带点或方括号的一定是选择器（`text.下一页`、`tag.a.0`、`.1`）
    if (token.includes('.') || token.includes('[')) return false
    // children 是选择步骤，不是取值
    if (SELECT_KEYWORDS.has(token)) return false
    // 已知取值名（text / href / textNodes ...），或任意属性名
    return EXTRACT_SET.has(token) || /^[A-Za-z_][\w:-]*$/.test(token)
}

function numOrNull(raw: string | undefined): number | null {
    if (raw === undefined) return null
    const t = raw.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
}

/**
 * 解析下标表达式：`0`、`-1`、`-1:0`、`1:10:2`、`!1,3`、`!0:1:2`、`!0:-1`、`!0:3:-1:-2`
 *
 * `!` 那一支读成「**排除这些下标**」，而不是「区间取反」：
 * ① Legado 的规则文档就是这么写的（`!` 排除、序号用 `:` 隔开）；
 * ② 语料里存在 `!0:3:-1:-2`（📂️乐文小说）与 `!0:-1:-2`（📂天下书盟）这种**非单调**的写法 ——
 *    当成区间根本读不出来，只能是「排除 0、3、倒数第一、倒数第二」这样一串下标。
 * `,` 与 `:` 都当分隔符（两种写法语料里都有）。
 */
export function parseIndexExpr(expr: string): IndexSpec | null {
    const t = expr.trim()
    if (t === '') return null

    if (t.startsWith('!')) {
        const nums = t
            .slice(1)
            .split(/[:,]/)
            .map((x) => numOrNull(x))
            .filter((n): n is number => n !== null)
        return nums.length ? { excludes: nums } : null
    }

    const picks: IndexSpec['picks'] = []
    for (const part of t.split(',')) {
        const p = part.trim()
        if (p === '') continue
        if (p.includes(':')) {
            const [s, e, st] = p.split(':')
            picks.push([numOrNull(s), numOrNull(e), numOrNull(st)])
        } else {
            const n = numOrNull(p)
            if (n !== null) picks.push(n)
        }
    }
    return picks.length ? { picks } : null
}

/**
 * 拆掉段尾的下标表达式：`tr!0` → (`tr`, 排除 0)、`dd.2:3` → (`dd`, 第 2 到第 3 个)
 *
 * 三种写法**同义**，都走同一个 `parseIndexExpr`：
 *   `.N`   点号（`dd.2:3`、`class.book-dir.1`）
 *   `[N]`  方括号（`p[-1]`）
 *   `!N`   排除（`tr!0`、`dd!0:1:2:3`、`p!0:-1`）—— `!` 后面紧跟数字才算，
 *          所以 `class.a!b` 这种照样是一整个类名，不会被切开
 *
 * 下标解析不出来时**原样返回**（`.book_list2 ul>li>a[href*='.html']` 的属性选择器
 * 不能被当成位置 —— `parseIndexExpr` 对非数字给 null，正好用来区分）。
 */
function splitSegmentIndex(rest: string): { name: string; index: IndexSpec | null } {
    const m = /^(.*?)(?:\.(-?\d+(?::-?[\d%]*)?)|\[([^\]]*)\]|!(-?\d(?:[-:,\d]*\d)?))$/.exec(rest)
    if (!m) return { name: rest, index: null }
    const name = m[1] ?? ''
    // `.` / `[` / `!` 前面必须有名字（`.1` 那种纯索引段由 `parseSegment` 的开头单独处理）
    if (name === '') return { name: rest, index: null }
    const index = parseIndexExpr(m[2] ?? m[3] ?? `!${m[4] ?? ''}`)
    return index ? { name, index } : { name: rest, index: null }
}

/** 解析 `class.odd.0` / `tag.div[-1:0]` / `tag.tr!0` / `children` 这类单段 */
function parseSegment(seg: string): JsoupStep | null {
    // 纯索引段：`.1` 或 `[1]`，等价于 children[1]
    if (seg.startsWith('.') || seg.startsWith('[')) {
        const inner = seg.startsWith('[') ? seg.replace(/^\[/, '').replace(/\]$/, '') : seg.slice(1)
        return { by: 'children', name: '', index: parseIndexExpr(inner) }
    }

    const m = /^(class|id|tag|text|children)(?:\.(.*))?$/.exec(seg)
    if (!m) {
        // 没写类型的裸名字按**标签名**处理。Legado 明确把
        // `head@.1@text` 与 `head@children[1]@text` 视为等价，
        // 所以 `head`、`div`、`ul[1]`、`tr!0` 这类写法必须认。
        //
        // 位置后缀三种写法（`.` / `[]` / `!`）都走 `splitSegmentIndex`，语义与
        // `dd[2:3]` 完全一致 —— 线上 `tr!0` / `dd!0:1:2:3:4:5` 这一类共 110 处，
        // 以前 `tr!0` 会被整段当成标签名交给 CSS，cheerio 不报错、静默返回 0 条。
        const bare = splitSegmentIndex(seg)
        if (!/^[A-Za-z][\w:-]*$/.test(bare.name)) return null
        return { by: 'tag', name: bare.name, index: bare.index }
    }

    // 写了类型的那些（`tag.tr!0` / `class.button!-1` / `text.下一页`）：类型后面整段当名字 + 下标
    return { by: m[1] as StepBy, ...splitSegmentIndex(m[2] ?? '') }
}

/**
 * HTML 的标签名
 *
 * 两个用途，都是「判断一个裸词是标签还是别的什么」：
 *   1. **列表规则**末尾那个裸词（`class.chapters@li@a` 的 `a`、`.book-list@li` 的 `li`）
 *      —— 见 `analyze.ts` 的 `selectNodesByKind`；字段规则里 `@title`（线上 95 处）/
 *      `@data-src` 确实是属性名，不能一概而论
 *   2. **列表规则与字段规则**里 `@` 之后那些段的裸词（`.xsm.0@a@text` 的 `a`、
 *      `p.x@tag.span.0@text`）—— 见 `dispatchCssSegments`
 *
 * 不全靠推断是有意的：`data` / `title` / `option` / `span` 这些**既是标签又可能是属性名**，
 * 所以只认这张表里明确写下的名字 —— 表外的一律维持「取值」语义。
 * （代价是 `mio-tile` 这类自定义元素覆盖不到，线上 1 处，已记进 README 的待办。）
 */
const HTML_TAG_NAMES = new Set([
    'a',
    'abbr',
    'address',
    'area',
    'article',
    'aside',
    'audio',
    'b',
    'base',
    'bdi',
    'bdo',
    'blockquote',
    'body',
    'br',
    'button',
    'canvas',
    'caption',
    // `center` / `font` 这类是**过时但真实存在**的标签。表里只收语料要用的：
    // `center` 是 📥爱去小说 的 `#mainDownInfo@center.0@html`（字段规则的中间段），
    // 不收它就走到「兜底当 CSS 片段」，`center.0` 里那个下标就白写了。
    'center',
    'cite',
    'code',
    'col',
    'colgroup',
    'data',
    'dd',
    'del',
    'details',
    'dfn',
    'dialog',
    'div',
    'dl',
    'dt',
    'em',
    'embed',
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
    'head',
    'header',
    'hgroup',
    'hr',
    'html',
    'i',
    'iframe',
    'img',
    'input',
    'ins',
    'kbd',
    'label',
    'legend',
    'li',
    'link',
    'main',
    'map',
    'mark',
    'menu',
    'meta',
    'meter',
    'nav',
    'noscript',
    'object',
    'ol',
    'optgroup',
    'option',
    'output',
    'p',
    'param',
    'picture',
    'pre',
    'progress',
    'q',
    'rp',
    'rt',
    'ruby',
    's',
    'samp',
    'script',
    'section',
    'select',
    'slot',
    'small',
    'source',
    'span',
    'strong',
    'style',
    'sub',
    'summary',
    'sup',
    'svg',
    'table',
    'tbody',
    'td',
    'template',
    'textarea',
    'tfoot',
    'th',
    'thead',
    'time',
    'title',
    'tr',
    'track',
    'u',
    'ul',
    'var',
    'video',
    'wbr',
])

/** 这个裸词是不是 HTML 标签名（大小写不敏感） */
export function isHtmlTagName(name: string): boolean {
    return HTML_TAG_NAMES.has(name.trim().toLowerCase())
}

/**
 * 拆「CSS 式选择器 + JSOUP 下标后缀」：`.book-dir.1` → (`.book-dir`, 第 2 个)
 *
 * 书源会把 JSOUP 的下标写法直接缀在 CSS 选择器后面，线上 46 处：
 * `.section-list.1@li`、`.chapter.1@li@a`、`.row[-1]@a`、`#list dd[12:-1]`；
 * 还有 `!` 那一支（`.txt-list li!0`、`tr!0:-1`、`#chapterlist p!0`）。
 * 下标解析不出来时**原样返回** —— `.book_list2 ul>li>a[href*='.html']` 这种属性选择器
 * 不能被当成位置（`parseIndexExpr` 对非数字给 null，正好用来区分）。
 */
export function splitCssIndex(selector: string): { css: string; index: IndexSpec | null } {
    const t = selector.trim()
    const m = /^(.*?)(?:\.(-?\d+(?::-?[\d%]*)?)|\[([^\]]*)\]|!(-?\d(?:[-:,\d]*\d)?))$/.exec(t)
    if (!m) return { css: t, index: null }
    const head = (m[1] ?? '').trim()
    if (head === '') return { css: t, index: null }
    const index = parseIndexExpr(m[2] ?? m[3] ?? `!${m[4] ?? ''}`)
    return index ? { css: head, index } : { css: t, index: null }
}

/** 把一条 JSOUP 默认规则解析成计划 */
export function parseJsoupRule(rule: string): JsoupPlan {
    let body = rule.trim()
    let reverse = false

    // 规则最前面的 `-` 表示列表倒置，对应「目录是倒着排的」那种站点。
    // 用 `(?!\d)` 把它和「以负数索引开头的规则」区分开：`-class.item` 是倒置，
    // `-1@text` 不是。判断错了会把负索引规则的选择器整个吃掉。
    if (/^-(?!\d)/.test(body)) {
        reverse = true
        body = body.slice(1)
    }

    const segs = body
        .split('@')
        .map((s) => s.trim())
        .filter((s) => s !== '')

    let extract = 'text'
    if (segs.length > 0) {
        const last = segs[segs.length - 1]!
        if (isExtractToken(last)) {
            extract = last
            segs.pop()
        }
    }

    const steps: JsoupStep[] = []
    for (const seg of segs) {
        const step = parseSegment(seg)
        if (step) steps.push(step)
    }

    return { steps, extract, reverse }
}

/**
 * 对一批元素套用位置选择
 *
 * 负数是「从末尾数」：-1 是最后一个。区间两端都是闭区间，
 * `[-1:0]` 会自动变成倒序（start 大于 end 时步长默认取 -1）。
 */
export function applyIndex<T>(items: T[], spec: IndexSpec | null): T[] {
    if (!spec) return items
    const n = items.length
    let out = items

    if (spec.excludes && spec.excludes.length > 0) {
        const drop = new Set(spec.excludes.map((i) => (i < 0 ? n + i : i)))
        out = out.filter((_, i) => !drop.has(i))
    }

    if (spec.picks && spec.picks.length > 0) {
        const picked: T[] = []
        for (const p of spec.picks) {
            if (typeof p === 'number') {
                const i = p < 0 ? n + p : p
                if (i >= 0 && i < n) picked.push(items[i]!)
                continue
            }
            const [s, e, st] = p
            const start = s === null ? 0 : s < 0 ? n + s : s
            const end = e === null ? n - 1 : e < 0 ? n + e : e
            const step = st === null ? (start <= end ? 1 : -1) : st
            if (step === 0) continue
            if (step > 0) {
                for (let i = start; i <= end; i += step) if (i >= 0 && i < n) picked.push(items[i]!)
            } else {
                for (let i = start; i >= end; i += step) if (i >= 0 && i < n) picked.push(items[i]!)
            }
        }
        out = picked
    }

    return out
}
