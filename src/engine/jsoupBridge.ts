/**
 * `org.jsoup` 的桥
 *
 * 线上 594 条带发现页的书源里，`org.jsoup` 出现 126 次 —— 是 `source` 之后第二常用的
 * 未实现能力。书源的写法是**把整页 HTML 交给 jsoup 解析，再用选择器挨个取**：
 *
 *   var page = org.jsoup.Jsoup.parse(java.ajax(url))
 *   var items = page.select('ul#filters li.sort-li')
 *   for (var i = 0; i < items.size(); i++) { var el = items.get(i); el.select('a').first().text() }
 *
 * 为什么走「宿主桥」而不是在沙箱里塞一个纯 JS 的 HTML 解析器
 * ---------------------------------------------------------
 * 沙箱里跑的是 QuickJS，没有 DOM。要在里面支持 `select` 就得自带一套 CSS 选择器引擎，
 * 那是几百行且必然与原版有偏差的代码。而宿主侧已经有 cheerio（规则引擎本来就在用），
 * 并且 **cheerio 的解析与查询全是同步的** —— 同步能力可以安全地通过
 * `vm.newFunction` 暴露给脚本，不受 asyncify「不能嵌套挂起」的限制。
 *
 * 代价是每次 `.text()` 之类都要过一次桥。对「几十个元素」这种量级可以忽略。
 *
 * 对象生命周期
 * -----------
 * 脚本里的 `Element` / `Elements` 在这边只是一个**整数句柄**，真正的节点集存在这张表里。
 * 表随沙箱一起销毁（见 `js.ts` 的 runInSandbox 每次新建 runtime），
 * 因此不会出现「上一个请求的节点被下一个请求读到」这种串味。
 *
 * 这里刻意**不做完整 jsoup**：只实现书源脚本真正会用到的那部分。
 * 遇到没实现的方法，桥会明确报出方法名，而不是静默返回空 ——
 * 后者会让书源表现成「规则跑通了但一本书都没有」，最难查。
 */

import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'

import { isElement } from './select'

/** 与 select.ts 保持一致：不从传递依赖 domhandler 里 import 类型 */
type Node = any

interface Handle {
    $: CheerioAPI
    nodes: Node[]
}

export type JsoupReply =
    | { ok: true; kind: 'handle'; handle: number | null }
    | { ok: true; kind: 'value'; value: unknown }
    | { ok: false; error: string }

