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
import { extractValues, parseHtml, reparseFragment, selectNodes } from './select'
import { jsonPathToStrings } from './jsonpath'
import { runInSandbox, sandboxResultToString } from './js'
import { classifyTemplate, hasRuleSyntax, stripRuleMarker, templatePattern } from './template'
import { isAttributeView, runXPath } from './xpath'

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
 * **方括号里与引号里的连接符不算**：`$.list[?(@.a&&@.b)]` 里的 `&&` 是 JSONPath 的与，
 * `@js:"a||b"` 里的 `||` 是字符串内容。
 *
 * 不排除的话规则会被从中间切开，每一块看起来都「合法」，只是结果全不对 ——
 * 更糟的是**报错信息会指向切开后的半截规则**（`过滤器缺少收尾的 )：$.list[?(@.a`），
 * 让人以为是过滤器写错了格式，而真正的问题在别处。
 */
function splitConnectors(rule: string): { parts: string[]; joiner: '&&' | '||' | '%%' } | null {
    for (const joiner of ['&&', '||', '%%'] as const) {
        const parts = splitOutsideBrackets(rule, joiner)
        if (parts) return { parts, joiner }
    }
    return null
}

/** 按分隔符切分，但跳过方括号内与引号内的内容；没有分隔符时返回 null */
function splitOutsideBrackets(rule: string, delimiter: string): string[] | null {
    const parts: string[] = []
    let depth = 0
    let quote = ''
    let last = 0
    let found = false

    for (let i = 0; i < rule.length; i += 1) {
        const ch = rule[i]!

        if (quote !== '') {
            if (ch === quote) quote = ''
            continue
        }
        if (ch === '"' || ch === "'") {
            quote = ch
            continue
        }
        if (ch === '[') {
            depth += 1
            continue
        }
        if (ch === ']') {
            depth = Math.max(0, depth - 1)
            continue
        }
        if (depth > 0) continue

        if (rule.startsWith(delimiter, i)) {
            parts.push(rule.slice(last, i))
            i += delimiter.length - 1
            last = i + 1
            found = true
        }
    }

    if (!found) return null
    parts.push(rule.slice(last))
    return parts
}

