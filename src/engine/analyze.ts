/**
 * 规则求值入口
 *
 * 把一条 Legado 规则字符串拆成有序的几段，依次求值：
 *
 *   `class.item.0@tag.a@href##^//##https://##@js:result.split(',')[0]`
 *    └──────── 选择器 ────────┘└── 正则链 ──┘└──── JS ────┘
 *
 * 规则语法里几个容易踩的点，这里都按原版语义实现：
 *   - `##` 只能出现在规则**尾部**，从后往前剥，能剥出多条链
 *   - `@js:` 必须放在其它规则**之后**，前面规则的结果以 `result` 传入
 *   - `<js></js>` 可以出现在**中间**，作为分隔符，结果会被重新解析成 HTML 继续往下筛
 *   - `&&` / `||` / `%%` 是同级规则之间的连接符，不是字符
 */

import { applyAllInOne, applyRegexOps, splitRegexChain } from './regex'
import { UnsupportedRuleError, EXTRACT_KINDS, type RuleContext, type RuleResult } from './types'
import {
    applyIndex,
    isHtmlTagName,
    parseJsoupRule,
    splitCssIndex,
    type JsoupPlan,
    type JsoupStep,
} from './jsoup'
import { baseGlobals, sourceLimits } from './globals'
import { extractValues, parseHtml, reparseFragment, selectNodes } from './select'
import { jsonPathToStrings, queryJsonPath } from './jsonpath'
import { runInSandbox, sandboxResultToString, sandboxResultToStrings } from './js'
import type { SandboxGetElements, SandboxGetString, SandboxLimits } from './js'
import {
    classifyTemplate,
    hasRuleSyntax,
    hasTemplate,
    skeletonOf,
    stripRuleMarker,
    templateBody,
    templatePattern,
} from './template'
import { splitJsTail, splitRuleText } from './ruleText'
import {
    asGetSegment,
    findGetDirectives,
    readInfoVar,
    splitPutDirectives,
    writeInfoVar,
    type PutPair,
} from './infoVars'
import { matchDirective, ruleHasJs } from './directives'
import {
    RESULT_AS_JSOUP,
    resultWantsArray,
    resultWantsString,
    usesJsoupOnResult,
    wantsJsoupResult,
} from './resultShape'
import { isAttributeView, normalizeXPathFunctions, runXPath, splitXPathExtract } from './xpath'

/** 一次规则求值所面对的上下文：一个可继续筛选的节点集 */
export interface Selection {
    $: ReturnType<typeof parseHtml>
    nodes: any[]
    /** 源码原文，供 @js 的 src 与 JSONPath 使用 */
    source: string
}

/** 规则用了本引擎尚未实现的能力时抛这个，好让上层把「不支持」和「没匹配到」区分开 */
export { UnsupportedRuleError }

export function rootSelection(source: string): Selection {
    const $ = parseHtml(source)
    return { $, nodes: $.root().toArray(), source }
}

/** 从一段文本构造 Selection：像 HTML 就按 HTML 解析，否则当作纯文本 */
function selectionFromText(text: string, source: string): Selection {
    const trimmed = text.trim()
    if (/<[a-zA-Z!/]/.test(trimmed)) {
        const { $, nodes } = reparseFragment(trimmed)
        return { $, nodes, source }
    }
    // 纯文本：包一层再解析，这样 `text` 取值能拿到原文，属性取值自然为空
    const $ = parseHtml(`<div>${trimmed.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`)
    return { $, nodes: $.root().find('div').toArray(), source }
}

/**
 * 拆同级连接符；返回 null 表示没有连接符
 *
 * 跳过 JS 区域（`@js:` 代码、`<js>` 块）、方括号与引号 —— 详见 `ruleText.ts`。
 * 不跳过的话规则会被从中间切开，每一块看起来都「合法」，只是结果全不对；
 * 更糟的是**报错信息会指向切开后的半截规则**（例如 JS 语法错误 `expecting ','`），
 * 而真正的问题在别处。
 */
function splitConnectors(rule: string): { parts: string[]; joiner: '&&' | '||' | '%%' } | null {
    for (const joiner of ['&&', '||', '%%'] as const) {
        const parts = splitRuleText(rule, joiner)
        if (parts) return { parts, joiner }
    }
    return null
}

/** 把选择器部分拆成 [选择器, JS, 选择器, JS, ...]，对应 `<js></js>` 分隔 */
function splitJsBlocks(rule: string): Array<{ kind: 'selector' | 'js'; text: string }> {
    const parts: Array<{ kind: 'selector' | 'js'; text: string }> = []
    // `i` 和 `ruleText.ts` / `urlJs.ts` 里的同类匹配保持一致 ——
    // 那两处的 `JS_BLOCK` 早就带了 `i`，这里漏掉就会自相矛盾：切连接符时把 `<JS>` 当成
    // JS 区域跳过去、拆分这一步却不认它，于是整块被当选择器、JS 一次都不跑（而且不报错）。
    // （线上 392 处 `<js>` 里没有出现过 `<JS>`，但不值得为此留一个只在大小写上打架的分支）
    const re = /<js>([\s\S]*?)<\/js>/gi
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(rule)) !== null) {
        if (m.index > last) parts.push({ kind: 'selector', text: rule.slice(last, m.index) })
        parts.push({ kind: 'js', text: m[1] ?? '' })
        last = re.lastIndex
    }
    if (last < rule.length) parts.push({ kind: 'selector', text: rule.slice(last) })
    // 只做 trim：不能顺手把开头的 `@` 去掉，那会毁掉 `@css:` / `@json:` / `@XPath:`
    // 这些前缀（它们本身就是以 `@` 开头的）。多出来的裸 `@` 由下游按空段过滤掉。
    return parts.map((p) => (p.kind === 'selector' ? { kind: p.kind, text: p.text.trim() } : p))
}

/**
 * 判断这条规则该用哪种选择器
 *
 * 导出只为**能被单测逐条钉住**（判错的后果是静默走错解析器，见 test/ruleKind.test.ts）。
 */
export function detectKind(rule: string): {
    kind: 'css' | 'jsoup' | 'json' | 'xpath' | 'allinone'
    body: string
} {
    const t = rule.trim()
    // 前缀**不区分大小写**：`@CSS:` / `@JSon:` / `@Json:` 在真实书源里都有
    // （线上 61 处规则开头），早先只认全小写，于是这些规则静默返回空 —— 详见 directives.ts
    const directive = matchDirective(t)
    if (directive) {
        if (directive.name === 'css') return { kind: 'css', body: directive.body }
        if (directive.name === 'xpath') return { kind: 'xpath', body: directive.body }
        if (directive.name === 'json') return { kind: 'json', body: directive.body }
        // `@js:` 刻意在这一层不分派：让它继续落到 JSOUP 上，由调用方那条 JS 分支处理
        // （见 evaluateSelectorChain 里 isJsRule 的说明）。这里只是把结果写明白，
        // 免得读代码的人以为 `@js:` 是被漏掉的
        return { kind: 'jsoup', body: t }
    }
    if (t.startsWith('//') || t.startsWith('(/')) return { kind: 'xpath', body: t }
    // `$[` 与 `$.` 都是 JSONPath：`$[*]`（根数组通配）、`$[:10]`（前 10 个）在语言里
    // 与 `$.a[*]` 地位相同。只认 `$.` 的话它们会被当成 **CSS** 去 cheerio 里找一个叫
    // `$[*]` 的元素 —— 静默 0 条。线上这一类共 4 源 5 处，全都长在 `<js>` 块之后
    // （`<js>JSON.stringify(list)</js>` + `$[*]`），正好是「JS 段 + JSONPath 尾段」的形状
    if (t.startsWith('$.') || t.startsWith('$[')) return { kind: 'json', body: t }
    // AllInOne：整块正则切分，只用于列表规则
    if (t.startsWith(':') && t.length > 1) return { kind: 'allinone', body: t }
    // 裸 CSS 选择器 —— 真实书源里非常常见：`.searchbook`、`h3.title@text`、
    // `div#content@textNodes`、`div.item a@href`。它们既不是 JSOUP 简写
    // （那要求写成 `class.searchbook` / `tag.a`），也没带 `@css:` 前缀。
    //
    // 不单独认出来的话，它们会被 JSOUP 解析器**静默**解成完全不同的东西：
    // 开头的 `.` 被当成「取所有子节点」、`div#content` 解析出空步骤（等于整页）。
    // 后果是「搜到书了，但书籍链接是整页导航的拼接」，全程不报任何错 ——
    // 真实书源里一眼就能看出来：bookUrl 变成了一长串 /list.html/Ranking.html/wanben.html…
    if (!isJsoupShorthand(t)) return { kind: 'css', body: t }
    return { kind: 'jsoup', body: t }
}

/**
 * 判断规则的选择器部分是不是 JSOUP 简写。**不是就按 CSS 处理。**
 *
 * 用「正向确认 JSOUP」而不是「找 CSS 的特征」：CSS 的写法是开放集合
 * （`.x`、`div#id`、`h3.title`、`div.item a`、`a:has(h3)` …），
 * 想靠几个特征把它们全认出来必然漏，而 JSOUP 简写是封闭的几种形态，
 * 反过来认才可靠。漏判的代价是静默返回垃圾数据，误判的代价只是这条规则不生效。
 */
function isJsoupShorthand(rule: string): boolean {
    const selector = (rule.split('@')[0] ?? '').trim()

    // 空串、或以 @ 开头的指令/残留修饰符：维持原有路径交给 JSOUP，别当 CSS
    if (selector === '' || selector.startsWith('@')) return true

    // class.x / id.x / tag.x / text.x（按文字找元素）/ children，可带 `-` 反向前缀
    if (/^-?(?:class|id|tag|text|children)(?:\.|$)/.test(selector)) return true

    // 裸标签名，可带位置下标：`a`、`a.0`、`a[0]`、以及 `dd.2:3`（点号后面再跟 `:N`，
    // 线上 📂阳光小说 的 kind —— 以前这里不认，整条规则被当成 CSS 去解析，
    // 报出来的是「CSS 选择器无效」，方向完全指错）
    return /^[A-Za-z][\w:-]*(?:\.-?\d+(?::-?[\d%]*)?|\[[^\]]*\])?$/.test(selector)
}

