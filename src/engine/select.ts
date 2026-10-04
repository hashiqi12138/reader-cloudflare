/**
 * 用 cheerio 执行 JSOUP 计划
 *
 * 与 jsoup.ts 的分工：那边只做「规则 → 计划」的翻译，这边只做「计划 → 节点/文本」的执行。
 * 分开的好处是解析部分可以脱离 cheerio 单测。
 */

import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'

import { applyIndex, type JsoupStep } from './jsoup'

/** cheerio 的节点类型，避免直接从传递依赖 domhandler 里 import */
type Node = ReturnType<CheerioAPI> extends infer _ ? any : never

export function parseHtml(html: string): CheerioAPI {
    return cheerio.load(html)
}

/** CSS 标识符转义：class/id 里出现 `:`、`.`、空格等字符时必须转义 */
function cssEscapeIdent(name: string): string {
    return name.replace(/([^\w-])/g, '\\$1')
}

function stepToCss(step: JsoupStep): string | null {
    switch (step.by) {
        case 'class':
            return step.name ? `.${cssEscapeIdent(step.name)}` : null
        case 'id':
            return step.name ? `#${cssEscapeIdent(step.name)}` : null
        case 'tag':
            return step.name || null
        default:
            return null
    }
}

/**
 * 是不是一个「元素」节点
 *
 * **`<script>` 与 `<style>` 也是元素** —— domhandler 把它们的 `type` 记成
 * `'script'` / `'style'`，而不是 `'tag'`。XPath 那一侧早就分开处理了
 * （见 `xpath.ts` 的 `rawTypeOf`），CSS / JSOUP 这一侧漏了，于是它们被**静默丢掉**：
 *
 *   - `java.getElements('script')` 永远 0 条 → `java.getElement('script')` 给 `null`。
 *     🎨51漫画 的目录规则正是 `Array.from(java.getElement("script"))`，
 *     拿到 null 直接抛 `cannot read property 'Symbol.iterator' of null`，整本书打不开。
 *   - `children` / `child` 两步走**直接子节点**时会跳过脚本与样式
 *     （`find` 走的是后代，一直是对的）。
 *
 * 判据与 `xpath.ts` 的 `ELEMENT_NODE` 那几个 case 保持同一份。
 */
export function isElement(node: Node): boolean {
    return (
        Boolean(node) &&
        typeof node === 'object' &&
        (node.type === 'tag' || node.type === 'script' || node.type === 'style')
    )
}

function childElements(node: Node): Node[] {
    const children: Node[] = node?.children ?? []
    return children.filter(isElement)
}

/** 所有后代元素（不含自身） */
function descendantElements($: CheerioAPI, node: Node): Node[] {
    try {
        return $(node).find('*').toArray() as Node[]
    } catch {
        return []
    }
}

/** 直接文本子节点拼起来 —— 用于 `ownText`，也用于按文本定位元素 */
function ownTextOf(node: Node): string {
    const children: Node[] = node?.children ?? []
    return children
        .filter((c) => c?.type === 'text')
        .map((c) => String(c.data ?? ''))
        .join('')
}

/** 子树里所有文本节点，各自保留 —— `textNodes` 要的就是这个粒度 */
function textNodesOf(node: Node): string[] {
    const out: string[] = []
    const walk = (n: Node): void => {
        for (const child of (n?.children ?? []) as Node[]) {
            if (child?.type === 'text') out.push(String(child.data ?? ''))
            else if (child?.children) walk(child)
        }
    }
    walk(node)
    return out
}

/**
 * 按文本内容定位元素（Legado 的 `text.xxx` 语法）
 *
 * 先按「自身文本」匹配：这样 `text.下一页` 命中的是那个链接，
 * 而不是包住整个列表的容器。都没有命中时再放宽到整棵子树的文本。
 */
function findByText($: CheerioAPI, node: Node, text: string): Node[] {
    if (!text) return []
    const candidates = descendantElements($, node)

    const strict = candidates.filter((el) => ownTextOf(el).includes(text))
    if (strict.length > 0) return strict

    return candidates.filter((el) => $(el).text().includes(text))
}

/** 逐级筛选节点 */
export function selectNodes($: CheerioAPI, start: Node[], steps: JsoupStep[]): Node[] {
    let nodes = start
    for (const step of steps) {
        let next: Node[] = []

        switch (step.by) {
            case 'children': {
                for (const n of nodes) next.push(...childElements(n))
                break
            }
            case 'text': {
                for (const n of nodes) next.push(...findByText($, n, step.name))
                break
            }
            default: {
                const selector = stepToCss(step)
                if (!selector) break
                for (const n of nodes) {
                    try {
                        next.push(...($(n).find(selector).toArray() as Node[]))
                    } catch {
                        // 单个选择器写错不该让整条规则崩掉
                    }
                }
                break
            }
        }

        nodes = applyIndex(next, step.index)
    }
    return nodes
}

/**
 * 从节点里取值
 *
 * `textNodes` 会展开成多个值（每个文本节点一个），其它取值一个节点一个值。
 * 这个区别很重要：正文规则常写成 `id.txtContent@textNodes`，
 * 展开后才能按段落拼回来。
 */
export function extractValues($: CheerioAPI, nodes: Node[], kind: string): string[] {
    const out: string[] = []

    for (const node of nodes) {
        switch (kind) {
            case 'text':
                out.push($(node).text().trim())
                break
            case 'ownText':
                out.push(ownTextOf(node).trim())
                break
            case 'textNodes':
                for (const t of textNodesOf(node)) {
                    const v = t.trim()
                    if (v) out.push(v)
                }
                break
            case 'html':
                out.push(($(node).html() ?? '').trim())
                break
            case 'outerHtml':
            case 'all':
                out.push(($.html(node) ?? '').trim())
                break
            default: {
                // 其余一律当属性名处理（href / src / value / content / data-xxx ...）
                const attr = $(node).attr(kind)
                out.push((attr ?? '').trim())
                break
            }
        }
    }

    return out
}

/** 把 HTML 片段重新解析成节点集，供 `<js>` 链的中间结果继续被规则筛选 */
export function reparseFragment(html: string): { $: CheerioAPI; nodes: Node[] } {
    const $ = cheerio.load(html)
    return { $, nodes: $.root().children().toArray() as Node[] }
}
