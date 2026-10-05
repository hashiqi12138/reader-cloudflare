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

/**
 * 「数据元素」：内容原样保留、不当 HTML 解析的那几个标签
 *
 * jsoup 用它实现 `Element.data()`（见下面 `case 'data'`），
 * 也用它判断 `<script>` / `<style>` 里的东西该不该被当成正文文本。
 */
const DATA_TAGS = new Set(['script', 'style'])

interface Handle {
    $: CheerioAPI
    nodes: Node[]
}

export type JsoupReply =
    | { ok: true; kind: 'handle'; handle: number | null }
    | { ok: true; kind: 'value'; value: unknown }
    /**
     * 一次把整串节点**连同各自的 `outerHTML`（以及顺手能拿到的字段）**交出去
     *
     * 这是唯一一种「复合」回复：`__listOf` 过去要靠 `size` + 每个元素 `get` + `outerHtml`
     * 三次往返才能拼出一个元素数组，而元素一多（一次 `select` 出几百个节点）那几百上千次
     * 往返就是实打实的耗时。`handle` 与 `html` 一起回传，往返降到一次。
     *
     * 第七十七轮又顺手多带了两样，都是**零成本**的（不需要额外走一遍树）：
     *
     *   - `attrs`：cheerio 解析时就已经在 `node.attribs` 里。带上它之后沙箱侧
     *     `e.attr('href')` / `hasAttr` / `className` / `id` / `val` 都不用再过桥 ——
     *     而这几个是「逐节点取字段」里最集中的一批。
     *   - `text`：**只在节点没有元素子节点时**给（那时文本就是几个直接文本子节点拼起来，
     *     也是零成本）。有元素子节点的（整块容器）留 `null`、按需过桥 —— 免得为一个
     *     从不读 `text` 的脚本白走一遍子树。
     */
    | {
          ok: true
          kind: 'list'
          items: {
              handle: number
              html: string
              /** 属性表（原样来自 `node.attribs`，顺序即书写顺序） */
              attrs: Record<string, string>
              /** 归一化后的文本；`null` = 没预取（有元素子节点），要的话得过桥 */
              text: string | null
          }[]
      }
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

    /** 开一个新句柄（不经过 `put` 那层回复包装，`list` 要一次开一串） */
    private alloc(handle: Handle): number {
        const id = (this.seq += 1)
        this.store.set(id, handle)
        return id
    }

    private put(handle: Handle | null): JsoupReply {
        if (handle === null) return { ok: true, kind: 'handle', handle: null }
        return { ok: true, kind: 'handle', handle: this.alloc(handle) }
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
            /**
             * `list`：把整串节点**连同各自的 `outerHTML`、属性表、叶节点的文本**一次交出去
             *
             * 沙箱侧的 `__listOf` 要把一个集合变成「数组形态的 Elements」（每项是
             * 「自己的 HTML + 作用在自己身上的 jsoup 方法」）。按老写法它得先问 `size`，
             * 再对每个元素 `get(i)`（开句柄）+ `outerHtml`（取 HTML）—— **每个元素两次往返**。
             * 🎨漫画搬运 的目录 459 个条目就是 919 次，而每次往返都要过一遍 JSON，
             * 实测每条约 2.35ms（第七十四轮量过）。
             *
             * 这里把三件事在**宿主侧一次做完**：开句柄是纯内存操作、取 HTML 是纯 cheerio 调用，
             * 都不需要过桥 —— 于是 n 个元素从 `1 + 2n` 次往返降到 **1 次**。
             *
             * 第七十七轮再多带两样**顺手**的（见 `JsoupReply` 里那段说明）：
             * `attrs`（cheerio 早就解析好了）与「叶节点的文本」。带上它们之后，
             * 脚本里最常见的「逐节点取 `attr('href')` / `text()`」也一并免了过桥 ——
             * 这一批在实测里占剩余的多数（见 README 第七十七轮）。
             *
             * 注意这不是「懒序列化」：调用它的地方（`__listOf`）本来就要把每个元素都串化
             * （书源会直接 `String(x)` / `x.includes('<h3')`），懒不到什么。
             * 这个 op 只有沙箱内部用，不是方法面上的成员（见 test/jsoupSurface.test.ts）。
             */
            case 'list': {
                const items = handle.nodes.map((node) => {
                    const $node = handle.$(node)
                    const kids = (node?.children ?? []) as Node[]
                    return {
                        handle: this.alloc({ $: handle.$, nodes: [node] }),
                        // 与 `outerHtml` 那个 op 对**单节点**句柄的取值完全一致
                        html: $node.prop('outerHTML') ?? '',
                        // 属性表：就是解析时留下的那一份，交出去零成本
                        attrs: (node?.attribs ?? {}) as Record<string, string>,
                        // 文本只在**没有元素子节点**时预取：那时它就是几个直接文本子节点
                        // 拼起来（零成本）；整块容器留 null，让按需那条路过桥
                        text: kids.some(isElement) ? null : normalizeSpace($node.text()),
                    }
                })
                return { ok: true, kind: 'list', items }
            }
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
            /**
             * `selectFirst(css)` —— jsoup 的 `Element.selectFirst` / `Elements.selectFirst`
             *
             * 与 `select` 同一件事，只是**只取第一个**。线上一共 5 处，
             * 形状是 `doc.selectFirst("#pager a:contains(末页)")`、
             * `result.selectFirst("a")`、`doc.selectFirst('.chaptercount')` 这一类。
             * 少了它，脚本拿到的是 `TypeError: not a function` —— 报错行号指向规则里那一行，
             * 看着像书源写错了，其实是我们这一侧没这个 op。
             */
            case 'selectFirst': {
                const css = str(0)
                try {
                    const hit = handle.$(handle.nodes).find(css).toArray().filter(isElement)
                    return this.put(
                        hit.length > 0 ? { $: handle.$, nodes: [hit[0] as Node] } : null,
                    )
                } catch {
                    return this.put(null)
                }
            }
            /**
             * `data()` —— jsoup 的 `Element.data()`：`<script>` / `<style>` 这类
             * **数据元素**里的内容（不是它们的子节点文本，是整段原始内容）
             *
             * 线上 📂少年小说网 的目录规则正是拿它把 `<style>` 里的隐藏规则读出来当选择器：
             *
             *     a = org.jsoup.Jsoup.parse(result)
             *     b = String(a.select("style").first().data()).replace(/{display:none}/g, ",").slice(0, -1)
             *     a.select(b).remove()
             *
             * 以前**桥里根本没有这个 op**，于是调用在沙箱那一侧就炸了
             * （`not a function`），连桥的 `default:` 那句「还不支持的方法：xxx()」都说不上 ——
             * 这是最坏的一种失败：既不是选择器错，也不是「明确不支持」，无从下手。
             *
             * 语义按 jsoup：自己就是数据元素时给它的内容；否则只往下看**一层**，
             * 取直接子节点里那些数据元素的内容。注释不带进来（jsoup 会带，
             * 但注释混进 CSS 只会把选择器弄坏）。
             */
            case 'data': {
                let out = ''
                for (const node of handle.nodes) {
                    if (!isElement(node)) continue
                    const own = String(node.name ?? '').toLowerCase()
                    if (DATA_TAGS.has(own)) {
                        out += handle.$(node).text()
                        continue
                    }
                    for (const child of (node.children ?? []) as Node[]) {
                        const tag = String(child?.name ?? '').toLowerCase()
                        if (child?.type === 'tag' && DATA_TAGS.has(tag))
                            out += handle.$(child).text()
                    }
                }
                return this.value(out)
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
            /**
             * `text`：**按参数个数**分派读与写（第七十八轮，与 `attr` 同一个理由）
             *
             * `text(String)` 是写（jsoup 的 `Element.text(String)`）。语料里**没人**这么写，
             * 但既然 `attr` 那一路要按个数分，这里不分就会留下同一个坑：
             * `x.text('新')` 静默返回旧文本。
             */
            case 'text': {
                if (args.length > 0) {
                    const node = this.one(handle)
                    if (node) handle.$(node).text(String(args[0] ?? ''))
                    return this.value(null)
                }
                return this.value(normalizeSpace(handle.$(handle.nodes).text()))
            }
            case 'ownText':
                return this.value(normalizeSpace(handle.nodes.map((n) => ownTextOf(n)).join('')))
            case 'textNodes':
                return this.value(handle.nodes.flatMap((n) => textNodesOf(n)))
            case 'eachText':
                return this.value(handle.nodes.map((n) => normalizeSpace(handle.$(n).text())))
            /**
             * `html`：同样按参数个数分派（`html()` 读内层 HTML、`html(串)` 是写）
             */
            case 'html': {
                const node = this.one(handle)
                if (args.length > 0) {
                    if (node) handle.$(node).html(String(args[0] ?? ''))
                    return this.value(null)
                }
                return this.value((node ? handle.$(node).html() : '') ?? '')
            }
            case 'outerHtml':
            case 'toString':
                return this.value(
                    handle.nodes.map((n) => handle.$(n).prop('outerHTML') ?? '').join('\n'),
                )
            /**
             * `attr`：**按参数个数**分派「读」与「写」（第七十八轮）
             *
             * jsoup 里 `attr(String)` 与 `attr(String, String)` 是两个同名重载；
             * 桥这边只有 `args` 一个线索，所以按 `args.length` 分。以前无论几个参数都走读，
             * 于是 `attr("src", 新值)` **静默返回旧值** —— 🎨笔趣漫画 正好踩在这上面。
             *
             * 取**第一个**节点，与 `hasAttr` / `val` / `className` 一致。
             */
            case 'attr': {
                const node = this.one(handle)
                if (args.length > 1) {
                    if (!node) return this.value(null)
                    handle.$(node).attr(str(0), String(args[1] ?? ''))
                    return this.value(null)
                }
                if (!node) return this.value('')
                return this.value(handle.$(node).attr(str(0)) ?? '')
            }
            case 'hasAttr': {
                const node = this.one(handle)
                if (!node) return this.value(false)
                return this.value(handle.$(node).attr(str(0)) !== undefined)
            }
            /**
             * `attributes()` —— jsoup 的 `Element.attributes()`（返回一个 `Attributes`）
             *
             * 线上 1 处：📂贝壳读书 的目录规则要从属性里**按序号**取值 ——
             *
             *     let b = Array.from(a.selectFirst(ys).attributes())
             *     return b[num - 1]?.toString().match(/"(.+)"\/)?.[1]
             *
             * 也就是说它要的是「第 n 个属性」加上 `Attribute.toString()` 那个 `key="value"` 形状。
             * 以前桥里没这个 op，于是报的是 `attributes is not a function` ——
             * 报错行号指向规则里的那一行，看着像书源写错了。
             *
             * 这里只把**键值对**交出去，Attribute 那层方法（`getKey` / `getValue` /
             * `toString`）由沙箱侧补（见 js.ts 的 `__attrList`）：宿主不该知道
             * 脚本会拿它当什么用，而值形态是最小、最不需要维护的契约。
             *
             * 取**第一个**节点，与 `attr` / `hasAttr` / `val` / `className` 一致
             * （jsoup 的 `Elements` 没有 `attributes()`，能走到这里的都是 `selectFirst` 出来的单个元素）。
             */
            case 'attributes': {
                const node = this.one(handle)
                if (!node) return this.value([])
                const attribs = (node.attribs ?? {}) as Record<string, string>
                return this.value(Object.entries(attribs).map(([key, value]) => ({ key, value })))
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
             * `remove()`：**真删**
             *
             * 以前它与下面那几个写操作一起被当成「无操作」，理由是「节点集是宿主侧共享
             * 对象，改它会串到同一份文档的其它句柄上」。那个理由反了：jsoup 里
             * `a.select(b).remove()` 之后再 `a.html()`，**本来就该**少那一块 ——
             * 串过去正是书源要的效果。📂少年小说网 的目录规则就是这么写的：
             * 先从 `<style>` 里把那些 `{display:none}` 的 `li:nth-child(...)` 读出来当选择器，
             * 删掉它们，剩下的 `ul.row li a` 才是这一页真正的章节。
             *
             * 当成无操作的结果是列表里混进一堆本该被删掉的「最新章」——**不报错**，
             * 只是顺序看着是倒的、章节数还偏多（见 README 第七十三轮）。
             *
             * 其余写操作仍按无操作处理：语料里它们只是「顺手清理」，
             * 没有一条规则依赖改完之后再读回来。
             */
            case 'remove':
                handle.$(handle.nodes).remove()
                return this.value(null)
            /**
             * 其余写操作：第七十八轮起也**真改**（以前与 `remove` 一起当无操作）
             *
             * 语料里只有一个真实消费者 —— 🎨笔趣漫画 的正文规则：
             *
             *     imgs = java.getElements(".rd-article-wr img")
             *     imgs.forEach(e => { e.attr("src", e.attr("data-original")) })
             *     imgs
             *
             * 它把真图地址从 `data-original` 搬到 `src`，之后再抽正文里的图片。
             * 当成无操作的话 `src` 一直是懒加载占位图 —— **不报错**，只是每一张图都错。
             *
             * `addClass` / `removeClass` / `append` / `prepend`（以及 `html(串)` / `text(串)`）
             * 语料里**一处都没用**（第七十八轮把手上那份含发现页的导出 594 条全量扫过：
             * 这四个方法各 0 处、`attr(k, v)` 只有 🎨笔趣漫画 一处）。实现它们不是为了修谁，
             * 而是不再留「静默无操作」这个坑：谁哪天写了 `append(...)` 再取回来，
             * 拿到的是**改过之后**的那一份，而不是一个不报错的旧值。
             *
             * 与 `remove()` 同一个取舍：改的是宿主侧共享的节点，会串到同一份文档的
             * 其它句柄上 —— 那正是书源要的效果（见 `remove` 上面那段）。
             */
            case 'addClass':
                handle.$(handle.nodes).addClass(str(0))
                return this.value(null)
            case 'removeClass':
                handle.$(handle.nodes).removeClass(str(0))
                return this.value(null)
            case 'append':
                handle.$(handle.nodes).append(str(0))
                return this.value(null)
            case 'prepend':
                handle.$(handle.nodes).prepend(str(0))
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