/** 拆分 `@css:` 规则里的选择器与取值：`@css:div.item a@href` → (`div.item a`, `href`) */
function splitCssExtract(body: string): { css: string; extract: string } {
    // CSS 选择器本身几乎不会含 `@`，所以用最后一个 `@` 判断是否带取值后缀
    const at = body.lastIndexOf('@')
    if (at > 0 && /^[A-Za-z_][\w-]*$/.test(body.slice(at + 1))) {
        return { css: body.slice(0, at), extract: body.slice(at + 1) }
    }
    return { css: body, extract: 'text' }
}

/**
 * 用 CSS 选择器在当前节点集的后代里找节点
 *
 * 选择器**非法时报错而不是返回空**：这两者在下游看起来几乎一样，
 * 但原因完全不同 —— 前者是规则写错了（拿去修就好），后者是页面里确实没有。
 * 早先这里静默咽掉异常，结果是一整条源「分类正常、书目全空、全程不报错」，
 * 排查时只能靠猜。报出来的信息里带上选择器原文，指向就明确了。
 */
function selectByCss(sel: Selection, css: string): any[] {
    if (css.trim() === '') return []
    const nodes: any[] = []
    let failed = false
    for (const n of sel.nodes) {
        try {
            nodes.push(...sel.$(n).find(css).toArray())
        } catch {
            failed = true
        }
    }
    if (failed && nodes.length === 0) {
        throw new UnsupportedRuleError(`CSS 选择器无效，无法解析：${css.slice(0, 120)}`)
    }
    return nodes
}

/** 当前内容是不是一个 JSON 对象/数组（而不是 HTML） */
function isJsonContent(source: string): boolean {
    const trimmed = source.trim()
    // 先看首字符，避免把每一条 HTML 规则都拖进 JSON.parse
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
    try {
        const parsed: unknown = JSON.parse(trimmed)
        return typeof parsed === 'object' && parsed !== null
    } catch {
        return false
    }
}

/**
 * 把「裸字段名」当成 JSON 字段
 *
 * 真实接口型书源里这是常规写法：喜马拉雅的章节名就是 `title`、章节地址就是
 * `playPathAacv224||playPathAacv164||playUrl64||playUrl32`，前面都不带 `$.`。
 *
 * 不这么认的话，`title` 会走 CSS 选择器去找 `<title>` 标签 —— 而当前内容是一段 JSON，
 * 于是**一个章节都取不到**，整个目录变成空的，还不报任何错。
 *
 * 只在「规则是纯标识符」且「当前内容确实是 JSON」时才这么认：否则 `a`、`div`、`title`
 * 很可能是正常的 HTML 标签选择器，不能乱改语义。
 */
function bareJsonField(rule: string, source: string): string | null {
    const t = rule.trim()
    if (!/^[A-Za-z_][\w-]*$/.test(t)) return null
    if (!isJsonContent(source)) return null
    return `$.${t}`
}

/**
 * 把 `//x` 改写成 `.//x`
 *
 * XPath 里 `//x` 是「从文档根往下找」，但书源里它始终表示**从当前节点往下找**：
 * 字段规则是跑在搜索结果的某一个条目上的，若真按文档根解释，就会抓到整页里
 * 第一个匹配的 `<a>`，而不是这一条里的那个 —— 数据看起来"有"，但全串了行。
 *
 * `//x` 展开就是 `/descendant-or-self::node()/child::x`，前面加 `.` 变成 `.//x`，
 * 即「以当前节点为起点往下找」。作用在文档根上时两者等价，所以这一改写
 * 同时满足「整页规则」和「条目内规则」两种场景。
 *
 * 不以 `//` 开头的表达式（`string(...)`、`count(...)`、`/html/body/...`）
 * 本身就是文档级的，保持原样。
 */
function toRelativeXPath(body: string): string {
    return body.startsWith('//') ? `.${body}` : body
}

/**
 * 规则里的 XPath 段 → 可以直接交给 `xpath` 包执行的表达式（外加取值后缀）
 *
 * 三步，顺序不能换：
 *   1. `splitXPathExtract` 拆掉末尾的取值后缀（`div[3]@html` 的 `@html`）
 *   2. `normalizeXPathFunctions` 去掉函数名与 `(` 之间的空白（`contains (` → `contains(`）
 *   3. `toRelativeXPath` 把 `//x` 改写成 `.//x`
 *
 * 两处调用（字段求值、列表规则）都走它，免得哪一处漏了某一步 ——
 * 漏掉的后果不是报错，而是「表达式解析失败 → 整条规则空」。
 */
function toRunnableXPath(rule: string): { expression: string; extract: string | null } {
    const { expression, extract } = splitXPathExtract(rule)
    return { expression: toRelativeXPath(normalizeXPathFunctions(expression)), extract }
}

/**
 * 取一个 XPath 结果节点的值
 *
 * XPath 与 JSOUP 规则不同：**取什么由表达式自己决定**（`/text()` 给文本节点、
 * `/@href` 给属性节点、选中元素则取它的文本），所以**没有后缀时**用不到
 * `@text` / `@href` 那套取值后缀 —— 这一点与 CSS 差别很大。
 *
 * 但书源里确实有「表达式 + 取值后缀」的写法（线上 3 处，如 `div[3]@html`），
 * 那一层由 `splitXPathExtract` 先拆掉（见那里的判据），这里只处理剩下的节点。
 */
function xpathNodeValue($: Selection['$'], node: any): string {
    if (isAttributeView(node)) return node.value.trim()
    if (node?.type === 'text') return String(node.data ?? '').trim()
    if (!node || typeof node !== 'object') return ''
    return $(node).text().trim()
}

/** 一个 XPath 命中节点在带取值后缀时该取什么 */
function xpathValueWithExtract($: Selection['$'], node: any, extract: string): string {
    // 后缀只对元素有意义（`@html` 取内部 HTML、`@href` 取属性、`@text` 取文本）。
    // 表达式若返回的是属性/文本节点，就仍按它自己的值取 —— 那说明后缀是多余的
    if (!node || typeof node !== 'object' || isAttributeView(node) || node.type === 'text') {
        return xpathNodeValue($, node)
    }
    return extractValues($, [node], extract)[0] ?? ''
}

/**
 * 字段规则里的 **CSS 式规则**：`首段@步骤…@取值`
 *
 * 以前这里只切**最后一个** `@`（`splitCssExtract`），把剩下的整段当 CSS 交给 cheerio。
 * 于是 `.xsm.0@a@text` 会变成 `selectByCss('.xsm.0@a')` —— cheerio 对非法选择器
 * **不报错、只是返回空**，症状是「书名 / 作者 / 分类整列空着，而搜索本身是成功的」。
 * 线上字段规则里这类「中间还有段」的共 **746 处 / 221 个源**：
 * `.xsm.0@a@text`、`.datainfobox@p.-2@a@text`、`.catalog@.clearfix@li.-1@a@text` …
 *
 * 末段是不是「取值」沿用 `splitCssExtract` 的判据（`属性名` 形状的裸词才算）：
 * `text` / `href` / `textNodes` / `data-id` 都还是取值 —— `.one@data-id` 这类一个字没动。
 * 中间那些段与列表规则**共用** `dispatchCssSegments`（能当步骤的当步骤、能当 CSS 片段的
 * 拼回首段），所以 `.cover@.line`、`#chapterlist@li a` 在两条路上是同一套语义。
 */
function evalCssField(sel: Selection, body: string): string[] {
    let rest = body.trim()
    // 前导 `-`（倒置）与列表规则同一套语义：`-` 后面不是数字才算倒置标记
    let reversed = false
    if (rest.startsWith('-') && !/^-\d/.test(rest)) {
        reversed = true
        rest = rest.slice(1)
    }

    const segs = rest.split('@').map((s) => s.trim())
    let extract = 'text'
    const last = segs[segs.length - 1] ?? ''
    if (segs.length >= 2 && /^[A-Za-z_][\w-]*$/.test(last)) {
        extract = last
        segs.pop()
    }

    const headRaw = segs.shift() ?? ''
    const { headParts, steps } = dispatchCssSegments(segs)

    let head = splitCssIndex(headRaw)
    if (headParts.length > 0) head = splitCssIndex([head.css, ...headParts].join(' '))

    let nodes = selectByCss(sel, head.css)
    if (head.index) nodes = applyIndex(nodes, head.index)
    if (steps.length > 0) nodes = selectNodes(sel.$, nodes, steps)

    const values = extractValues(sel.$, nodes, extract)
    return reversed ? values.reverse() : values
}

/** 在一段**文本**上跑 JSONPath（不是节点上）。解析不了就当作没命中 */
function evalJsonText(text: string, body: string): string[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return []
    }
    return jsonPathToStrings(parsed, body)
}

/** 在给定节点集上跑一条「纯选择器」规则，返回字符串列表 */
function evalSelector(sel: Selection, body: string, kind: string): string[] {
    if (kind === 'json') return evalJsonText(sel.source, body)

    if (kind === 'xpath') {
        const { expression, extract } = toRunnableXPath(body)
        const values: string[] = []
        for (const node of sel.nodes) {
            const outcome = runXPath(sel.$, expression, node)
            if (outcome.kind === 'scalar') {
                if (outcome.value !== '') values.push(outcome.value)
                continue
            }
            for (const hit of outcome.nodes) {
                const value =
                    extract === null
                        ? xpathNodeValue(sel.$, hit)
                        : xpathValueWithExtract(sel.$, hit, extract)
                if (value !== '') values.push(value)
            }
        }
        return values
    }

    if (kind === 'css') return evalCssField(sel, body)

    const plan = parseJsoupRule(body)
    const nodes = selectNodes(sel.$, sel.nodes, plan.steps)
    const values = extractValues(sel.$, nodes, plan.extract)
    return plan.reverse ? values.reverse() : values
}

