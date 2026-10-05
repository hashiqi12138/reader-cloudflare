import { describe, expect, it } from 'vitest'

import { JsoupBridge } from '../src/engine/jsoupBridge'

/**
 * `org.jsoup` 桥的单元测试
 *
 * 这层能脱离 QuickJS-WASM 单测，是因为桥的契约就是「整数句柄 + op 名」，
 * 宿主侧实际的解析由 cheerio 完成 —— 而 cheerio 在 Node 里能跑。
 * 沙箱那侧只是把 op 名映射成方法调用（见 engine/js.ts 的 JS_METHODS）。
 *
 * 用例形态全部取自真实书源：
 *   - 哔哩轻小说的目录规则 `doc.select('ul.volume-chapters li.chapter-li:not(.volume-cover)')`
 *   - 爱丽丝书屋的 `Jsoup.parse(html).select('.group , .user-data li')`
 *   - 霹雳书屋的 `page.select('ul#filters li.sort-li')` + `.get(i).select('a')`
 */

const HTML = `<html><body>
<ul id="filters">
  <li class="sort-li"><h3 class="sort-li-title">类型</h3>
    <a class="btn-tag jsTag" data-filter-type="tagid" data-filter-value="1">都市</a>
    <a class="btn-tag jsTag" data-filter-type="typeid" data-filter-value="9">校园</a>
  </li>
  <li class="sort-li"><h3 class="sort-li-title">状态</h3>
    <a class="btn-tag jsTag" data-filter-type="isfull" data-filter-value="1">完结</a>
  </li>
</ul>
<ul class="volume-chapters">
  <li class="chapter-li volume-cover"><a href="/cover">封面</a></li>
  <li class="chapter-li"><a href="/c1">第一章</a></li>
  <li class="chapter-li"><a href="/c2">第二章</a></li>
</ul>
<div class="book-desc">简介：<b>一本</b>书</div>
</body></html>`

function handleOf(bridge: JsoupBridge): number {
    const reply = bridge.run('parse', null, [HTML])
    if (!reply.ok || reply.kind !== 'handle' || reply.handle === null) throw new Error('parse 失败')
    return reply.handle
}

/** 取字符串结果的简写；类型不对就直接失败，避免测试里到处写 as */
function value(bridge: JsoupBridge, op: string, handle: number, args: unknown[] = []): unknown {
    const reply = bridge.run(op, handle, args)
    if (!reply.ok) throw new Error(reply.error)
    if (reply.kind !== 'value') throw new Error(`${op} 应返回普通值`)
    return reply.value
}

function handle(bridge: JsoupBridge, op: string, from: number, args: unknown[] = []): number {
    const reply = bridge.run(op, from, args)
    if (!reply.ok) throw new Error(reply.error)
    if (reply.kind !== 'handle' || reply.handle === null) throw new Error(`${op} 应返回句柄`)
    return reply.handle
}

