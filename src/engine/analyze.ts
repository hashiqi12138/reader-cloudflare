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
import type { RuleContext, RuleResult } from './types'
import { parseJsoupRule } from './jsoup'
import { extractValues, parseHtml, reparseFragment, selectNodes } from './select'
import { jsonPathToStrings } from './jsonpath'
import { runInSandbox, sandboxResultToString } from './js'
import { isAttributeView, runXPath } from './xpath'

/** 一次规则求值所面对的上下文：一个可继续筛选的节点集 */
export interface Selection {
  $: ReturnType<typeof parseHtml>
  nodes: any[]
  /** 源码原文，供 @js 的 src 与 JSONPath 使用 */
  source: string
}

/** 规则用了本引擎尚未实现的能力时抛这个，好让上层把「不支持」和「没匹配到」区分开 */
export class UnsupportedRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedRuleError'
  }
}

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

/** 拆同级连接符；返回 null 表示没有连接符 */
function splitConnectors(rule: string): { parts: string[]; joiner: '&&' | '||' | '%%' } | null {
  for (const joiner of ['&&', '||', '%%'] as const) {
    if (rule.includes(joiner)) {
      return { parts: rule.split(joiner), joiner }
    }
  }
  return null
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
  if (t.startsWith('@XPath:') || t.startsWith('@xpath:')) return { kind: 'xpath', body: t.slice(7) }
  if (t.startsWith('//') || t.startsWith('(/')) return { kind: 'xpath', body: t }
  if (t.startsWith('@json:')) return { kind: 'json', body: t.slice(6) }
  if (t.startsWith('$.')) return { kind: 'json', body: t }
  // AllInOne：整块正则切分，只用于列表规则
  if (t.startsWith(':') && t.length > 1) return { kind: 'allinone', body: t }
  return { kind: 'jsoup', body: t }
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

/** 规则求值：返回字符串列表 */
export async function analyzeStrings(
  sel: Selection,
  rule: string,
  ctx: RuleContext,
): Promise<string[]> {
  const trimmed = rule.trim()
  if (trimmed === '') return []

  // 同级连接符优先：`a||b` 两块是并列关系，各自独立求值
  const connectors = splitConnectors(trimmed)
  if (connectors) {
    const results: string[][] = []
    for (const part of connectors.parts) {
      results.push(await analyzeStrings(sel, part, ctx))
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

  const { selector, ops } = splitRegexChain(trimmed)

  const values = await evalSelectorChain(sel, selector, ctx)
  const transformed = ops.length ? values.map((v) => applyRegexOps(v, ops)) : values
  return transformed
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

    const result = await runInSandbox(part.text, {
      ...baseGlobals(ctx),
      result: values.length > 1 ? values : (values[0] ?? ''),
      src: current.source,
    })
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

  // 整条规则只有 @js:，没有前置选择器
  if (head.trim() === '' && jsCode !== null) {
    const result = await runInSandbox(jsCode, { ...baseGlobals(ctx), result: ctx.result ?? '' })
    return [sandboxResultToString(result)]
  }

  const kind = detectKind(head)
  let values: string[]

  if (kind.kind === 'allinone') {
    values = applyAllInOne(sel.source, head)
  } else {
    values = evalSelector(sel, kind.body, kind.kind)
  }

  if (jsCode === null) return values

  const result = await runInSandbox(jsCode, {
    ...baseGlobals(ctx),
    result: values.length > 1 ? values : (values[0] ?? ''),
    src: sel.source,
  })
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
  const kind = detectKind(selector)

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

  // JSONPath / XPath 这类列表规则给不出节点，退化成「取字符串再各自解析」
  const values = await analyzeStrings(sel, selector, ctx)
  return values.map((text) => selectionFromText(text, sel.source))
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