/**
 * 求值一个 `{{...}}` 里的内容
 *
 * 这里是 `{{}}` 与 `searchUrl` 模板（`source.ts` 的 resolveTemplate）的区别：
 * URL 模板里只可能是 JS 变量，而字段规则模板里**两种都可能是**。
 */
async function evalTemplate(sel: Selection, inner: string, ctx: RuleContext): Promise<string> {
    const text = stripRuleMarker(inner.trim())
    if (text === '') return ''

    if (classifyTemplate(text) === 'js') {
        try {
            const value = await runInSandbox(
                text,
                { ...baseGlobals(ctx), ...sourceResultGlobals(text, sel.source), src: sel.source },
                sandboxLimits(sel, ctx),
            )
            return sandboxResultToString(value)
        } catch {
            // 模板里常用的 `java.timeFormat` / `java.getString` 这类助手我们还没实现。
            // 这里**只让这一小段变空**，而不是让整个字段报错 ——
            // 一个展示用的标签取不到，不该导致整本书的详情页打不开。
            // 缺哪些助手记在 README 的「已知缺口」里。
            return ''
        }
    }

    const values = await analyzeStrings(sel, text, ctx)
    return values.filter((v) => v !== '').join('\n')
}

/**
 * 展开规则里的 `{{...}}`
 *
 * 同时返回一份**骨架**：把每个 `{{...}}` 换成空串之后的规则。
 * 骨架用来判断「展开结果还该不该当规则求值」—— 不能拿展开结果本身去判断，
 * 因为值里可能正好含 `@`（简介里有个邮箱就够了），那样会把纯文本误当成规则。
 */
async function expandTemplates(
    sel: Selection,
    rule: string,
    ctx: RuleContext,
): Promise<{ expanded: string; skeleton: string }> {
    let expanded = ''
    let skeleton = ''
    let last = 0

    // 每次新建正则：带 lastIndex 的全局正则在并发请求之间会互相踩
    const pattern = templatePattern()
    let match: RegExpExecArray | null
    while ((match = pattern.exec(rule)) !== null) {
        const plain = rule.slice(last, match.index)
        expanded += plain
        skeleton += plain
        expanded += await evalTemplate(sel, templateBody(match), ctx)
        last = match.index + match[0].length
    }
    const tail = rule.slice(last)
    expanded += tail
    skeleton += tail

    return {
        expanded: substituteGetVars(expanded, ctx, false),
        skeleton: substituteGetVars(skeleton, ctx, true),
    }
}

/**
 * 把嵌在文字里的 `@get:{键}` 换成变量的值（骨架那一路换成空串）
 *
 * 两件事必须同时成立，所以和模板走同一套「展开 + 骨架」机制：
 *   - `编号：@get:{bookid}`、`...&bid=@get:{bid}&order=0` → 展开后是**字面文本**，
 *     直接当结果（骨架里没有规则语法 → `evalRule` 走字面那条分支）
 *   - 规则**开头**那一个**不换**：交给求值那侧的「段」分支，它才能当后续
 *     `@js:` / `<js>` 的输入（`@get:{img}@js:…`、`@get:{d}\n<js>…</js>\na@href`）
 *
 * 不换的话，`...&bid=@get:{bid}&order=0` 会被整段当成 CSS 选择器，**静默取空**。
 */
function substituteGetVars(text: string, ctx: RuleContext, blank: boolean): string {
    const hits = findGetDirectives(text)
    if (hits.length === 0) return text
    let out = ''
    let last = 0
    for (const hit of hits) {
        out += text.slice(last, hit.start)
        const isLeading = text.slice(0, hit.start).trim().replace(/^@+/, '') === ''
        out += isLeading ? text.slice(hit.start, hit.end) : blank ? '' : readInfoVar(ctx, hit.key)
        last = hit.end
    }
    return out + text.slice(last)
}

/**
 * 规则求值：返回字符串列表
 *
 * `skeleton` 是去掉模板内容之后的骨架，`null` 表示这条规则里没有模板。
 * 只为 `null` 与「有模板」两种情况服务，不参与其它判断。
 */
export async function analyzeStrings(
    sel: Selection,
    rule: string,
    ctx: RuleContext,
): Promise<string[]> {
    // `@put:{...}` 先摘下来：它只是副作用（写变量），摘完的规则才继续照常求值。
    // 摘的顺序很要紧 —— 留着它会被当成规则语法，整条规则静默取空。
    const put = splitPutDirectives(rule)
    if (put.puts.length > 0) await applyPutDirectives(sel, put.puts, ctx)

    const trimmed = put.rule.trim()
    if (trimmed === '') return []

    // 三种模板形态都要走「有模板」这条路（`{{...}}`、单花括号的 `{$.路径}`、
    // 以及文字里嵌着的 `@get:{键}`）：只用 `includes('{{')` 判断的话，
    // `/pc/book/{$.id}/catalog` 与 `...&bid=@get:{bid}` 都会被当纯选择器求值，
    // 结果是**静默取空**
    if (!hasTemplate(trimmed) && !trimmed.includes('get:')) {
        return evalRule(sel, trimmed, null, ctx)
    }

    // 模板先展开：`{{}}` 里可能有 `||`、`##`，先展开才不会把它们当成分隔符
    // 把规则切碎（`{{$.a||$.b}}`、`{{$.desc##x##y}}` 都是真实写法）
    const { expanded, skeleton } = await expandTemplates(sel, trimmed, ctx)
    return evalRule(sel, expanded, skeleton, ctx)
}

/**
 * 求值 `@put:{...}` 里的每一条值规则，写进变量表
 *
 * 表与 `java.put` / `java.get(key)` **共用**（见 `infoVars.ts` 的说明）：
 * 书源里「`init` 里 `<js>` 先 `java.put`、字段规则再 `@get:{键}`」的写法靠的就是这一点。
 */
async function applyPutDirectives(
    sel: Selection,
    puts: PutPair[],
    ctx: RuleContext,
): Promise<void> {
    for (const pair of puts) {
        const values = await analyzeStrings(sel, pair.rule, ctx)
        writeInfoVar(ctx, pair.key, values.filter((v) => v !== '').join('\n'))
    }
}

/**
 * 这条规则的**取值方式是不是默认的** —— 即它如今给的是文本 / 属性值，而不是节点自带的 HTML
 *
 * 用来判断「脚本按 jsoup 用 `result` 时该不该改绑节点」：默认取值下，`result`
 * 拿到的是**文本**（JSOUP 简写的默认取值就是 `text`）或**名为空串的属性**
 * （裸 CSS 没有 `@` 时的那条路径恒为空串），拿它当 HTML 解析自然什么都选不出来。
 *
 * 三种方言各有一个「没写取值」的形态，实现里都落成 `text`（XPath 是 `null`）：
 *   - `@css:`    → `splitCssExtract` 没有 `@` 后缀时返回 `text`
 *   - XPath      → `toRunnableXPath` 没有后缀时返回 `null`
 *   - JSOUP 简写 → `parseJsoupRule` 的默认值就是 `text`
 *
 * 显式写 `@text` 与不写在这里**不做区分**：`text` 是默认取值，而「显式要文本、
 * 又要 `result.select(…)`」本身就是自相矛盾的写法。
 *
 * 反过来，规则自己写了 `@html` / `@outerHtml` / `@all` 时返回 `false`：
 * 那已经是一份 HTML 了，脚本在那上面 `select` 是说得通的，**不动它**。
 */
function hasDefaultExtract(rule: string): boolean {
    const { selector } = splitRegexChain(rule)
    const head = selector.trim()
    if (head === '') return false
    const directive = matchDirective(head)
    if (directive) {
        if (directive.name === 'css') return splitCssExtract(directive.body).extract === 'text'
        if (directive.name === 'xpath') return toRunnableXPath(directive.body).extract === null
        // json / js / allinone 都给不出节点
        return false
    }
    if (head.startsWith('//') || head.startsWith('(/')) {
        return toRunnableXPath(head).extract === null
    }
    if (head.startsWith('$.') || head.startsWith(':')) return false
    if (/<js[\s>]/i.test(head)) return false
    return parseJsoupRule(head).extract === 'text'
}

/**
 * 脚本按 jsoup 用 `result` 时，把**命中到的节点本身的 HTML**交给它
 *
 * 不能拿「按取值方式抠出来的字符串」当输入：裸 CSS 的默认取值是
 * 「名为空串的属性」（恒为空串）、JSOUP 简写的默认取值是 `text`。于是
 * `⚡📂八一中文网` 的 `#sitebox dl@js:result.size()` 会算出 0 个元素、
 * `🔞西瓜书屋` 的 `.BCsectionTwo-top li a@js:result.forEach(e => e.attr('href'))`
 * 里每个 `e` 都是纯文本（`attr` 恒为空串）、`🔞紫云宫` 的
 * `ol li@js:result.select('a')` 一个 `a` 都选不出来。
 *
 * Legado 那边 `result` 绑的本来就是 `Elements`（节点集合），所以绑节点是
 * **语义对齐**，不是权宜之计。命中数不同、下游形态也不同（见 `resultGlobals`）：
 * 命中 1 个绑成一份 HTML 字符串、命中多个绑成数组。
 */
async function nodeHtmlOrValues(
    sel: Selection,
    rule: string,
    skeleton: string | null,
    ctx: RuleContext,
): Promise<string[]> {
    const items = await analyzeSelections(sel, rule, ctx)
    const htmls = items.map((item) =>
        item.nodes[0] ? (item.$.html(item.nodes[0]) ?? '') : item.source,
    )
    // 一个节点都没命中时回到既有那条路（它给的是空数组，与这里的空结果一致）
    if (htmls.length === 0) {
        return evalRule(sel, rule, skeleton === null ? null : skeletonOf(rule), ctx)
    }
    return htmls
}