describe('org.jsoup 桥', () => {
    it('parse + select + size + 迭代 get 是书源最常用的那条路', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const groups = handle(bridge, 'select', doc, ['ul#filters li.sort-li'])
        expect(value(bridge, 'size', groups)).toBe(2)

        const first = handle(bridge, 'get', groups, [0])
        expect(value(bridge, 'text', handle(bridge, 'select', first, ['h3.sort-li-title']))).toBe(
            '类型',
        )
    })

    it('取值：attr 取不到时给空串（jsoup 的语义，不是 null）', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const tags = handle(bridge, 'select', doc, ['a.btn-tag'])
        expect(value(bridge, 'size', tags)).toBe(3)

        const first = handle(bridge, 'first', tags)
        expect(value(bridge, 'attr', first, ['data-filter-type'])).toBe('tagid')
        expect(value(bridge, 'attr', first, ['nope'])).toBe('')
        expect(value(bridge, 'hasAttr', first, ['data-filter-value'])).toBe(true)
        expect(value(bridge, 'hasClass', first, ['jsTag'])).toBe(true)
        expect(value(bridge, 'tagName', first)).toBe('a')
    })

    it('CSS 伪类 `:not()` 能透传给 cheerio —— 目录规则靠它排除卷首页', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const chapters = handle(bridge, 'select', doc, [
            'ul.volume-chapters li.chapter-li:not(.volume-cover)',
        ])
        expect(value(bridge, 'size', chapters)).toBe(2)
        expect(
            value(
                bridge,
                'text',
                handle(bridge, 'select', createInner(bridge, chapters, 0), ['a']),
            ),
        ).toBe('第一章')
    })

    it('text 折叠空白（jsoup 的行为），ownText 只取直接文本', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const desc = handle(bridge, 'select', doc, ['div.book-desc'])
        expect(value(bridge, 'text', desc)).toBe('简介：一本书')
        // ownText 是「直接文本子节点」，`<b>` 里的「一本」不算 —— 所以是「简介：书」
        expect(value(bridge, 'ownText', desc)).toBe('简介：书')
    })

    it('get 越界返回 null 句柄，而不是抛错 —— 书源里的 while 循环依赖它', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const tags = handle(bridge, 'select', doc, ['a.btn-tag'])
        const reply = bridge.run('get', tags, [99])
        expect(reply).toEqual({ ok: true, kind: 'handle', handle: null })
    })

    it('matchesOwn 用于「按自己那一行的文字判断」这类写法', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const titles = handle(bridge, 'select', doc, ['h3.sort-li-title'])
        expect(value(bridge, 'matchesOwn', titles, ['类型'])).toBe(true)
        expect(value(bridge, 'matchesOwn', titles, ['不存在'])).toBe(false)
    })

    it('eachText 返回字符串数组，元素个数与节点数一致', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const titles = handle(bridge, 'select', doc, ['h3.sort-li-title'])
        expect(value(bridge, 'eachText', titles)).toEqual(['类型', '状态'])
    })

    it('outerHtml 给出整个标签，html 只给内部', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const first = handle(bridge, 'first', handle(bridge, 'select', doc, ['div.book-desc']))
        expect(String(value(bridge, 'html', first))).toBe('简介：<b>一本</b>书')
        expect(String(value(bridge, 'outerHtml', first))).toContain('<div class="book-desc">')
    })

    it('选择器写坏时不炸，按「没匹配到」处理', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const empty = handle(bridge, 'select', doc, ['div:::bogus['])
        expect(value(bridge, 'size', empty)).toBe(0)
    })

    it('未实现的方法报出方法名，而不是静默返回空', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const reply = bridge.run('totallyUnknownOp', doc, [])
        expect(reply.ok).toBe(false)
        if (reply.ok) return
        expect(reply.error).toContain('totallyUnknownOp')
    })

    it('句柄失效时报明确错误（跨沙箱复用句柄是常见误用）', () => {
        const bridge = new JsoupBridge()
        const reply = bridge.run('size', 999, [])
        expect(reply.ok).toBe(false)
        if (reply.ok) return
        expect(reply.error).toContain('已失效')
    })

    it('remove 真删：删完再取，同一份文档里那一块就没了（📂少年小说网 的目录规则靠它）', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const filters = handle(bridge, 'first', handle(bridge, 'select', doc, ['ul#filters']))
        const titles = handle(bridge, 'select', doc, ['h3.sort-li-title'])
        expect(value(bridge, 'size', titles)).toBe(2)
        expect(String(value(bridge, 'html', filters))).toContain('sort-li-title')

        expect(bridge.run('remove', titles, [])).toEqual({ ok: true, kind: 'value', value: null })

        // 同一份文档里再查就没了 —— 书源正是「先 remove 掉藏起来的那几项，再取父节点 html」
        expect(value(bridge, 'size', handle(bridge, 'select', doc, ['h3.sort-li-title']))).toBe(0)
        expect(String(value(bridge, 'html', filters))).not.toContain('sort-li-title')
        // 删的是这几项，**别的地方不受影响**
        expect(value(bridge, 'size', handle(bridge, 'select', doc, ['a.btn-tag']))).toBe(3)
        expect(value(bridge, 'size', handle(bridge, 'select', doc, ['div.book-desc']))).toBe(1)
        expect(String(value(bridge, 'html', doc))).not.toContain('sort-li-title')
    })

    it('其余写操作仍是空操作（语料里只当顺手清理，没人依赖改完再读）', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const first = handle(bridge, 'first', handle(bridge, 'select', doc, ['h3.sort-li-title']))
        for (const op of ['attrSet', 'addClass', 'removeClass', 'append', 'prepend']) {
            expect(bridge.run(op, first, ['class', 'x'])).toEqual({
                ok: true,
                kind: 'value',
                value: null,
            })
        }
        // 关键是「改不动」：文档没被真的动过，后续取值仍与原来一致
        expect(value(bridge, 'text', first)).toBe('类型')
        expect(value(bridge, 'size', handle(bridge, 'select', doc, ['h3.sort-li-title']))).toBe(2)
    })

    it('parseFragments：一串 outerHTML 变回 N 个并列元素（java.getElements 用）', () => {
        const bridge = new JsoupBridge()
        const reply = bridge.run('parseFragments', null, [
            [
                '<li class="book-li"><a href="/a">甲</a></li>',
                '<li class="book-li"><a href="/b">乙</a></li>',
            ],
        ])
        expect(reply.ok).toBe(true)
        if (!reply.ok || reply.kind !== 'handle' || reply.handle === null)
            throw new Error('应返回句柄')

        const elements = reply.handle
        expect(value(bridge, 'size', elements)).toBe(2)
        // 两个片段是**并列**的，不是嵌套的 —— 这点错了会让下面的 get(i) 全乱
        expect(value(bridge, 'text', handle(bridge, 'get', elements, [1]))).toBe('乙')
        expect(
            value(
                bridge,
                'attr',
                handle(bridge, 'select', handle(bridge, 'get', elements, [1]), ['a']),
                ['href'],
            ),
        ).toBe('/b')
    })

    it('parseFragments：空数组给空节点集，而不是报错', () => {
        const bridge = new JsoupBridge()
        const reply = bridge.run('parseFragments', null, [[]])
        expect(reply.ok).toBe(true)
        if (!reply.ok || reply.kind !== 'handle' || reply.handle === null)
            throw new Error('应返回句柄')
        expect(value(bridge, 'size', reply.handle)).toBe(0)
    })
})

