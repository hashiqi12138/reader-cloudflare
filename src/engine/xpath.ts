/**
 * XPath 支持
 *
 * 为什么走「W3C DOM 适配层 + 现成 XPath 实现」这条路
 * ------------------------------------------------
 * 直接换一个 XML 解析器去跑 XPath 是不行的：真实网页充满未闭合标签、
 * 裸 `&`、大小写混乱的属性，XML 严格解析必然报错。
 * 所以仍然用 cheerio（htmlparser2）解析 HTML，只在外面套一层 W3C DOM 接口，
 * 让标准的 XPath 1.0 实现（`xpath` 包，零依赖）跑在这层之上。
 *
 * 好处是拿到**完整的 XPath 1.0 语义**（各种轴、谓词、内置函数），
 * 而不是自己实现一个"够用"的子集 —— 后者遇到没覆盖的写法极容易悄悄返回错数据，
 * 那比直接报错危险得多。
 *
 * 这里刻意**不做** XPath → CSS 的翻译：翻译器无法覆盖 `contains()`、位置谓词、
 * 各种轴，一旦翻不出来就只能降级或猜，而猜错是静默的。
 *
 * 已知差异
 * ------
 * 元素名保持**小写**（htmlparser2 的原样），而浏览器 DOM 会把 HTML 标签名大写。
 * XPath 的名称匹配是大小写敏感的，所以 `//div` 能用，`//DIV` 不能 ——
 * 书源里都是小写写法，这个差异可以接受。
 */

import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'

import xpath from 'xpath'

type RawNode = any

const ELEMENT_NODE = 1
const ATTRIBUTE_NODE = 2
const TEXT_NODE = 3
const CDATA_NODE = 4
const PROCESSING_INSTRUCTION_NODE = 7
const COMMENT_NODE = 8
const DOCUMENT_NODE = 9

/** 规则用到了本实现不支持的 XPath 写法时抛这个 */
export class XPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XPathError'
  }
}

/** 带 `item()` 的类数组 —— 老式 XPath 实现会按 DOM 1 的 NodeList 接口访问 */
type NodeListLike<T> = T[] & { item(index: number): T | null }

function asNodeList<T>(items: T[]): NodeListLike<T> {
  const list = items as NodeListLike<T>
  Object.defineProperty(list, 'item', {
    value: (index: number) => list[index] ?? null,
    enumerable: false,
  })
  return list
}

function rawTypeOf(raw: RawNode): number {
  switch (raw?.type) {
    case 'tag':
    case 'script':
    case 'style':
      return ELEMENT_NODE
    case 'text':
      return TEXT_NODE
    case 'comment':
      return COMMENT_NODE
    case 'root':
      return DOCUMENT_NODE
    case 'cdata':
      return CDATA_NODE
    case 'directive':
      return PROCESSING_INSTRUCTION_NODE
    default:
      return ELEMENT_NODE
  }
}

function nameOf(raw: RawNode): string {
  switch (rawTypeOf(raw)) {
    case ELEMENT_NODE:
      return String(raw.name ?? '')
    case TEXT_NODE:
      return '#text'
    case COMMENT_NODE:
      return '#comment'
    case DOCUMENT_NODE:
      return '#document'
    case CDATA_NODE:
      return '#cdata-section'
    case PROCESSING_INSTRUCTION_NODE:
      return String(raw.name ?? '#processing-instruction')
    default:
      return ''
  }
}

/**
 * 视图对象：把 domhandler 的节点包装成 W3C DOM 形状
 *
 * 用类 + 原型 getter，而不是给每个节点挂闭包，这样节点多的时候也不会爆炸。
 * 视图本身由 ViewFactory 缓存，保证**同一个原始节点始终对应同一个视图对象** ——
 * XPath 实现会用对象标识判断节点是否相同，视图不稳定会让 `is()` 之类的判断出错。
 */
class XView {
  readonly raw: RawNode
  private readonly factory: ViewFactory