/**
 * 连接符、`@js:` 尾巴与正则链的解析；`skeleton` 与 `rule` 结构对应
 *
 * 拆分顺序是**连接符 → `@js:` → `##` 链**，这个顺序本身有语义：
 *   - 连接符要最先切，`||` / `&&` / `%%` 是同级规则之间的关系，且 JS 区域里的不算；
 *   - `@js:` 必须排在 `##` 链**之前**：它是一条分界线，两边的链各归各自那一侧。
 *     反过来先切 `##` 链，`选择器##过滤##@js:代码` 里的脚本就会被当成替换串的一部分、
 *     一次都不执行（而且不报错）—— 见 `ruleText.ts` 的 `splitJsTail`。
 */
async function evalRule(
    sel: Selection,
    rule: string,
    skeleton: string | null,
    ctx: RuleContext,
): Promise<string[]> {
    // 同级连接符优先：`a||b` 两块是并列关系，各自独立求值
    const connectors = splitConnectors(rule)
    if (connectors) {
        const skeletonParts = skeleton === null ? null : (splitConnectors(skeleton)?.parts ?? null)
        const results: string[][] = []
        for (let i = 0; i < connectors.parts.length; i += 1) {
            const part = connectors.parts[i]!
            // 连接符本身来自模板里展开出来的值时，骨架对不上，退回「有模板」的保守判断
            const partSkeleton = skeletonParts?.[i] ?? skeleton
            results.push(await evalRule(sel, part, partSkeleton, ctx))
        }
        switch (connectors.joiner) {
            case '&&':
                // 合并所有取到的值
                return results.flat()
            case '||':
                // 取第一个有值的
                return results.find((r) => r.length > 0) ?? []
            case '%%': {
                // 依次取数：第 1 个列表取第 1 个，第 2 个列表取第 1 个……再回头取第 2 轮
                const out: string[] = []
                const max = Math.max(...results.map((r) => r.length), 0)
                for (let i = 0; i < max; i++) {
                    for (const r of results) if (r[i] !== undefined) out.push(r[i]!)
                }
                return out
            }
        }
    }

    const jsTail = splitJsTail(rule)
    if (jsTail) {
        /**
         * 整条规则以 `@js:` 开头（前面没有选择器）时，`result` 是**页面原文** ——
         * 只有一份，不存在「绑数组」那回事，所以走 `sourceResultGlobals`。
         *
         * 真实书源里这是常规写法：天脉漫画的正文就是
         * `@js:var start = result.indexOf('id="cp_img"')…`；`result` 若是空串，
         * 规则会「执行成功但什么都取不到」，喜马拉雅的目录规则更直接：
         * 对空串 `JSON.parse` 就地报错。
         */
        const bareJs = jsTail.before.trim() === ''
        const source = ctx.result ?? sel.source

        /**
         * 前置那一段照旧求值：它可能是「选择器 + 自己的链」，也可能就是空的。
         * 递归进来时 `@js:` 已经被切走了（`splitJsTail` 取的是**第一个**标记），不会转圈
         *
         * 这里给的是 **HTML 还是文本**，判据是 `usesJsoupOnResult`（不看有没有同时按字符串用）：
         * 脚本既然调了 `attr` / `select` / `toArray`，`result` 里就必须有标记 ——
         * 只给文本的话 `toArray()` 会得到一个**空数组**（不报错，只是东西没了），
         * 而海马书屋那类源正是拿 `toArray()` 的结果去 `attr('data-id')` 排序。
         * `result` 最终绑成数组还是字符串由 `resultGlobals` 另判（字符串优先）。
         */
        const values = bareJs
            ? []
            : hasDefaultExtract(jsTail.before) && usesJsoupOnResult(jsTail.code)
              ? await nodeHtmlOrValues(sel, jsTail.before, skeleton, ctx)
              : await evalRule(
                    sel,
                    jsTail.before,
                    skeleton === null ? null : skeletonOf(jsTail.before),
                    ctx,
                )

        const produced = await runInSandbox(
            jsTail.code,
            {
                ...baseGlobals(ctx),
                ...(bareJs
                    ? sourceResultGlobals(jsTail.code, source)
                    : resultGlobals(jsTail.code, values)),
                src: sel.source,
            },
            sandboxLimits(sel, ctx),
        )
        const out = sandboxResultToStrings(produced)

        // 代码之后还有一条链（`选择器@js:代码##正则##替换`）：它作用在脚本的**输出**上
        if (jsTail.after === '') return out
        const afterOps = splitRegexChain(`x${jsTail.after}`).ops
        return afterOps.length ? out.map((v) => applyRegexOps(v, afterOps)) : out
    }

    const { selector, ops } = splitRegexChain(rule)
    const skeletonSelector = skeleton === null ? null : splitRegexChain(skeleton).selector

    let values: string[]
    if (skeletonSelector !== null && !hasRuleSyntax(skeletonSelector)) {
        // 展开之后是字面文本（`"/api/tracks/{{$.id}}"` 这类），直接当结果
        values = selector.trim() === '' ? [] : [selector]
    } else if (selector.trim() === '' && ops[ops.length - 1]?.onlyOne === true) {
        /**
         * **空选择器 + 取值链（`###`）= 从当前原文里取**。规则直接以 `##正则##$1###`
         * 开头，就是从整页里抠一个字段：
         *
         *   `🔞PO18文学 / ruleBookInfo.wordCount`  →  `##总字数：([^<]+)<##$1###`
         *   `⚡📂未来天王 / ruleBookInfo.name`      →  `##:book_name"[^"]+"([^"]*)##$1###`
         *
         * 线上 55 处这么写（⚡📂未来天王 六个字段、🔞PO18文学、📂被电子书、🎈腐小说、
         * 📂笔下文学 的 nextTocUrl …）。之前这一步落到空数组上，这些字段**一律取不到值**，
         * 而且不报错。取的是与 AllInOne（`applyAllInOne(sel.source, …)`）、顶格 `@js:`
         * （`sourceResultGlobals`）同一份**页面原文**。
         *
         * 只对**取值**链成立：`##正则##替换`（净化）要的是一个「被净化的值」，
         * 空选择器给不出来 —— 那就什么都不取（`📂天地中文` 的
         * `text||##最新章节.*` 这种 `||` 兜底分支，今天就该是空的，不能变成整页）。
         */
        values = [sel.source]
    } else if (selector.trim() === '') {
        values = []
    } else {
        values = await evalSelectorChain(sel, selector, ctx)
    }

    return ops.length ? values.map((v) => applyRegexOps(v, ops)) : values
}

/** 处理 `<js></js>` 链（`@js:` 尾巴在 `evalRule` 那一层就切走了，这里不再有） */
async function evalSelectorChain(
    sel: Selection,
    selector: string,
    ctx: RuleContext,
): Promise<string[]> {
    const jsBlocks = splitJsBlocks(selector)

    // 没有 <js> 时走单段路径（绝大多数规则走这里）
    if (jsBlocks.length === 1 && jsBlocks[0]!.kind === 'selector') {
        return evalSingleSegment(sel, jsBlocks[0]!.text, ctx)
    }

    let current: Selection = sel
    let values: string[] = []
    /** 前面有没有跑过选择器 —— 决定首个 `<js>` 块里的 `result` 是「页面原文」还是「空」 */
    let sawSelector = false
    /**
     * **上一段产出的文本**。跟在后面的 JSONPath 段（`$.路径` / `$[*]`）要作用在它上面，
     * 而不是页面原文 —— 这与 HTML 尾段那条路（`trailingNodeSelector`）是同一条纪律：
     * Legado 的 `getElements(ruleStr)` 按段分发，`<js>` 段的输出就是下一段的输入。
     *
     * 线上 `</js>` 后面直接跟 `$` 路径的共 **58 处**，绝大多数脚本会把结果**换掉**
     * （`🔞书耽` 的 `decode(result)`、`⚡📂灯读文学` 的 `java.ajax(result)`、
     * `🔞Jk小说` 的解密），只有少数是原样透传（`⚡📂笔趣全家桶` 的
     * `result.replace(/<!--gg-->/, "")`）。以前这里用的是页面原文，于是那些
     * 「脚本换过内容」的源一律**静默取空**。
     *
     * 注意它**只喂给 JSONPath**：`<js>` 块里的 `src` 仍旧用 `current.source`
     * （页面原文）—— `📂小米书城` 的正文规则正是 `result` 取链接、`src` 取整页。
     */
    let content = sel.source

    for (let index = 0; index < jsBlocks.length; index += 1) {
        const part = jsBlocks[index]!
        if (part.kind === 'selector') {
            if (part.text === '') continue
            sawSelector = true
            const kind = detectKind(part.text)
            /**
             * 后面紧跟一个「把 `result` 当节点用」的 `<js>` 块时，这一段要给 **HTML**
             *
             * 判据与 `evalRule` 里那条一样是 `usesJsoupOnResult`（不看有没有同时按字符串用）：
             * 脚本调了 `attr` / `select` / `toArray`，`result` 里就必须有标记。
             * 线上最典型的是 6 条「海马书屋」形状的目录规则：
             * `class.BCsectionTwo-top-chapter@li\n<js>list = result.toArray(); …</js>\ntag.a`
             * —— 脚本要拿 `list[i].attr('data-id')` 排序，而默认那条路给的是**文本**，
             * `toArray()` 于是解析出一堆没有标记的东西，得到**空数组**（不报错，只是目录空了）。
             */
            const next = jsBlocks[index + 1]
            const wantHtml =
                kind.kind !== 'allinone' &&
                next !== undefined &&
                next.kind === 'js' &&
                next.text.trim() !== '' &&
                usesJsoupOnResult(next.text)
            if (kind.kind === 'allinone') {
                values = applyAllInOne(current.source, part.text)
                current = selectionFromText(values.join('\n'), current.source)
            } else if (kind.kind === 'json') {
                // JSONPath 段：作用在**上一段输出**上（`content`），不是页面原文
                values = evalJsonText(content, kind.body)
                current = selectionFromText(values.join('\n'), current.source)
            } else if (wantHtml) {
                values = await nodeHtmlOrValues(current, part.text, null, ctx)
                current = selectionFromText(values.join('\n'), current.source)
            } else {
                values = evalSelector(current, kind.body, kind.kind)
                // 中间结果要能被后续规则继续筛选，所以重新解析成节点
                current = selectionFromText(values.join('\n'), current.source)
            }
            content = values.join('\n')
            continue
        }

        // 空的 <js></js> 只是一个分隔符，表示「把上面的结果重新解析继续筛」
        if (part.text.trim() === '') continue

        /**
         * **顶格 `<js>` 块里的 `result` 是页面原文**，与顶格 `@js:` 一致
         *
         * 同一条规则里 `result` 的初始值就是「正在被解析的那份内容」，
         * `@js:` 那条路径早就是这么做的（见上面 `evalRule` 里的 `bareJs`）。
         * `<js>` 这条路径之前漏了：它从 `values = []` 起步，于是 `result` 是**空串**。
         *
         * 线上 247 处顶格 `<js>` 里只有十几处真的读 `result`，但每一处都读的是整页：
         * `⚡📂全本小说网` 的目录 `String(result)` 之后 `page.indexOf('class="list3"')`、
         * `📂基友书屋` 的目录 `org.jsoup.Jsoup.parse(result)`、
         * `📂趣书小说` 的 `result.match(/<b>1<\/b>\/(\d+)/)`。
         * 给空串的表现是 `null.match` 之类的报错，或是「目录 0 条、不报错」。
         *
         * 判据是「前面**跑过选择器没有**」，而不是「`values` 空不空」：
         * 选择器命中 0 个时 `result` 本来就该是空（上一阶段的结果为空），
         * 那时候给它塞整页会把「这条规则取不到东西」变成「取到一整页」。
         */
        const result = await runInSandbox(
            part.text,
            {
                ...baseGlobals(ctx),
                ...(sawSelector
                    ? resultGlobals(part.text, values)
                    : sourceResultGlobals(part.text, ctx.result ?? current.source)),
                src: current.source,
            },
            sandboxLimits(current, ctx),
        )
        // 数组要**逐个**返回，不能拍平成一条字符串：列表规则里的 N 条一旦被
        // 换行 join 成一条，N 个条目就只剩 1 个（`sandboxResultToStrings` 对数组
        // 就是那么做的），而对象数组还会退化成 `[object Object]`。
        values = sandboxResultToStrings(result)
        content = values.join('\n')
        current = selectionFromText(content, current.source)
    }

    return values
}

