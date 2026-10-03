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
import { UnsupportedRuleError, type RuleContext, type RuleResult } from './types'
import { parseJsoupRule } from './jsoup'
import { sourceGlobals, sourceLimits } from './globals'
import { extractValues, parseHtml, reparseFragment, selectNodes } from './select'
import { jsonPathToStrings } from './jsonpath'
import { runInSandbox, sandboxResultToString, sandboxResultToStrings } from './js'
import type { SandboxGetElements, SandboxGetString, SandboxLimits } from './js'
import {
    classifyTemplate,
    hasRuleSyntax,
    skeletonOf,
    stripRuleMarker,
    templatePattern,
} from './template'
import { splitJsTail, splitRuleText } from './ruleText'
import { matchDirective, ruleHasJs } from './directives'
import { resultWantsArray } from './resultShape'
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

/** 判断这条规则该用哪种选择器 */
function detectKind(rule: string): {
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
    if (t.startsWith('$.')) return { kind: 'json', body: t }
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

    // 裸标签名，可带位置下标：`a`、`a.0`、`a[0]`
    return /^[A-Za-z][\w:-]*(?:\.-?\d+|\[[^\]]*\])?$/.test(selector)
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

/** 在给定节点集上跑一条「纯选择器」规则，返回字符串列表 */
function evalSelector(sel: Selection, body: string, kind: string): string[] {
    if (kind === 'json') {
        let parsed: unknown
        try {
            parsed = JSON.parse(sel.source)
        } catch {
            return []
        }
        return jsonPathToStrings(parsed, body)
    }

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

    if (kind === 'css') {
        const { css, extract } = splitCssExtract(body)
        return extractValues(sel.$, selectByCss(sel, css), extract)
    }

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
        expanded += await evalTemplate(sel, match[1] ?? '', ctx)
        last = match.index + match[0].length
    }
    const tail = rule.slice(last)
    expanded += tail
    skeleton += tail

    return { expanded, skeleton }
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
    const trimmed = rule.trim()
    if (trimmed === '') return []

    if (!trimmed.includes('{{')) return evalRule(sel, trimmed, null, ctx)

    // 模板先展开：`{{}}` 里可能有 `||`、`##`，先展开才不会把它们当成分隔符
    // 把规则切碎（`{{$.a||$.b}}`、`{{$.desc##x##y}}` 都是真实写法）
    const { expanded, skeleton } = await expandTemplates(sel, trimmed, ctx)
    return evalRule(sel, expanded, skeleton, ctx)
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

        // 前置那一段照旧求值：它可能是「选择器 + 自己的链」，也可能就是空的。
        // 递归进来时 `@js:` 已经被切走了（`splitJsTail` 取的是**第一个**标记），不会转圈
        const values = bareJs
            ? []
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

    for (const part of jsBlocks) {
        if (part.kind === 'selector') {
            if (part.text === '') continue
            sawSelector = true
            const kind = detectKind(part.text)
            if (kind.kind === 'allinone') {
                values = applyAllInOne(current.source, part.text)
                current = selectionFromText(values.join('\n'), current.source)
            } else {
                values = evalSelector(current, kind.body, kind.kind)
                // 中间结果要能被后续规则继续筛选，所以重新解析成节点
                current = selectionFromText(values.join('\n'), current.source)
            }
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
        // 换行 join 成一条，N 个条目就只剩 1 个（`sandboxResultToString` 对数组
        // 就是那么做的），而对象数组还会退化成 `[object Object]`。
        values = sandboxResultToStrings(result)
        current = selectionFromText(values.join('\n'), current.source)
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

function baseGlobals(ctx: RuleContext): Record<string, unknown> {
    return {
        baseUrl: ctx.baseUrl,
        book: ctx.book ?? {},
        key: ctx.key ?? '',
        page: ctx.page ?? 1,
        // `source` / `infoMap` 在沙箱预置里由这几个变量组装（见 engine/globals.ts）
        ...sourceGlobals(ctx),
    }
}

/**
 * 脚本是不是把 `result` 当 jsoup 对象用（`result.select('h3').text()`）
 *
 * Legado 里 `result` 同时可能是字符串也可能是 jsoup 对象，两种写法在**同一条书源里**
 * 都会出现。这里只按「真的调了 jsoup 方法」来判断，而不是一律包装 ——
 * 一律包装会把 `typeof result` 从 `'string'` 变成 `'object'`，
 * 而线上有 18 处脚本在判断这个类型。
 */
const RESULT_AS_JSOUP =
    /\bresult\s*\.\s*(select|attr|first|last|get|eq|size|isEmpty|textNodes|eachText|html|outerHtml|hasClass|children|not|filter|matches|matchesOwn|tagName|ownText)\s*\(/

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
 */
function resultGlobals(code: string, values: string[]): Record<string, unknown> {
    const value: unknown = resultWantsArray(code) ? values : values.join('\n')
    return {
        result: value,
        __resultAsJsoup: typeof value === 'string' && RESULT_AS_JSOUP.test(code),
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

    let nodes: any[] | null = null
    let reversed = false

    if (!isJsRule) {
        if (kind.kind === 'css') {
            nodes = selectByCss(sel, splitCssExtract(kind.body).css)
        } else if (kind.kind === 'xpath') {
            // 列表规则同样要把 `//` 当相对路径用：目录规则要的是「本页里的章节项」，
            // 而不是"全文档里的第一个"
            //
            // 末尾的取值后缀在这里**丢掉**：列表规则要的是节点本身，好让后续字段规则
            // 继续在上面筛。留着它的话表达式会解析失败（`//div[@class='x']@html` 不是
            // 合法 XPath），整条目录变成空的。
            const expression = toRunnableXPath(kind.body).expression
            const collected: any[] = []
            for (const node of sel.nodes) {
                const outcome = runXPath(sel.$, expression, node)
                if (outcome.kind === 'nodes') {
                    // 属性节点不能作为后续规则继续筛选的上下文，丢掉
                    collected.push(...outcome.nodes.filter((n) => !isAttributeView(n)))
                }
            }
            nodes = collected
        } else if (kind.kind === 'jsoup') {
            const plan = parseJsoupRule(kind.body)
            nodes = selectNodes(sel.$, sel.nodes, plan.steps)
            reversed = plan.reverse
        }
    }

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

    // JSONPath / JS 这类列表规则给不出节点，退化成「取字符串再各自解析」
    const values = await analyzeStrings(sel, isJsRule ? trimmed : selector, ctx)

    if (isJsRule || kind.kind !== 'json') {
        /**
         * 条目的 `source` 必须是**条目自己的文本**，不能沿用整页。
         *
         * 后续字段规则（`$.name`、`@js:JSON.parse(result).name`）都在这份文本上求值：
         * 沿用整页的话，`$.name` 是在整页 JSON 的根节点上找键 —— 根节点上没有 name，
         * 于是**每个条目都取不到字段、全被丢掉**，表现就是「搜索 0 条、不报错」。
         */
        return values.map((text) => selectionFromText(text, text))
    }

    /**
     * JSON 列表规则有两个坑，都在这一层修；两个都会让**整个源搜不到书**，
     * 而且全程不报错 —— 接口型书源（音频、漫画里的接口站）几乎都是这个形态。
     *
     *   1. `$.info.Datas` 这种写法命中的是**整个数组**。不摊平的话条目数恒为 1，
     *      而条目的内容是一段数组 JSON。真实站点里这种写法极多。
     *   2. 条目的 `source` 必须换成**条目自己的文本**。沿用整页的 source 的话，
     *      后续按 `$.name` 取字段时是在整页 JSON 的根节点上取键 ——
     *      根节点上当然没有 name，于是所有条目都取不到字段，全被丢掉。
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

export { selectionFromText }