/**
 * **`<script>` / `<style>` 也是元素**
 *
 * domhandler 把它们的 `type` 记成 `'script'` / `'style'`，不是 `'tag'`。
 * 桥里那个 `isElement`（`type === 'tag'`）当初把它们整类**静默丢掉**了：
 * `java.getElements('script')` 永远 0 条 → `getElement('script')` 给 `null`。
 * 线上 `🎨51漫画` 的目录正是 `Array.from(java.getElement("script"))`，
 * 拿到 `null` 之后 `cannot read property 'Symbol.iterator' of null`，
 * **整本书打不开**（第四十九轮）。
 *
 * `children` / `child` / `siblingElements` 这三个 op 走的是同一份判据，
 * 所以也一起钉在这里。（`find` 那一路从来不受影响 —— 它用的是 css-select。）
 */
describe('org.jsoup 桥：script / style 不算「非元素」', () => {
    const PAGE = '<div id="box"><script>var a=1;</script><style>.x{}</style><p>正文</p></div>'

    /** 把任意一段 HTML 解析成文档句柄 */
    const docOf = (bridge: JsoupBridge, page: string): number => {
        const reply = bridge.run('parse', null, [page])
        if (!reply.ok || reply.kind !== 'handle' || reply.handle === null)
            throw new Error('parse 失败')
        return reply.handle
    }

    it('parseFragments 不再把 `<script>` / `<style>` 丢掉', () => {
        const bridge = new JsoupBridge()
        const reply = bridge.run('parseFragments', null, [
            ['<script>var a=1;</script>', '<style>.x{}</style>', '<div>3</div>'],
        ])
        if (!reply.ok || reply.kind !== 'handle' || reply.handle === null)
            throw new Error('应返回句柄')
        expect(value(bridge, 'size', reply.handle)).toBe(3)
    })

    it('`select("script")` 一直是对的（对照：走的是 css-select，不经这个判据）', () => {
        const bridge = new JsoupBridge()
        const doc = docOf(bridge, PAGE)
        expect(value(bridge, 'size', handle(bridge, 'select', doc, ['script']))).toBe(1)
    })

    it('`children` / `child` 带上脚本与样式', () => {
        const bridge = new JsoupBridge()
        const box = handle(bridge, 'select', docOf(bridge, PAGE), ['#box'])
        const kids = handle(bridge, 'children', box)
        expect(value(bridge, 'size', kids)).toBe(3)
        expect(value(bridge, 'tagName', handle(bridge, 'child', box, [0]))).toBe('script')
        expect(value(bridge, 'tagName', handle(bridge, 'child', box, [1]))).toBe('style')
    })

    it('脚本的 `tagName` 是 `script`，不是 `#root`', () => {
        const bridge = new JsoupBridge()
        const script = handle(bridge, 'select', docOf(bridge, PAGE), ['script'])
        expect(value(bridge, 'tagName', handle(bridge, 'first', script))).toBe('script')
        // 内容也取得到（`getElement('script').html()` 那条路要的就是它）
        expect(value(bridge, 'html', handle(bridge, 'first', script))).toBe('var a=1;')
    })
})

/**
 * `list`：一次把整串节点的「句柄 + 自己的 outerHTML」都交出去
 *
 * 这个 op 是为**往返次数**加的（第七十六轮）：`__listOf` 老写法是
 * `size` 一次、再对每个元素 `get(i)` + `outerHtml` 各一次 —— 459 个条目 919 次。
 * 它的正确性判据只有一条：**结果必须与逐个取完全一致**（书源那边看不出区别）。
 */