/**
 * 单段规则：一段**不含 `@js:` 尾巴**的选择器
 *
 * `@js:` 尾巴（`选择器@js:代码`）在 `evalRule` 那一层就被 `splitJsTail` 切走了，
 * 因为它必须排在 `##` 链**之前**切 —— 见那里的说明。
 */
async function evalSingleSegment(
    sel: Selection,
    segment: string,
    ctx: RuleContext,
): Promise<string[]> {
    // 冗余的 `@` 标记（`{{@@h1@text}}`、`div.x@@js:代码` 这类）从尾部去掉一个 `@`：
    // 选择器自己不会以 `@` 结尾，尾巴上那个 `@` 只可能属于标记
    const head = segment.replace(/@$/, '')

    /**
     * 整段就是 `@get:{键}` 时，直接给变量的值
     *
     * 这条分支要**排在分派之前**：`@get:{a}` 里没有选择器，落到 `detectKind` 会被当成
     * CSS 选择器去 cheerio 里找一个叫 `@get:{a}` 的元素 —— 静默 0 条。
     *
     * 它同时也是「`@get:{键}` 当后续 `@js:` / `<js>` 的输入」那条路的入口：
     * `@get:{img}@js:…` 在前一层被拆成「前缀 + `@js:` 尾巴」，前缀递归回到这里拿到值，
     * 脚本的 `result` 就是它。
     */
    const getKey = asGetSegment(head)
    if (getKey !== null) return [readInfoVar(ctx, getKey)]

    let kind = detectKind(head)

    // 裸字段名面对 JSON 内容时等价于 `$.字段名`（见 bareJsonField 的说明）
    if (kind.kind === 'css' || kind.kind === 'jsoup') {
        const asField = bareJsonField(head, sel.source)
        if (asField) kind = { kind: 'json', body: asField }
    }

    return kind.kind === 'allinone'
        ? applyAllInOne(sel.source, head)
        : evalSelector(sel, kind.body, kind.kind)
}

/**
 * 沙箱里 `java.getString` 的实现：把一条规则当成字符串求值
 *
 * 规则求值本身可能进沙箱（`@js:`、`<js>`、以及**模板里的 JS 表达式**），
 * 而沙箱的执行槽位是有限的：从沙箱里再要一个槽位，会在槽位用满时永远等下去
 * （外层的求值正占着槽位不放）。所以这里直接挡住会二次进沙箱的规则、明确报错。
 *
 * 实测用法（`java.getString('$.update_time')`、`java.getString('$.freeStack')`）
 * 都是纯 JSONPath / 选择器，不受这条限制影响。
 */
function sandboxGetString(sel: Selection, ctx: RuleContext): SandboxGetString {
    return async (rule, content) => {
        if (ruleHasJs(rule)) {
            throw new UnsupportedRuleError(
                `java.getString 里不能再套 JS 规则（${rule.replace(/\s+/g, ' ').slice(0, 60)}）：沙箱执行槽位是有限的，嵌套求值会互相等待`,
            )
        }
        // 第二个参数给了内容就在那段内容上求值，否则用当前节点
        const target = content === undefined ? sel : rootSelection(content)
        const values = await analyzeStrings(target, rule, ctx)
        return values.filter((v) => v !== '').join('\n')
    }
}

/**
 * 沙箱里 `java.getElements` 的实现：把一条规则求值成**节点集**
 *
 * 做法与 `sandboxGetString` 的区别只在返回值：那边把命中节点的文本拼起来，
 * 这边把**每个节点的 outerHTML** 逐个交出去 —— 脚本那侧再用 org.jsoup 的桥
 * 解析回 Elements，于是 `.select()` / `.get(i)` / `.attr()` 这些都能接着用。
 *
 * 线上 32 处 `getElements` + 9 处 `getElement`，写法横跨 CSS、JSOUP 简写
 * （`@@class.chapter-list.-1@li@a`）与 XPath，这里统一交给 `analyzeSelections`，
 * 不在这一层做方言判断。
 *
 * 与 `java.getString` 同一条限制：规则里不能再套 JS（会二次进沙箱，互相等待）。
 */
function sandboxGetElements(sel: Selection, ctx: RuleContext): SandboxGetElements {
    return async (rule, content) => {
        if (ruleHasJs(rule)) {
            throw new UnsupportedRuleError(
                `java.getElements 里不能再套 JS 规则（${rule.replace(/\s+/g, ' ').slice(0, 60)}）：沙箱执行槽位是有限的，嵌套求值会互相等待`,
            )
        }
        const target = content === undefined ? sel : rootSelection(content)
        // 规则原样交给列表规则求值：`@@class.x@li@a` 这类开头的双 `@` 不用特殊处理
        // （JSOUP 解析本来就会把空段过滤掉，它只是 Legado 的写法习惯）
        const items = await analyzeSelections(target, rule.trim(), ctx)
        const html: string[] = []
        for (const item of items) {
            for (const node of item.nodes) {
                const outer = item.$.html(node)
                if (outer && outer.trim() !== '') html.push(outer)
            }
        }
        return html
    }
}

/** 传给沙箱的能力：取网 + 规则求值 + 节点级规则求值 + 书源自带的 jsLib */
function sandboxLimits(sel: Selection, ctx: RuleContext): SandboxLimits {
    return {
        http: ctx.http,
        getString: sandboxGetString(sel, ctx),
        getElements: sandboxGetElements(sel, ctx),
        ...sourceLimits(ctx),
    }
}

/**
 * 传给沙箱的 `result`（前面选择器取到的值）与「要不要包成 jsoup 对象」
 *
 * 绑数组还是拼成字符串由 `resultWantsArray` 按**脚本自己的写法**决定，
 * 而不是按命中数量 —— 按数量决定的话，同一条规则在单页与多页两种页面上
 * 类型不同，按字符串写的源遇到多页就报 `result.split is not a function`。
 * 判定依据与线上账本见 `resultShape.ts`。
 *
 * 注意这里**不看 `values.length`**：`result[0]` 写在只命中 1 个值的页面上时
 * 也必须拿到那 1 个值，而不是这个字符串的第 1 个**字符**。
 *
 * **脚本按 jsoup 用 `result` 时（`result.size()` / `result.select(…)` / `result[i]`），
 * 绑的东西是 Elements。** 这里按命中数分两种形态，因为窄的那一种只能这么给：
 *
 *   - 命中 **1** 个 → 绑字符串，沙箱的 `__boxHtml` 包成「字符串 + jsoup 方法」。
 *     这份形态给得起两种写法（`result.split` 与 `result.select` 同时可用），
 *     所以**既有的单值路径一点没动**
 *   - 命中 **多个** → 绑数组，沙箱的 `__elemsFrom` 包成「数组形态的 Elements」：
 *     能下标、能 `forEach`、有 `length`，集合级方法（`size()` / `select()` / `attr()`…）
 *     挂在数组上；逐个元素是普通的 jsoup 元素（`e.attr()` / `e.text()`）
 *
 * 多命中在旧实现里绑的是**字符串数组**，`result.size is not a function` 直接报错
 * （线上三处：⚡📂八一中文网 的 `if(!!result.size())`、🔞西瓜书屋 的
 * `result.forEach(e => e.attr('href'))`、🔞紫云宫 的 `result.select("a")` + `result[i]`），
 * 所以这条路上没有「本来就对」的行为可破坏。
 *
 * **脚本按字符串用（`result.split` / `String(result)` / `+ result`）时字符串优先**：
 * 与 jsoup 方法写在一起的规则（`📂就去看网` 那种）两种都要，只有 `__boxHtml` 给得起。
 */