  constructor(raw: RawNode, factory: ViewFactory) {
    this.raw = raw
    this.factory = factory
  }

  get nodeType(): number {
    return rawTypeOf(this.raw)
  }

  get nodeName(): string {
    return nameOf(this.raw)
  }

  get localName(): string {
    return this.nodeType === ELEMENT_NODE ? String(this.raw.name ?? '') : this.nodeName
  }

  /** 这里不支持命名空间，一律返回 null */
  get prefix(): string | null {
    return null
  }

  get namespaceURI(): string | null {
    return null
  }

  get nodeValue(): string | null {
    const t = this.nodeType
    if (t === TEXT_NODE || t === COMMENT_NODE) return String(this.raw.data ?? '')
    return null
  }

  get data(): string | null {
    return this.nodeValue
  }

  get ownerDocument(): XView {
    return this.factory.documentView()
  }

  get parentNode(): XView | null {
    return this.raw.parent ? this.factory.view(this.raw.parent) : null
  }

  get childNodes(): NodeListLike<XView> {
    const children: RawNode[] = Array.isArray(this.raw.children) ? this.raw.children : []
    return asNodeList(children.map((c) => this.factory.view(c)))
  }

  get firstChild(): XView | null {
    const children: RawNode[] = Array.isArray(this.raw.children) ? this.raw.children : []
    return children.length > 0 ? this.factory.view(children[0]) : null
  }

  get lastChild(): XView | null {
    const children: RawNode[] = Array.isArray(this.raw.children) ? this.raw.children : []
    return children.length > 0 ? this.factory.view(children[children.length - 1]) : null
  }

  get nextSibling(): XView | null {
    return this.raw.next ? this.factory.view(this.raw.next) : null
  }

  get previousSibling(): XView | null {
    return this.raw.prev ? this.factory.view(this.raw.prev) : null
  }

  get attributes(): NodeListLike<XAttrView> | null {
    if (this.nodeType !== ELEMENT_NODE) return null
    return this.factory.attributesOf(this.raw)
  }

  get tagName(): string {
    return nameOf(this.raw)
  }

  /** 只有文档节点会用到；按 DOM 规范返回根元素 */
  get documentElement(): XView | null {
    if (this.nodeType !== DOCUMENT_NODE) return null
    const children: RawNode[] = Array.isArray(this.raw.children) ? this.raw.children : []
    const first = children.find((c) => rawTypeOf(c) === ELEMENT_NODE)
    return first ? this.factory.view(first) : null
  }

  /**
   * 命名空间查询
   *
   * 不做命名空间解析：HTML 书源里不会出现带前缀的 XPath。
   * 但这个方法必须存在，XPath 实现会在构造解析器时访问它。
   */
  lookupNamespaceURI(): string | null {
    return null
  }

  /**
   * 遍历后代元素
   *
   * `xpath` 包在缺少 `ownerDocument` 上更完善的接口时，会退化成用
   * `getElementsByTagName('*')` 来找元素，所以这个方法必须实现。
   */
  getElementsByTagName(name: string): NodeListLike<XView> {
    const wanted = String(name)
    const matched: XView[] = []
    const walk = (raw: RawNode): void => {
      for (const child of (raw?.children ?? []) as RawNode[]) {
        if (rawTypeOf(child) === ELEMENT_NODE) {
          if (wanted === '*' || String(child.name ?? '') === wanted) {
            matched.push(this.factory.view(child))
          }
        }
        walk(child)
      }
    }
    walk(this.raw)
    return asNodeList(matched)
  }
}

/** 属性视图：把 `attribs` 里的键值对包装成 DOM 属性节点 */
class XAttrView {
  readonly raw: RawNode
  readonly name: string
  readonly value: string
  private readonly owner: XView
  private readonly factory: ViewFactory

  constructor(raw: RawNode, name: string, value: string, owner: XView, factory: ViewFactory) {
    this.raw = raw
    this.name = name
    this.value = value
    this.owner = owner
    this.factory = factory
  }