/** jsoup 的 `text()` 会把空白折叠成单个空格并去掉首尾，照它做 */
function normalizeSpace(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

/** 直接文本子节点（不含后代的文本），对应 jsoup 的 ownText */
function ownTextOf(node: Node): string {
    const children: Node[] = node?.children ?? []
    return children
        .filter((c) => c?.type === 'text')
        .map((c) => String(c.data ?? ''))
        .join('')
}

/** 子树里的文本节点，对应 jsoup 的 textNodes */
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

export class JsoupBridge {
    private store = new Map<number, Handle>()
    private seq = 0

    /** 执行一次桥调用；所有异常都收敛成 `{ok:false}`，由脚本侧抛出去 */
    run(op: string, handleId: number | null, args: unknown[]): JsoupReply {
        try {
            return this.dispatch(op, handleId, args)
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
    }

    private put(handle: Handle | null): JsoupReply {
        if (handle === null) return { ok: true, kind: 'handle', handle: null }
        const id = (this.seq += 1)
        this.store.set(id, handle)
        return { ok: true, kind: 'handle', handle: id }
    }

    private at(handleId: number | null): Handle {
        const handle = handleId === null ? undefined : this.store.get(handleId)
        if (!handle) throw new Error('jsoup 对象已失效（可能跨了一次脚本求值）')
        return handle
    }

    private value(value: unknown): JsoupReply {
        return { ok: true, kind: 'value', value }
    }

    /** 单个节点的取值操作统一走这里：没有节点时返回空值而不是报错 */
    private one(handle: Handle): Node | undefined {
        return handle.nodes[0]
    }

    private dispatch(op: string, handleId: number | null, args: unknown[]): JsoupReply {
        const str = (i: number): string =>
            args[i] === undefined || args[i] === null ? '' : String(args[i])
        const num = (i: number): number => Number(args[i] ?? 0)

        if (op === 'parse') {
            const html = str(0)
            const $ = cheerio.load(html)
            // 文档根节点：`$(root).find(css)` 就是「全文搜索」，与 jsoup 的 Document.select 一致
            return this.put({ $, nodes: $.root().toArray() as Node[] })
        }

        if (op === 'parseBodyFragment') {
            const $ = cheerio.load(str(0))
            return this.put({ $, nodes: $.root().children().toArray() as Node[] })
        }

        /**
         * 一次解析**多段** HTML，每段当成一个独立元素
         *
         * 给 `java.getElements(规则)` 用：宿主侧已经按规则命中了 N 个节点、
         * 把每个节点的 outerHTML 拿了出来，这里要的是「N 个元素」而不是「一段文档的子孙」。
         * 拼成一个文档再取根的子节点，正好得到这 N 个元素 ——
         * 做法简单，但必须共用同一个 cheerio 实例（句柄里只存一份 `$`）。
         */
        if (op === 'parseFragments') {
            const htmls = Array.isArray(args[0])
                ? (args[0] as unknown[]).map((v) => String(v ?? ''))
                : []
            // 外面套一层 <root>：这样「根元素的子节点」就是这 N 个片段本身，
            // 而不用去猜 cheerio 会不会把它们塞进隐含的 body 里、或互相嵌套
            const $ = cheerio.load(`<root>${htmls.join('\n')}</root>`)
            const nodes = $.root().find('root').children().toArray().filter(isElement)
            return this.put({ $, nodes })
        }

        if (op === 'clean') {
            const $ = cheerio.load(str(0))
            return this.value(normalizeSpace($.root().text()))
        }

        const handle = this.at(handleId)

        switch (op) {
            case 'select': {
                const css = str(0)
                try {
                    return this.put({
                        $: handle.$,
                        nodes: handle.$(handle.nodes).find(css).toArray() as Node[],
                    })
                } catch {
                    // 选择器写坏在书源里很常见：当作没匹配到，不要让整条规则崩掉
                    return this.put({ $: handle.$, nodes: [] })
                }
            }
            case 'size':
                return this.value(handle.nodes.length)
            case 'isEmpty':
                return this.value(handle.nodes.length === 0)
            case 'get': {
                const i = num(0)
                const node = i < 0 ? handle.nodes[handle.nodes.length + i] : handle.nodes[i]
                if (!node) return this.put(null)
                return this.put({ $: handle.$, nodes: [node] })
            }
            case 'eq': {
                const i = num(0)
                const node = handle.nodes[i]
                if (!node) return this.put(null)
                return this.put({ $: handle.$, nodes: [node] })
            }
            case 'first':
                return this.put(
                    handle.nodes.length ? { $: handle.$, nodes: [handle.nodes[0]] } : null,
                )
            case 'last':
                return this.put(
                    handle.nodes.length
                        ? { $: handle.$, nodes: [handle.nodes[handle.nodes.length - 1]] }
                        : null,
                )
            case 'text':
                return this.value(normalizeSpace(handle.$(handle.nodes).text()))
            case 'ownText':
                return this.value(normalizeSpace(handle.nodes.map((n) => ownTextOf(n)).join('')))
            case 'textNodes':
                return this.value(handle.nodes.flatMap((n) => textNodesOf(n)))
            case 'eachText':
                return this.value(handle.nodes.map((n) => normalizeSpace(handle.$(n).text())))
            case 'html':
                return this.value(
                    (this.one(handle) ? handle.$(this.one(handle) as Node).html() : '') ?? '',
                )
            case 'outerHtml':
            case 'toString':
                return this.value(
                    handle.nodes.map((n) => handle.$(n).prop('outerHTML') ?? '').join('\n'),
                )
            case 'attr': {
                const node = this.one(handle)
                if (!node) return this.value('')
                return this.value(handle.$(node).attr(str(0)) ?? '')
            }
            case 'hasAttr': {
                const node = this.one(handle)
                if (!node) return this.value(false)
                return this.value(handle.$(node).attr(str(0)) !== undefined)
            }
            case 'val':
                return this.value(this.attrOf(handle, 'value'))
            case 'className': {
                return this.value(this.attrOf(handle, 'class'))
            }
            case 'hasClass': {
                const node = this.one(handle)
                if (!node) return this.value(false)
                return this.value(handle.$(node).hasClass(str(0)))
            }
            case 'tagName': {
                const node = this.one(handle)
                if (!node) return this.value('')
                // 走同一个 isElement：`<script>` / `<style>` 的 type 不是 'tag'，
                // 这里若自己判 `type === 'tag'`，脚本的 tagName 会变成 '#root'
                return this.value(isElement(node) ? String(node.name ?? '') : '#root')
            }
            case 'id':
                return this.value(this.attrOf(handle, 'id'))
            case 'index': {
                const node = this.one(handle)
                if (!node) return this.value(0)
                return this.value(handle.$(node).index())
            }
            case 'children': {
                const nodes: Node[] = []
                for (const n of handle.nodes)
                    nodes.push(...((n?.children ?? []) as Node[]).filter(isElement))
                return this.put({ $: handle.$, nodes })
            }
            case 'child': {
                const i = num(0)
                const nodes: Node[] = []
                for (const n of handle.nodes) {
                    const kids = ((n?.children ?? []) as Node[]).filter(isElement)
                    const picked = i < 0 ? kids[kids.length + i] : kids[i]
                    if (picked) nodes.push(picked)
                }
                return this.put({ $: handle.$, nodes })
            }
            case 'childNodeSize': {
                const node = this.one(handle)
                return this.value(node ? ((node.children ?? []) as Node[]).length : 0)
            }
            case 'parent': {
                const nodes: Node[] = []
                for (const n of handle.nodes) {
                    const parent = handle.$(n).parent().get(0)
                    if (parent) nodes.push(parent)
                }
                return this.put({ $: handle.$, nodes })
            }
            case 'parents': {
                const nodes: Node[] = []
                for (const n of handle.nodes)
                    nodes.push(...(handle.$(n).parents().toArray() as Node[]))
                return this.put({ $: handle.$, nodes })
            }
            case 'siblingElements': {
                const nodes: Node[] = []
                for (const n of handle.nodes)
                    nodes.push(...(handle.$(n).siblings().toArray() as Node[]).filter(isElement))
                return this.put({ $: handle.$, nodes })
            }
            case 'nextElementSibling': {
                const nodes: Node[] = []
                for (const n of handle.nodes) {
                    const next = handle.$(n).next().get(0)
                    if (next) nodes.push(next)
                }
                return this.put({ $: handle.$, nodes })
            }
            case 'prevElementSibling': {
                const nodes: Node[] = []
                for (const n of handle.nodes) {
                    const prev = handle.$(n).prev().get(0)
                    if (prev) nodes.push(prev)
                }
                return this.put({ $: handle.$, nodes })
            }
            case 'nextAll': {
                const nodes: Node[] = []
                for (const n of handle.nodes)
                    nodes.push(...(handle.$(n).nextAll().toArray() as Node[]))
                return this.put({ $: handle.$, nodes })
            }
            case 'prevAll': {
                const nodes: Node[] = []
                for (const n of handle.nodes)
                    nodes.push(...(handle.$(n).prevAll().toArray() as Node[]))
                return this.put({ $: handle.$, nodes })
            }
            case 'not': {
                try {
                    return this.put({
                        $: handle.$,
                        nodes: handle.$(handle.nodes).not(str(0)).toArray() as Node[],
                    })
                } catch {
                    return this.put(handle)
                }
            }
            case 'filter': {
                try {
                    return this.put({
                        $: handle.$,
                        nodes: handle.$(handle.nodes).filter(str(0)).toArray() as Node[],
                    })
                } catch {
                    return this.put(handle)
                }
            }
            case 'clone':
                return this.put({ $: handle.$, nodes: [...handle.nodes] })
            case 'has':
                return this.value(handle.nodes.some((n) => handle.$(n).find(str(0)).length > 0))
            case 'is': {
                try {
                    return this.value(handle.$(handle.nodes).is(str(0)))
                } catch {
                    return this.value(false)
                }
            }
            case 'matches': {
                const re = safeRegex(str(0))
                return this.value(
                    re ? re.test(normalizeSpace(handle.$(handle.nodes).text())) : false,
                )
            }
            case 'matchesOwn': {
                const re = safeRegex(str(0))
                const text = handle.nodes.map((n) => ownTextOf(n)).join('')
                return this.value(re ? re.test(normalizeSpace(text)) : false)
            }
            /**
             * 只读引擎：`remove()` / `attr(k,v)` 这类会改文档的操作**不能实现**，
             * 因为这里的节点集是宿主侧的共享对象，改它会串到同一份文档的其它句柄上
             * （jsoup 在 Java 里是深拷贝语义，行为对不上反而更危险）。
             * 书源里这类调用几乎都是「顺手清理」，直接当无操作处理并说明原因。
             */
            case 'remove':
            case 'attrSet':
            case 'addClass':
            case 'removeClass':
            case 'append':
            case 'prepend':
                return this.value(null)
            default:
                throw new Error(`org.jsoup 还不支持的方法：${op}()`)
        }
    }

    private attrOf(handle: Handle, name: string): string {
        const node = this.one(handle)
        if (!node) return ''
        return handle.$(node).attr(name) ?? ''
    }
}

/** 书源里给的常常是 Java 风格的正则字符串，编译失败时按「不匹配」处理 */
function safeRegex(pattern: string): RegExp | null {
    if (pattern === '') return null
    try {
        return new RegExp(pattern)
    } catch {
        return null
    }
}