describe('org.jsoup 桥：list 一次取回整串（第 7 / 11 条）', () => {
    it('条数、每条的 HTML、每条的句柄都可用，且与逐个取的结果一致', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const chapters = handle(bridge, 'select', doc, ['ul.volume-chapters a'])

        const reply = bridge.run('list', chapters, [])
        expect(reply.ok).toBe(true)
        if (!reply.ok || reply.kind !== 'list') throw new Error('list 应返回 {kind:list}')

        // 与 `size` 对得上
        expect(reply.items.length).toBe(Number(value(bridge, 'size', chapters)))

        // 逐条与 `get(i)` + `outerHtml` 那条老路完全一致
        for (let i = 0; i < reply.items.length; i += 1) {
            const item = reply.items[i]!
            const single = handle(bridge, 'get', chapters, [i])
            expect(item.html, `第 ${i} 条的 HTML`).toBe(
                String(value(bridge, 'outerHtml', single)),
            )
            // 句柄是**可用**的（不是只给了个 HTML 字符串）
            expect(value(bridge, 'text', item.handle), `第 ${i} 条的 text`).toBe(
                String(value(bridge, 'text', single)),
            )
            expect(value(bridge, 'attr', item.handle, ['href'])).toBe(
                String(value(bridge, 'attr', single, ['href'])),
            )
        }
    })

    it('空集合给空数组，不是 null', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const none = handle(bridge, 'select', doc, ['li.nope'])
        const reply = bridge.run('list', none, [])
        if (!reply.ok || reply.kind !== 'list') throw new Error('list 应返回 {kind:list}')
        expect(reply.items).toEqual([])
    })

    it('`parse` 出来的文档句柄也能走（org.jsoup.Jsoup.parse 那条路）', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const reply = bridge.run('list', doc, [])
        if (!reply.ok || reply.kind !== 'list') throw new Error('list 应返回 {kind:list}')
        // 文档句柄就是 `$.root()` 那一个节点
        expect(reply.items.length).toBe(Number(value(bridge, 'size', doc)))
    })
})

/**
 * `attributes()`：📂贝壳读书 的目录规则要从属性里按**序号**取值
 *
 * 它写的是 `Array.from(a.selectFirst(ys).attributes())` 然后 `b[num-1].toString()`，
 * 所以桥这一层只需要交出「键值对、**保持顺序**」，Attribute 那层方法在沙箱里补。
 * 顺序是这里唯一容易错的地方（cheerio 的 `attribs` 是个对象）。
 */
describe('org.jsoup 桥：attributes（第 7 条）', () => {
    it('按出现顺序给出键值对（书源是按序号取的，顺序错了就取错）', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const li = handle(bridge, 'selectFirst', doc, ['ul#filters li.sort-li'])
        const reply = bridge.run('attributes', li, [])
        expect(reply.ok).toBe(true)
        if (!reply.ok || reply.kind !== 'value') throw new Error('attributes 应返回普通值')
        expect(reply.value).toEqual([{ key: 'class', value: 'sort-li' }])
    })

    it('多属性时顺序就是源文件里的顺序', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        const a = handle(bridge, 'selectFirst', doc, ['a.btn-tag'])
        const reply = bridge.run('attributes', a, [])
        if (!reply.ok || reply.kind !== 'value') throw new Error('attributes 应返回普通值')
        expect(reply.value).toEqual([
            { key: 'class', value: 'btn-tag jsTag' },
            { key: 'data-filter-type', value: 'tagid' },
            { key: 'data-filter-value', value: '1' },
        ])
    })

    it('没有属性的元素给空数组（不是报错、也不是 null）', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        // 简介里那个 `<b>一本</b>` 身上一个属性都没有
        const b = handle(bridge, 'selectFirst', doc, ['div.book-desc b'])
        expect(value(bridge, 'attributes', b)).toEqual([])
    })

    it('一个都没命中时也给空数组（空节点集的句柄走得通）', () => {
        const bridge = new JsoupBridge()
        const doc = handleOf(bridge)
        // 注意 `select` 的空结果是**空节点集**（不是 null 句柄），所以这里能继续调方法
        const none = handle(bridge, 'select', doc, ['li.nope'])
        expect(value(bridge, 'attributes', none)).toEqual([])
    })
})

/** 小工具：从 Elements 里再取一个元素句柄 */
function createInner(bridge: JsoupBridge, from: number, index: number): number {
    return handle(bridge, 'get', from, [index])
}