/** 把选择器部分拆成 [选择器, JS, 选择器, JS, ...]，对应 `<js></js>` 分隔 */
function splitJsBlocks(rule: string): Array<{ kind: 'selector' | 'js'; text: string }> {
    const parts: Array<{ kind: 'selector' | 'js'; text: string }> = []
    const re = /<js>([\s\S]*?)<\/js>/g
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
    if (t.startsWith('@css:')) return { kind: 'css', body: t.slice(5) }
    if (t.startsWith('@XPath:') || t.startsWith('@xpath:'))
        return { kind: 'xpath', body: t.slice(7) }
    if (t.startsWith('//') || t.startsWith('(/')) return { kind: 'xpath', body: t }
    if (t.startsWith('@json:')) return { kind: 'json', body: t.slice(6) }
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

/** 用 CSS 选择器在当前节点集的后代里找节点 */
function selectByCss(sel: Selection, css: string): any[] {
    const nodes: any[] = []
    for (const n of sel.nodes) {
        try {
            nodes.push(...sel.$(n).find(css).toArray())
        } catch {
            /* 选择器写坏就当作没匹配到，不要让一个坏源拖垮整次搜索 */
        }
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
 * 取一个 XPath 结果节点的值
 *
 * XPath 与 JSOUP 规则不同：**取什么由表达式自己决定**（`/text()` 给文本节点、
 * `/@href` 给属性节点、选中元素则取它的文本），所以这里没有 `@text` / `@href`
 * 那样的取值后缀。
 */
function xpathNodeValue($: Selection['$'], node: any): string {
    if (isAttributeView(node)) return node.value.trim()
    if (node?.type === 'text') return String(node.data ?? '').trim()
    if (!node || typeof node !== 'object') return ''
    return $(node).text().trim()
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
        const expression = toRelativeXPath(body)
        const values: string[] = []
        for (const node of sel.nodes) {
            const outcome = runXPath(sel.$, expression, node)
            if (outcome.kind === 'scalar') {
                if (outcome.value !== '') values.push(outcome.value)
                continue
            }
            for (const hit of outcome.nodes) {
                const value = xpathNodeValue(sel.$, hit)
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
                { ...baseGlobals(ctx), result: sel.source, src: sel.source },
                { http: ctx.http },
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

/** 连接符与正则链的解析；`skeleton` 与 `rule` 结构对应 */
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

    const { selector, ops } = splitRegexChain(rule)
    const skeletonSelector = skeleton === null ? null : splitRegexChain(skeleton).selector

    let values: string[]
    if (skeletonSelector !== null && !hasRuleSyntax(skeletonSelector)) {
        // 展开之后是字面文本（`"/api/tracks/{{$.id}}"` 这类），直接当结果
        values = selector.trim() === '' ? [] : [selector]
    } else {
        values = await evalSelectorChain(sel, selector, ctx)
    }

    return ops.length ? values.map((v) => applyRegexOps(v, ops)) : values
}

/** 处理 `<js></js>` 链与 `@js:` 尾巴 */
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

    for (const part of jsBlocks) {
        if (part.kind === 'selector') {
            if (part.text === '') continue
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

        const result = await runInSandbox(
            part.text,
            {
                ...baseGlobals(ctx),
                result: values.length > 1 ? values : (values[0] ?? ''),
                src: current.source,
            },
            { http: ctx.http },
        )
        values = [sandboxResultToString(result)]
        current = selectionFromText(values[0] ?? '', current.source)
    }

    return values
}

/** 单段规则：可能是纯选择器，也可能是「选择器 + @js」 */
async function evalSingleSegment(
    sel: Selection,
    segment: string,
    ctx: RuleContext,
): Promise<string[]> {
    const jsMark = '@js:'
    const jsAt = segment.indexOf(jsMark)
    const head = jsAt === -1 ? segment : segment.slice(0, jsAt).replace(/@$/, '')
    const jsCode = jsAt === -1 ? null : segment.slice(jsAt + jsMark.length)

    // 整条规则只有 `@js:`，没有前置选择器
    //
    // 此时 `result` 必须绑成**当前页面的原文**。真实书源里这是常规写法
    // （天脉漫画的正文就是 `@js:var start = result.indexOf('id="cp_img"')…`），
    // 而 `result` 若是空串，规则会「执行成功但什么都取不到」；
    // 喜马拉雅的目录规则更直接：对空串 JSON.parse 就地报错。
    if (head.trim() === '' && jsCode !== null) {
        const result = await runInSandbox(
            jsCode,
            { ...baseGlobals(ctx), result: ctx.result ?? sel.source, src: sel.source },
            { http: ctx.http },
        )
        return [sandboxResultToString(result)]
    }

    let kind = detectKind(head)

    // 裸字段名面对 JSON 内容时等价于 `$.字段名`（见 bareJsonField 的说明）
    if (kind.kind === 'css' || kind.kind === 'jsoup') {
        const asField = bareJsonField(head, sel.source)
        if (asField) kind = { kind: 'json', body: asField }
    }

    let values: string[]

    if (kind.kind === 'allinone') {
        values = applyAllInOne(sel.source, head)
    } else {
        values = evalSelector(sel, kind.body, kind.kind)
    }

    if (jsCode === null) return values

    const result = await runInSandbox(
        jsCode,
        {
            ...baseGlobals(ctx),
            result: values.length > 1 ? values : (values[0] ?? ''),
            src: sel.source,
        },
        { http: ctx.http },
    )
    return [sandboxResultToString(result)]
}

function baseGlobals(ctx: RuleContext): Record<string, unknown> {
    return {
        baseUrl: ctx.baseUrl,
        book: ctx.book ?? {},
        key: ctx.key ?? '',
        page: ctx.page ?? 1,
        cookie: {},
        cache: {},
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
    if (trimmed.startsWith(':') && !trimmed.startsWith('::')) {
        return applyAllInOne(sel.source, trimmed).map((text) => selectionFromText(text, sel.source))
    }

    // `+` 开头是 ListAllInOne（JS 产出列表），当前不支持，明确报错而不是静默返回空
    if (trimmed.startsWith('+')) {
        throw new UnsupportedRuleError('列表规则 AllInOne(js) 暂未实现：以 + 开头的规则')
    }

    const { selector, ops } = splitRegexChain(trimmed)
    let kind = detectKind(selector)

    // 裸字段名面对 JSON 内容时等价于 `$.字段名`（见 bareJsonField 的说明）
    if (kind.kind === 'css' || kind.kind === 'jsoup') {
        const asField = bareJsonField(selector, sel.source)
        if (asField) kind = { kind: 'json', body: asField }
    }

    let nodes: any[] | null = null
    let reversed = false

    if (kind.kind === 'css') {
        nodes = selectByCss(sel, splitCssExtract(kind.body).css)
    } else if (kind.kind === 'xpath') {
        // 列表规则同样要把 `//` 当相对路径用：目录规则要的是「本页里的章节项」，
        // 而不是"全文档里的第一个"
        const expression = toRelativeXPath(kind.body)
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

    // JSONPath 这类列表规则给不出节点，退化成「取字符串再各自解析」
    const values = await analyzeStrings(sel, selector, ctx)

    if (kind.kind !== 'json') {
        return values.map((text) => selectionFromText(text, sel.source))
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