function resultGlobals(code: string, values: string[]): Record<string, unknown> {
    const asJsoup = RESULT_AS_JSOUP.test(code)
    const wantsJsoup = wantsJsoupResult(code)
    // 按节点用时**一律绑数组**（哪怕只命中一个）：`forEach` / `[i]` / `length`
    // 这些只有数组给得起，而命中数随页面浮动，绑两种形态就等于把「单页能跑、
    // 多页崩」换成了「多页能跑、单页崩」。沙箱侧会把它包成「数组形态的 Elements」。
    const value: unknown = wantsJsoup ? values : resultWantsArray(code) ? values : values.join('\n')
    return {
        result: value,
        // 上面两条分支里 `result` 要么是字符串、要么是要多命中的数组，两种都得包成
        // jsoup 对象；「按字符串用、但脚本里也有 jsoup 方法」那一种（`__boxHtml`
        // 给的是「字符串 + jsoup 方法」）同样要包。
        // 所以判据是两者的并：要节点，或者脚本里出现过集合级方法名。
        __resultAsJsoup: wantsJsoup || asJsoup,
    }
}

/**
 * `result` 绑成**页面原文**时用它（整条规则只有 `@js:`、前面没有选择器）
 *
 * 原文只有一份，不存在「绑数组」这一说；`resultWantsArray` 那套判据在这里不适用。
 * 参数是 `unknown` 而非 `string`：上下文里的 `result` 可能是调用方给的任意值。
 */
function sourceResultGlobals(code: string, source: unknown): Record<string, unknown> {
    return {
        result: source,
        __resultAsJsoup: typeof source === 'string' && RESULT_AS_JSOUP.test(code),
    }
}

/**
 * 列表规则的取值位上**只有这几个**才算「取值」
 *
 * 就是 `EXTRACT_KINDS`（text / textNodes / ownText / html / outerHtml / all / href / src）。
 * 判据的由来见 `selectNodesByKind` 的说明。
 */
const LIST_EXTRACT_KINDS: ReadonlySet<string> = new Set<string>(EXTRACT_KINDS)

/**
 * 列表规则的末尾那个词是不是**标签**（该当步骤，而不是取值）
 *
 * 两个条件：① 不是已知取值名（`@text` / `@html` 永远是取值）；
 * ② 是 HTML 的标签名（`isHtmlTagName`，表在 `jsoup.ts`）—— 只认那张表里明确写下的标签，
 * 表外的一律维持「取值」语义（`@data-id` / `@title` 这类属性名一个都不动）。
 */
function isTailTag(extract: string): boolean {
    return !LIST_EXTRACT_KINDS.has(extract) && isHtmlTagName(extract)
}

/**
 * 把「末尾被吞成取值的那一层」补回步骤
 *
 * `parseJsoupRule` 把末尾的裸词读成**取值名**（属性），而列表规则里那多半是**标签**：
 * `parseJsoupRule('class.chapters@li@a')` 给出 `steps=[class chapters, li]`、
 * `extract='a'`，而书源要的是「每个 li 里的 a」。判据与由来见 `selectNodesByKind`。
 */
function withTailStep(plan: JsoupPlan): JsoupStep[] {
    return isTailTag(plan.extract)
        ? [...plan.steps, { by: 'tag', name: plan.extract, index: null }]
        : plan.steps
}

/**
 * `@` 后面这一段是「CSS 片段」还是「JSOUP 步骤」
 *
 * 书源把两种写法混在一起用（`#chapterlist@li a` 与 `.box@ul@li`），所以按段分派：
 *   - 带 JSOUP 类型前缀的一律当**步骤**（`tag.a`、`text.目录`），哪怕名字里带空格；
 *   - 以 CSS 的标点开头（`.`、`#`、`[`、`>`、`+`、`~`、`*`）当 **CSS 片段** ——
 *     尤其是 `.line`：JSOUP 文法会把开头的 `.` 读成「取所有子节点」，语义完全不同；
 *   - 带空格的（`li a`）当 **CSS 片段** —— JSOUP 的步骤是一段一段的，段里不会有空格；
 *   - 其余裸词（`ul`、`li`、`dd.2:3`）交给 `parseJsoupRule` 当步骤。
 */