  get nodeType(): number {
    return ATTRIBUTE_NODE
  }

  get nodeName(): string {
    return this.name
  }

  get localName(): string {
    return this.name
  }

  get prefix(): string | null {
    return null
  }

  get namespaceURI(): string | null {
    return null
  }

  get nodeValue(): string {
    return this.value
  }

  get ownerElement(): XView {
    return this.owner
  }

  get ownerDocument(): XView {
    return this.factory.documentView()
  }

  /** 属性节点没有子节点，但 XPath 实现做文档序比较时会访问它 */
  get childNodes(): NodeListLike<XView> {
    return asNodeList([])
  }

  get specified(): boolean {
    return true
  }
}

/**
 * 视图工厂
 *
 * 用 WeakMap 缓存：同一个原始节点永远拿到同一个视图对象。
 * 缓存键是请求内的临时对象，随请求一起被回收，不会跨请求残留状态。
 */
class ViewFactory {
  private readonly views = new WeakMap<object, XView>()
  private readonly attrLists = new WeakMap<object, NodeListLike<XAttrView>>()
  private readonly docRaw: RawNode
  private docView: XView | null = null

  constructor(docRaw: RawNode) {
    this.docRaw = docRaw
  }

  view(raw: RawNode): XView {
    if (!raw || typeof raw !== 'object') {
      // 兜底：不该发生，但别让一个畸形节点把整条规则炸掉
      return new XView({ type: 'root', children: [] }, this)
    }
    let view = this.views.get(raw)
    if (!view) {
      view = new XView(raw, this)
      this.views.set(raw, view)
    }
    return view
  }

  documentView(): XView {
    this.docView ??= this.view(this.docRaw)
    return this.docView
  }

  attributesOf(element: RawNode): NodeListLike<XAttrView> {
    let list = this.attrLists.get(element)
    if (list) return list

    const attribs = (element?.attribs ?? {}) as Record<string, string>
    const attrs = Object.entries(attribs).map(
      ([name, value]) => new XAttrView(element, name, String(value), this.view(element), this),
    )
    list = asNodeList(attrs)
    this.attrLists.set(element, list)
    return list
  }
}

export type XPathOutcome = { kind: 'nodes'; nodes: RawNode[] } | { kind: 'scalar'; value: string }

/**
 * 执行一条 XPath 表达式
 *
 * 返回节点集合或标量：表达式选的是节点（`//div`）就给节点，
 * 是 `string(...)` / `count(...)` 这类就给出标量字符串。
 *
 * @param contextRaw 上下文节点。省略时以整个文档为上下文。
 *                   传入子节点时，`//x` 这类绝对路径**不会**自动变成相对路径 ——
 *                   调用方需要自己决定（见 analyze.ts 里的说明）。
 */
export function runXPath($: CheerioAPI, expression: string, contextRaw?: RawNode): XPathOutcome {
  const factory = new ViewFactory($.root()[0] as RawNode)
  const context = contextRaw ? factory.view(contextRaw) : factory.documentView()

  let result: unknown
  try {
    result = xpath.select(expression, context as never)
  } catch (err) {
    throw new XPathError(
      `XPath 执行失败：${expression.slice(0, 80)}（${err instanceof Error ? err.message : String(err)}）`,
    )
  }

  if (Array.isArray(result)) {
    const nodes: RawNode[] = []
    for (const item of result) {
      if (item instanceof XView) nodes.push(item.raw)
      else if (item instanceof XAttrView) nodes.push(item) // 属性节点没有对应的原始节点，原样带出
    }
    return { kind: 'nodes', nodes }
  }

  return { kind: 'scalar', value: result === null || result === undefined ? '' : String(result) }
}

/** 判断某个结果是不是属性视图（取值时要走 `.value` 而不是节点文本） */
export function isAttributeView(node: unknown): node is XAttrView {
  return node instanceof XAttrView
}