function isCssFragment(part: string): boolean {
    const p = part.trim()
    if (p === '') return false
    if (/^(?:class|id|tag|text|children)(?:\.|$)/.test(p)) return false
    if (/^[.#\[>+~*]/.test(p)) return true
    return /\s/.test(p)
}

/**
 * 把 `@` 后面的那些段分成「CSS 片段」与「JSOUP 步骤」
 *
 * 列表规则与字段规则**共用这一套分派**（两处的书源写法完全一样）：
 *
 *   `.box@ul@li`            → 头部片段 `ul` 落空、步骤 [ul, li]
 *   `.book-img-text@tag.li` → 步骤 [tag li]
 *   `#chapterlist@li a`     → 头部片段 `li a`（这一段本身就是 CSS 写法）
 *   `.cover@.line`          → 头部片段 `.line`（`.line` 是 CSS 类，不是「children」）
 *
 * 注意对每一段都套 `withTailStep`：段里的裸词（`a` / `li` / `dd`）在书源本意里是**标签**，
 * 而 `parseJsoupRule` 会把末尾裸词读成取值名 —— 不补回来就会少选一层。
 */
function dispatchCssSegments(parts: string[]): { headParts: string[]; steps: JsoupStep[] } {
    const steps: JsoupStep[] = []
    const headParts: string[] = []
    for (const part of parts) {
        if (part === '') continue
        if (isCssFragment(part)) {
            headParts.push(part)
            continue
        }
        const segSteps = withTailStep(parseJsoupRule(part))
        if (segSteps.length > 0) steps.push(...segSteps)
        else headParts.push(part)
    }
    return { headParts, steps }
}

/**
 * 按规则的「种类」在节点集上选出**节点**
 *
 * 与字段规则那条路（`evalSelector`）的区别：这里给的是节点本身，不是按取值方式抠出来的
 * 字符串。列表规则要的是「条目」，后面还要拿字段规则在这些节点里继续筛。
 * 返回 null 表示这一类（JSON / JS / AllInOne）给不出节点。
 *
 * **列表规则的末尾那个词：是 HTML 标签名就当步骤，否则照旧。**
 *
 * 引擎的 jsoup 文法把末尾的裸词一律读成**取值名（属性名）** —— 这是
 * `coverUrl: 'img.2@data-src'` 那种写法要求的。但列表规则里 `class.chapters@li@a`、
 * `class.l@li`、`.sp-chapter-grid@a` 的末尾那个词**不是属性名，是标签名**：
 * 书源要的是「每个 li 里的 a」。照取值读会**少选最后一层**（拿到的还是上一层），
 * 条目少一层之后 `href` / `text` 一律落空 —— 症状是目录 0 条 / 搜索 0 条、
 * 全程不报错，与上一轮那族「条目丢了 DOM」是同一类病。
 *
 * 全量 dump 里列表规则的取值位共 **479 处**，其中已知取值名 **2 处**（`html`）、
 * **HTML 标签名 466 处**（`li` 195 / `a` 159 / `dl` 30 / `dd` 16 / `p` 14 / `tr` 13 /
 * `option` 4 / `span` / `data` / `title` …），剩下 11 处是 JSON 键名（`items`）与
 * 自定义元素（`mio-tile`）这类**不该动**的。
 *
 * 所以判据写成「**已知取值名之外的 HTML 标签名**」：既修掉那 466 处，
 * 又保证表外的一个字都不动 —— 字段规则那条路更是完全没碰（那里 `@title` 95 处、
 * `@content`、`@data-src` 确实是属性名）。
 */
function selectNodesByKind(
    sel: Selection,
    body: string,
    kind: 'css' | 'jsoup' | 'json' | 'xpath' | 'allinone',
): { nodes: any[]; reversed: boolean } | null {
    if (kind === 'css') {
        /**
         * CSS 式首段 + `@` 步骤：`.box@ul@li`、`.book-img-text@tag.li`、`.sp-chapter-grid@a`
         *
         * 整串交给 CSS 会**直接报错**：`splitCssExtract` 只切最后一个 `@`，剩下的
         * `.box@ul` 不是合法 CSS。线上这个形状在列表规则上有 **283 处**：
         * ① 末段是裸词 138（`.book-list@li`）、② 末段带点/方括号 68（`.x@tag.li`）、
         * ③ 两个以上 `@` 77（`.box@ul@li`）。而书源的本意很清楚：**先按 CSS 找一层，
         * 再按 JSOUP 的步骤往下走** —— 与 `@css:div.item@tag.a` 是同一种写法。
         *
         * 前导 `-`（倒置）按 `parseJsoupRule` 的同一套语义处理。
         */
        let rest = body
        let reversed = false
        if (rest.startsWith('-') && !/^-\d/.test(rest)) {
            reversed = true
            rest = rest.slice(1)
        }
        const { css, extract } = splitCssExtract(rest)
        // 要不要走「首段 + 步骤」：末尾是标签名，或 CSS 那头还留着 `@`（`.box@ul@li`）。
        // 都不是（`.one@data-id`）就维持原样：一个字都不动。
        const withSteps = isTailTag(extract) || css.includes('@')
        const headRaw = withSteps ? (rest.split('@')[0] ?? '').trim() : css.trim()
        // 头里可能带 JSOUP 的位置后缀：`.book-dir.1`（第 2 个）、`.row[-1]`、`#list dd[12:-1]`
        const headSplit = splitCssIndex(headRaw)
        let headNodes = selectByCss(sel, headSplit.css)
        if (headSplit.index) headNodes = applyIndex(headNodes, headSplit.index)
        if (!withSteps) return { nodes: headNodes, reversed }

        /**
         * `@` 后面**能当步骤的当步骤、剩下的当 CSS 片段**（分派规则见 `dispatchCssSegments`）
         */
        const { headParts, steps } = dispatchCssSegments(
            rest
                .split('@')
                .map((p) => p.trim())
                .slice(1),
        )
        if (headParts.length > 0) {
            const merged = splitCssIndex([headSplit.css, ...headParts].join(' '))
            headNodes = selectByCss(sel, merged.css)
            if (merged.index) headNodes = applyIndex(headNodes, merged.index)
        }
        return { nodes: selectNodes(sel.$, headNodes, steps), reversed }
    }
    if (kind === 'xpath') {
        // 列表规则同样要把 `//` 当相对路径用：目录规则要的是「本页里的章节项」，
        // 而不是"全文档里的第一个"
        //
        // 末尾的取值后缀在这里**丢掉**：列表规则要的是节点本身，好让后续字段规则
        // 继续在上面筛。留着它的话表达式会解析失败（`//div[@class='x']@html` 不是
        // 合法 XPath），整条目录变成空的。
        const expression = toRunnableXPath(body).expression
        const collected: any[] = []
        for (const node of sel.nodes) {
            const outcome = runXPath(sel.$, expression, node)
            if (outcome.kind === 'nodes') {
                // 属性节点不能作为后续规则继续筛选的上下文，丢掉
                collected.push(...outcome.nodes.filter((n) => !isAttributeView(n)))
            }
        }
        return { nodes: collected, reversed: false }
    }
    if (kind === 'jsoup') {
        const plan = parseJsoupRule(body)
        // 末尾被吞成取值的那一层补回步骤（`class.chapters@li@a` 的 `a` 就是它）
        return { nodes: selectNodes(sel.$, sel.nodes, withTailStep(plan)), reversed: plan.reverse }
    }
    return null
}

/** `<js>` 块的收尾标记（列表规则里用它切「脚本段」与「尾段选择器」） */
const JS_BLOCK_CLOSE = '</js>'

/**
 * 列表规则的最后一段是不是「跟在 `<js>` 块后面的 HTML 选择器」
 *
 * 三个条件缺一不可：
 *   1. 规则里有 `</js>`，且它后面还有非空文本 —— 是 `<js>` **块**，不是 `@js:` 尾巴
 *      （`@js:` 会在 `splitJsTail` 那一层被切走，那条路上 JS 的输出**就是**条目本身）
 *   2. 那段文本不是脚本（`@js:…`）
 *   3. 那段文本是个 HTML 选择器（css / jsoup / xpath）—— JSONPath 的 `$.x` 与
 *      AllInOne 的 `:正则` 不在此列：它们在 JS 输出上取的是 JSON / 正则，
 *      给节点没有意义（线上这两类合计 39 处）
 *
 * **尾段写没写取值方式（`@href` / `@html`）不影响判断**：列表规则要的是**条目**，
 * 而取值方式只对「抠一个值」有意义 —— Legado 的 `getElements(ruleStr)` 同样忽略它。
 * 这一条是冒烟逼出来的：线上 46 处 HTML 尾段里有一大半写成 `.sp-chapter-grid@a`、
 * `class.zj_list@dd` 这种形状，我们的 jsoup 文法会把末尾那个词读成「属性名」，
 * 照「有没有写取值方式」去判就会把它们全部漏掉（而书源的本意是「标签 a / 标签 dd」）。
 */
export function trailingNodeSelector(
    rule: string,
): { body: string; kind: 'css' | 'jsoup' | 'xpath' } | null {
    const index = rule.lastIndexOf(JS_BLOCK_CLOSE)
    if (index < 0) return null
    const tail = rule.slice(index + JS_BLOCK_CLOSE.length).trim()
    if (tail === '') return null
    if (matchDirective(tail)?.name === 'js') return null
    const { kind, body } = detectKind(tail)
    if (kind !== 'css' && kind !== 'jsoup' && kind !== 'xpath') return null
    return { body, kind }
}

/**
 * 列表规则：返回每个条目的 Selection
 *
 * 返回的是**节点**而不是文本，这一点是关键：像 `@css:div.result-item` 这样的列表规则
 * 只是圈定「条目范围」，真正的书名、作者、链接要靠后续字段规则在条目**内部**继续筛选。
 * 一旦在这里就把条目压成纯文本，DOM 结构就丢了，后续规则会全部落空 —— 表现为
 * 「搜索成功、但一条结果也没有」，很难从错误信息上看出来。
 */
export async function analyzeSelections(
    sel: Selection,
    rule: string,
    ctx: RuleContext,
): Promise<Selection[]> {
    const trimmed = rule.trim()
    if (trimmed === '') return []

    // AllInOne：以 `:` 开头，整块正则切分；切出来的是文本，只能重新解析成节点
    //
    // **必须排在连接符之前**：AllInOne 后面跟的是一整段**正则原文**，
    // 而 `||` 在正则里是合法写法（两个空分支），`%%`、`&&` 同理。
    // 先拆连接符的话，`:a||b` 会被切成 `:a` 与 `b` 两块，正则被从中间截断，
    // 结果既不报错也不是原来那条规则要的东西。
    if (trimmed.startsWith(':') && !trimmed.startsWith('::')) {
        return applyAllInOne(sel.source, trimmed).map((text) => selectionFromText(text, sel.source))
    }

    /**
     * 列表规则同样会写 `||` 备选，而且很常见：
     *
     *   bookList: `ol.book-ol.book-ol-normal li.book-li||ol.jsBooks li.book-li`
     *
     * 之前这里**完全不处理连接符**，整串（含 `||`）会被当成一个 CSS 选择器交给 cheerio，
     * cheerio 抛错、被 `selectByCss` 的 catch 咽掉，于是返回**空列表**：
     * 症状正是「分类拉出来了，但一本书都没有」。而这条规则本意是
     * 「老版页面用第一个选择器，新版用第二个」。
     *
     * 三种连接符的语义与字段规则一致：`||` 取第一个有结果的，`&&` 合并，`%%` 轮流取；
     * `splitConnectors` 本身会跳过 `@js:` / `<js>` 区域，所以 JS 里的 `||` 不会被切。
     */
    const connectors = splitConnectors(trimmed)
    if (connectors) {
        const groups: Selection[][] = []
        for (const part of connectors.parts) groups.push(await analyzeSelections(sel, part, ctx))

        if (connectors.joiner === '||') return groups.find((g) => g.length > 0) ?? []
        if (connectors.joiner === '&&') return groups.flat()

        const merged: Selection[] = []
        const max = Math.max(...groups.map((g) => g.length), 0)
        for (let i = 0; i < max; i += 1) {
            for (const group of groups) if (group[i] !== undefined) merged.push(group[i]!)
        }
        return merged
    }

    /**
     * 列表规则开头的 `+` 是一个**标记**，剥掉它按后面的规则正常求值
     *
     * 线上 8 处（6 处 chapterList + 2 处 bookList，见 `test/ruleTail.scan.test.ts` 的账本）：
     * `+@js:…`（3）、`+<js>…</js>`（3）、`+@css:…`（2）。
     *
     * 早先这里直接抛「列表规则 AllInOne(js) 暂未实现」，判断依据是社区文档里那句
     * 「在搜索列表、发现列表和目录中使用可以用 `+` 开头，使用 AllInOne 规则」。
     * 但语料否掉了 AllInOne 这个读法：`📂内裤奇缘小说` 写的是 `+@css:#lieb dl`、
     * `⚡📂️快眼小说` 写的是 `+@css:.bookbox` —— AllInOne 必须以 `:` 开头，
     * 这两个 `+` 后面跟的是 CSS 选择器，怎么读都读不成 AllInOne。
     *
     * 剥掉之后剩下的是什么，语料给出的答案是一致的：
     *
     *   - `+@css:` 两处 → 就是普通 CSS 列表规则，与不带 `+` 的写法毫无差别
     *   - `+@js:` 三处 → 剥完是**顶格** `@js:`，`result` 绑页面原文，
     *     而这三个脚本（`⚡📂武道文学`、`📂明月小说`、`📚海棠/蓝海搜书`）
     *     确实都是在整页上做 `Jsoup.parse(result)` / 正则扫描
     *   - `+<js>` 三处 → 剥完是**顶格** `<js>`，同样要 `result` = 页面原文
     *     （`🔞po18城` 的 `String(result).replace(…)`、`📂趣书小说` 的
     *     `result.match(/<b>1<\/b>\/(\d+)/)` 都是整页扫描）
     *
     * 唯一不能从语料确认的是「`+` 是否还有『把本页结果追加到已有结果上』的含义」。
     * 这一条**不影响我们的行为**：多页目录本来就是累加的
     * （`ops.ts` 里 `chapters.push(…)` 逐页往后接），单页时也没有「已有结果」可追加。
     * 所以剥掉 `+` 在两种读法下**结果相同**，不需要押注哪一种。
     */
    if (trimmed.startsWith('+')) {
        const rest = trimmed.slice(1)
        return rest.trim() === '' ? [] : analyzeSelections(sel, rest, ctx)
    }

    const { selector, ops } = splitRegexChain(trimmed)
    let kind = detectKind(selector)

    // 裸字段名面对 JSON 内容时等价于 `$.字段名`（见 bareJsonField 的说明）
    if (kind.kind === 'css' || kind.kind === 'jsoup') {
        const asField = bareJsonField(selector, sel.source)
        if (asField) kind = { kind: 'json', body: asField }
    }

    /**
     * JS 列表规则（整条 `@js:`，或选择器后面接 `<js>` 段）必须走「取字符串」那条路。
     *
     * 不能进节点那条路：`@js:...` 会被 `detectKind` 归进 JSOUP 简写
     * （`@js:` 里 `@` 前面是空串，判定维持 JSOUP），`parseJsoupRule` 对它解析出
     * **空步骤**，`selectNodes` 于是原样返回根节点 —— 也就是「**整页变成一个条目**」。
     * 接口型书源（音频、漫画）的列表规则几乎全是这个形态，症状是
     * **一条都搜不到、而且全程不报错**。
     */
    // `splitJsTail(trimmed)` 那一项是为 `选择器##过滤##@js:代码` 补的：`selector` 只到
    // 第一个 `##` 为止、看不见后面的 `@js:`，于是这种列表规则会走节点那条路 ——
    // 节点那条路**跑不了脚本**，`ops` 之后的结果直接被当条目，JS 一次都不执行。
    const isJsRule =
        matchDirective(selector)?.name === 'js' ||
        /<js[\s>]/i.test(selector) ||
        splitJsTail(trimmed) !== null

    const picked = isJsRule ? null : selectNodesByKind(sel, kind.body, kind.kind)
    let nodes: any[] | null = picked?.nodes ?? null
    const reversed = picked?.reversed ?? false

    if (nodes) {
        if (reversed) nodes = [...nodes].reverse()
        // 列表级正则会把条目本身改掉，改完必须按新 HTML 重新解析才能继续筛
        if (ops.length > 0) {
            return nodes.map((node) =>
                selectionFromText(applyRegexOps(sel.$.html(node) ?? '', ops), sel.source),
            )
        }
        return nodes.map((node) => ({ $: sel.$, nodes: [node], source: sel.source }))
    }

    /**
     * **JS 列表规则后面还跟了一段 HTML 选择器**时，条目要给**节点**，不能给文本
     *
     * Legado 的 `getElements(ruleStr)` 是**按段分发**的：`<js>` 段跑脚本，
     * 下一段选择器用 jsoup 的 `getElements` 在那段输出上重新解析 —— 于是条目是
     * **Element**，后续字段规则（`chapterName` 里的 `@js:`、`chapterUrl` 里的
     * `@href` + `src`）都在**那一个元素**上求值：`String(result)` / `String(src)`
     * 拿到的是这一条自己的 outer HTML。
     *
     * 我们这条路上以前把尾段的**默认取值（文本）**直接当条目，于是：
     *   - `chapterUrl: 'href'` / `a@href` 在文本条目上取不到任何属性 → 章节全被丢掉
     *   - `chapterName` 里按 HTML 写的正则匹配不到 → `catch` 里再 `[1]` 就是
     *     `cannot read property of null`（🔞PO5 那一族线上报的正是这句，指向第 6 行）
     *
     * 线上这个形状共 46 处（约 34 个源），集中在目录与搜索列表上。
     */
    const tailSelector = isJsRule ? trailingNodeSelector(trimmed) : null
    if (tailSelector) {
        const cut = trimmed.lastIndexOf(JS_BLOCK_CLOSE)
        const head = trimmed.slice(0, cut + JS_BLOCK_CLOSE.length)
        const produced = await analyzeStrings(sel, head, ctx)
        const items: Selection[] = []
        for (const html of produced) {
            const inner = selectionFromText(html, html)
            const hit = selectNodesByKind(inner, tailSelector.body, tailSelector.kind)
            if (!hit) continue
            const list = hit.reversed ? [...hit.nodes].reverse() : hit.nodes
            for (const node of list) {
                // 条目的 `source` 用**这一条自己的 HTML**：字段规则里的 `src` / `result`
                // 在 Legado 里都指向「当前元素」，用它才能按条取到各自的属性
                // （🔞PO5 的 chapterUrl 就是从 `src` 里抠出这一章自己的 base64 地址）
                items.push({ $: inner.$, nodes: [node], source: inner.$.html(node) ?? html })
            }
        }
        return items
    }

    // JSONPath / JS 这类列表规则给不出节点，退化成「取字符串再各自解析」
    const values = await analyzeStrings(sel, isJsRule ? trimmed : selector, ctx)

    /**
     * 两条纪律，对 JS 与 JSONPath **一视同仁**：
     *
     *   1. **命中的是整个数组时要摊平**。`$.info.Datas`、或脚本直接返回一整段数组
     *      JSON，这种写法极多；不摊平的话条目数恒为 1、内容是一整段数组 JSON，
     *      后续 `$.name` 一个键都取不到 —— 表现是「搜不到书，全程不报错」。
     *      Legado 那边 `getList()` 给出来的就是数组的元素。
     *   2. **条目的 `source` 必须是条目自己的文本**，不能沿用整页：`$.name` 是在
     *      条目的这份文本上求值的，沿用整页就变成在根节点上取键，同样什么都取不到。
     *
     * 这两条以前只写在 JSONPath 那一支上，而 JS 那一支（`<js>` 段 + `$.路径` 尾段，
     * 线上 39 处）走的是另一支、没有摊平 —— 同一个坑在两支上都要填。
     */
    const items: string[] = []
    for (const value of values) {
        const candidate = value.trim()
        if (candidate.startsWith('[')) {
            try {
                const parsed: unknown = JSON.parse(candidate)
                if (Array.isArray(parsed)) {
                    for (const element of parsed) {
                        if (element === null || element === undefined) continue
                        items.push(typeof element === 'string' ? element : JSON.stringify(element))
                    }
                    continue
                }
            } catch {
                /* 不是 JSON 数组就按原样处理 */
            }
        }
        items.push(value)
    }
    return items.map((text) => selectionFromText(text, text))
}

/** 便捷方法：在节点集上求单值 */
export async function analyzeString(
    sel: Selection,
    rule: string,
    ctx: RuleContext,
): Promise<string> {
    const values = await analyzeStrings(sel, rule, ctx)
    return values.filter((v) => v !== '').join('\n')
}

/**
 * 这个 init 值能不能当「根」—— 当不了就返回 null
 *
 * 能当根的是「选择器 / 路径」那一类（线上 42 处 / 约 41 个源）：
 *   `$.data`（23 处）、`data` 这类裸词（8 处）、`data.book` 这类点号路径（6 处）、
 *   `.book` / `class.menu` / `tag.main` 这类 DOM 选择器（5 处）
 */
function jsonInitPath(source: string, selector: string): string | null {
    if (!isJsonContent(source)) return null
    const t = selector.trim()
    if (t.startsWith('$')) return t
    // `class.menu` / `tag.main` 这种是 JSOUP 步骤，不是 JSON 路径 —— 不能当成 `$.class.menu`
    if (/^(?:class|id|tag|text|children)(?:\.|$)/.test(t)) return null
    // 裸词（`data` / `head` / `result`）、点号路径（`data.book`）、以及带下标的（`data[0]`，
    // ⚡📂绿柠小说 的形状）都按 JSON 路径读
    if (/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*(?:\.-?\d+|\[[^\]]*\])?$/.test(t)) return `$.${t}`
    return null
}

/**
 * 求值 `ruleBookInfo.init`，并返回**替换后的求值根**（不需要换根时返回 null）
 *
 * 两次都在这一个函数里，是因为「有没有副作用」和「能不能当根」是同一件事的两面：
 *   - `@put:{…}` / 脚本：求值一次（**副作用**：往变量表里写），不换根
 *   - `$.data` / `class.menu` 这类：**换根** —— 后面的字段都相对它求值
 *
 * 为什么要「换根」：`⚡📂米读小说` 的 init 是 `$.data`、字段是 `$.title` / `$.author` /
 * `$..cover`，接口返回的却是 `{code:0, data:{title:…}}` —— 不换根的话每条规则都差一层，
 * 全部取空（而且不报错）。同一个源里 `ruleToc` 的 `$.data.chapter_lists[*]` 是**绝对**路径，
 * 所以换根只对 `ruleBookInfo` 生效 —— 这与 `init` 只挂在这个字段下正好一致。
 *
 * DOM 一侧同理：`class.menu`（⚡📂笔趣阁）、`.book`（📂无奈书库）选出的节点成为新的根，
 * 后续的 CSS / JSOUP 规则都在它**里面**找。一个节点都没选中时**不换根**：那时多半是
 * init 写错了，沿用整页至少不会把本来能用的字段一起弄丢。
 */
export async function resolveInitSelection(
    sel: Selection,
    init: string,
    ctx: RuleContext,
): Promise<Selection | null> {
    const t = init.trim()
    if (t === '') return null

    const sideEffectOnly = /^@?(?:put|js):/i.test(t) || /^<js[\s>]/i.test(t) || t.includes('{{')
    if (sideEffectOnly) {
        try {
            await analyzeStrings(sel, t, ctx)
        } catch {
            /**
             * `init` 只是给后面的字段**铺变量**：它自己失败时，让那些 `@get:{键}` 空着就行
             *
             * 不吞的话，一条 init 脚本写坏（沙箱报错、上游取网失败）就把整本书的详情页
             * 变成报错 —— 而那些字段本来也只是空着，不该整页打不开。判据与
             * `evalTemplate` 里那句一样：**展示用的字段取不到，不连累整条链路**。
             */
        }
        return null
    }

    // JSON：把根换成 init 命中的那个值（重新序列化成一段 JSON 文本，
    // 这样 `$.` / 裸字段名 / `{{}}` 三条路都自然相对它求值）
    const path = jsonInitPath(sel.source, t)
    if (path !== null) {
        let parsed: unknown
        try {
            parsed = JSON.parse(sel.source)
        } catch {
            return null
        }
        const hit = queryJsonPath(parsed, path).find((v) => v !== null && v !== undefined)
        if (hit === undefined) return null
        const text = typeof hit === 'string' ? hit : JSON.stringify(hit)
        if (text.trim() === '') return null
        return { ...sel, source: text }
    }

    // DOM：init 选出的节点成为新的根
    const picked = await analyzeSelections(sel, t, ctx)
    const nodes = picked.flatMap((p) => p.nodes)
    return nodes.length > 0 ? { ...sel, nodes } : null
}

export { selectionFromText }
