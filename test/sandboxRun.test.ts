/**
 * **真的把沙箱跑起来**的单测（第七十七轮，TODO 第 14 条）
 *
 * 为什么以前没有这个文件
 * --------------------
 * `engine/js.ts` 里那句 `import … from '../platform/wasm'` 指向的文件是一句静态 `.wasm`
 * import，只有打包器认；Node 直接 import 会失败（实测报
 * `Cannot find package 'a' imported from …/RELEASE_ASYNC.wasm` —— Vite 把那份二进制
 * 当源码加载了）。于是「预置里那些 JS」一直只能靠 `scripts/smoke.mjs` 在真实运行时里验，
 * 单测这一层**没有直接的断言**。
 *
 * 第七十七轮在 `vitest.config.ts` 里把那条缝换成了 `platform/wasm.node.ts`
 * （与 `scripts/build-node.mjs` 里那个替换插件同一件事），这个文件就是它的第一个用户。
 *
 * 它为什么不能只断言「结果相等」
 * ----------------------------
 * 这一层最贵的不是算得对不对，而是**过了多少次桥**：每一次 `__host.jsoup` 调用都要过一次
 * JSON + 一次 QuickJS 宿主回调。所以这里用 `SandboxSession.jsoupCalls`（宿主侧记账）
 * 把「过桥次数」变成可断言的数字 —— 次数是**可复现**的，时间在测试里会抖。
 *
 * 关键的一条判据是「**不随节点数增长**」：同一个脚本打 5 个节点与 50 个节点，
 * 过桥次数必须**一模一样**。它比「少于 N 次」结实得多 —— 后者会被实现细节的微调弄红，
 * 前者只会在「又变成逐个过桥」时才红。
 */

import { describe, expect, it } from 'vitest'

import { createSandboxSession, runInSandbox } from '../src/engine/js'
import { JsoupBridge, type JsoupReply } from '../src/engine/jsoupBridge'

/** 桥的回复里取句柄 / 取值；类型不对就直接失败（免得测试里到处写 as） */
function bridgeHandle(reply: JsoupReply, op: string): number {
    if (!reply.ok) throw new Error(`${op}：${reply.error}`)
    if (reply.kind !== 'handle' || reply.handle === null) throw new Error(`${op} 应返回句柄`)
    return reply.handle
}

function bridgeValue(reply: JsoupReply, op: string): unknown {
    if (!reply.ok) throw new Error(`${op}：${reply.error}`)
    if (reply.kind !== 'value') throw new Error(`${op} 应返回普通值`)
    return reply.value
}

/** 造一个有 n 个 `<a>` 的页面（每个的属性和文本都不一样，好让结果能逐字对上） */
function pageOf(n: number): string {
    const links = Array.from(
        { length: n },
        (_, i) =>
            `<li class="row r${i}"><a class="lnk" data-i="${i}" href="/c/${i}">第 ${i} 章</a></li>`,
    ).join('')
    return `<html><body><ul id="list">${links}</ul></body></html>`
}

/** 跑一段脚本，返回「这次过桥了多少次」 */
async function callsOf(
    code: string,
    html: string,
    /**
     * 给 `java.getElements(规则)` 用的替身：直接回这几段 HTML（规则求值那一层不在本文件范围）。
     * 传 `[]` 表示「这个替身在场，但一个都没命中」；不传就是「没有这个能力」。
     */
    fragments?: string[],
): Promise<{ calls: number; value: unknown }> {
    const session = createSandboxSession()
    const before = session.jsoupCalls
    const value = await runInSandbox(
        code,
        { result: html },
        fragments ? { session, getElements: async () => fragments } : { session },
    )
    return { calls: session.jsoupCalls - before, value }
}

/** 逐节点取「属性 + 文本」——书源里最集中的那种写法 */
const READ_PER_NODE = `var a = org.jsoup.Jsoup.parse(result).select('a');
a.map(function (e) { return e.attr('href') + '|' + e.text() }).join(',')`

/** 对照：逐节点调一个**没有预取**的方法（`ownText` 要走桥） */
const OWN_TEXT_PER_NODE = `var a = org.jsoup.Jsoup.parse(result).select('a');
a.map(function (e) { return e.ownText() }).join(',')`

describe('沙箱真的能跑（第七十七轮起）', () => {
    it('最基本的：算得出东西，而且用的是真的 QuickJS', async () => {
        const out = await runInSandbox('1 + 1', {})
        expect(out).toBe(2)
    })

    it('`org.jsoup` 的桥在沙箱里是通的', async () => {
        const { value } = await callsOf(
            `org.jsoup.Jsoup.parse(result).select('a').size()`,
            pageOf(3),
        )
        expect(value).toBe(3)
    })
})

/**
 * 基线：`org.jsoup.Jsoup.parse(整页).select(css)` 一共过 **4** 次桥
 *
 * 拆开是：`parse` 本身一次、取整串一次（`list`）、`select` 一次、取整串一次。
 * 节点数**不进这个数** —— 这正是第 11 / 13 条要的。
 */
const BASE_CALLS = 4

describe('过桥次数：取整串一次搞定（TODO 第 11 条）', () => {
    it('`select` 出 n 个节点之后取整串，过桥次数**不随 n 增长**', async () => {
        const small = await callsOf(`org.jsoup.Jsoup.parse(result).select('a').length`, pageOf(5))
        const big = await callsOf(`org.jsoup.Jsoup.parse(result).select('a').length`, pageOf(50))
        expect(big.calls).toBe(small.calls)
        expect(small.value).toBe(5)
        expect(big.value).toBe(50)
        // 老实现这里要多 1（size）+ 2n（get + outerHtml）次 —— 50 个节点就是 105 次
        expect(big.calls).toBe(BASE_CALLS)
    })
})

describe('过桥次数：逐节点取字段也不再过桥（TODO 第 13 条）', () => {
    it('`e.attr(...)` / `e.text()` / `String(e)` 每个节点都调，过桥次数仍然**不随 n 增长**', async () => {
        const small = await callsOf(READ_PER_NODE, pageOf(5))
        const big = await callsOf(READ_PER_NODE, pageOf(50))
        expect(big.calls).toBe(small.calls)
        expect(big.calls).toBe(BASE_CALLS)
        expect(String(big.value).split(',')).toHaveLength(50)
    })

    it('对照：没预取的方法（`ownText`）**照旧**每个节点过一次桥 —— 计数是真的在量', async () => {
        const small = await callsOf(OWN_TEXT_PER_NODE, pageOf(5))
        const big = await callsOf(OWN_TEXT_PER_NODE, pageOf(50))
        expect(small.calls).toBe(BASE_CALLS + 5)
        // 差正好是 n 的差（45）—— 说明这个计数确实逐节点在涨，不是恒等于常数
        expect(big.calls - small.calls).toBe(50 - 5)
    })

    it('预取过的字段与「过桥那条路」给出**同一个答案**（拿宿主桥对拍）', async () => {
        const n = 20
        const html = pageOf(n)
        const { value } = await callsOf(READ_PER_NODE, html)

        // 同一个页面、同一批节点，直接用宿主桥算一遍 —— 这是**真的**对照，不是复述实现
        const bridge = new JsoupBridge()
        const doc = bridgeHandle(bridge.run('parse', null, [html]), 'parse')
        const picked = bridgeHandle(bridge.run('select', doc, ['a']), 'select')
        const want: string[] = []
        for (let i = 0; i < n; i += 1) {
            const one = bridgeHandle(bridge.run('get', picked, [i]), 'get')
            const href = String(bridgeValue(bridge.run('attr', one, ['href']), 'attr'))
            const text = String(bridgeValue(bridge.run('text', one, []), 'text'))
            want.push(`${href}|${text}`)
        }
        expect(value).toBe(want.join(','))
    })

    it('属性取不到时给空串（与桥的 `?? ""` 一致，不是 undefined）', async () => {
        const { value } = await callsOf(
            `var a = org.jsoup.Jsoup.parse(result).select('a');
             [String(a[0].attr('nope')), String(a[0].hasAttr('nope')), String(a[0].className()), String(a[0].id())].join('/')`,
            pageOf(2),
        )
        expect(value).toBe('/false/lnk/')
    })
})

/** 造一个有 n 张图的正文页（`src` 是占位图、真地址在 `data-real-src` 上） */
function imgPageOf(n: number): string {
    const imgs = imgFragmentsOf(n).join('')
    return `<html><body><div class="rd-article-wr">${imgs}</div></body></html>`
}

/** 与 imgPageOf 配套：交给 `java.getElements(规则)` 的那 N 段 HTML */
function imgFragmentsOf(n: number): string[] {
    return Array.from(
        { length: n },
        (_, i) => `<img src="/ph.gif" data-real-src="/real/${i}.png" alt="${i}">`,
    )
}

describe('jsoup 的写操作真改、且改完缓存失效（TODO 第 12 条）', () => {
    /**
     * 🎨笔趣漫画 那条正文规则：把懒加载属性抄到 `src` 上，再把整批节点**原样返回**。
     * 这里用 `map(String)` 把每张图串出来，等价于「返回 imgs 之后被宿主串化」那一步。
     */
    const WRITE_SRC = `var imgs = java.getElements('img');
imgs.forEach(function (e) { e.attr('src', e.attr('data-real-src')) });
imgs.map(function (e) { return String(e) }).join('|')`

    it('`attr(k, v)` 真改：紧接着从**同一个元素**上串出来的 HTML 是新值（缓存失效）', async () => {
        const n = 3
        const { value } = await callsOf(WRITE_SRC, imgPageOf(n), imgFragmentsOf(n))
        const parts = String(value).split('|')
        expect(parts).toHaveLength(n)
        expect(String(value)).not.toContain('/ph.gif')
        expect(parts[0]).toContain('src="/real/0.png"')
        expect(parts[2]).toContain('src="/real/2.png"')
        // 是「改写」不是「替换」：原来那个懒加载属性还在
        expect(parts[1]).toContain('data-real-src="/real/1.png"')
    })

    it('一参仍然是**读**（同名重载按参数个数分派），写不会把读搞坏', async () => {
        const { value } = await callsOf(
            `var e = java.getElement('img');
             var before = e.attr('src');
             e.attr('src', '/real/0.png');
             [before, e.attr('src'), e.hasAttr('src')].join(' / ')`,
            '',
            imgFragmentsOf(1),
        )
        expect(value).toBe('/ph.gif / /real/0.png / true')
    })

    it('`addClass` / `removeClass` 真改：串出来的 HTML 跟着变', async () => {
        const { value } = await callsOf(
            `var e = java.getElement('div');
             e.addClass('hot');
             var a = String(e);
             e.removeClass('hot');
             var b = String(e);
             [a.indexOf('hot') >= 0, b.indexOf('hot') === -1].join('/')`,
            '',
            ['<div class="x">原来的</div>'],
        )
        expect(value).toBe('true/true')
    })

    it('`html(v)` / `text(v)` 真改：改完从同一个元素串出来是**新内容**（缓存失效）', async () => {
        const { value } = await callsOf(
            `var e = java.getElement('div');
             e.html('<span>换过</span>');
             var a = String(e).indexOf('<span>换过</span>') >= 0;
             e.text('改过的');
             var b = String(e).indexOf('改过的') >= 0;
             var c = String(e).indexOf('<span>换过</span>') === -1;
             [a, b, c].join('/')`,
            '',
            ['<div class="x">原来的</div>'],
        )
        expect(value).toBe('true/true/true')
    })

    it('`java.getElements(...)` 给的是**数组形态**：`[i]` / `.length` / `.forEach` / `.size()` 同时可用', async () => {
        const n = 4
        const { value } = await callsOf(
            `var x = java.getElements('img');
             [x.length, typeof x.forEach, typeof x.map, x.size(), String(x[2]).indexOf('data-real-src="/real/2.png"') >= 0].join(' / ')`,
            '',
            imgFragmentsOf(n),
        )
        expect(value).toBe('4 / function / function / 4 / true')
    })

    it('`java.getElement(...)` 给**含一个元素的数组形态**（与 `selectFirst` 同种东西）', async () => {
        const { value } = await callsOf(
            `var one = java.getElement('img');
             [one.length, Array.isArray(one), one.attr('data-real-src'), one[0].attr('data-real-src')].join(' / ')`,
            '',
            imgFragmentsOf(2),
        )
        // 集合级 attr 取到的是第一个元素的属性，与 [0] 上取一致
        expect(value).toBe('1 / true / /real/0.png / /real/0.png')
    })

    it('`Array.from(java.getElement("script"))` 拿到的是那**一个元素**，不是一串单字（🎨51漫画）', async () => {
        const { value } = await callsOf(
            `var s = Array.from(java.getElement('script')).filter(function (e) { return String(e).indexOf('目录') >= 0 });
             [s.length, String(s[0]).indexOf('<script') >= 0].join(' / ')`,
            '',
            ['<script>{"目录":1}</script>'],
        )
        expect(value).toBe('1 / true')
    })

    it('取不到时给 null（书源拿 `java.getElement("script") === null` 判有没有）', async () => {
        const empty = await callsOf(`java.getElement('img') === null`, '', [])
        expect(empty.value).toBe(true)
    })

    it('`Array.from(java.getElements(...))` 拿得到全部（数组天然可迭代）', async () => {
        const { value } = await callsOf(
            `var x = Array.from(java.getElements('img'));
             [x.length, x[0].attr('alt'), x[3].attr('alt')].join(' / ')`,
            '',
            imgFragmentsOf(4),
        )
        expect(value).toBe('4 / 0 / 3')
    })
})

describe('jsoup 方法面里那两处补过的（TODO 第 7 条）', () => {
    it('`attributes()`：`Attribute.toString()` 是 `key="value"`，且**顺序就是书写顺序**', async () => {
        const { value } = await callsOf(
            `var a = org.jsoup.Jsoup.parse(result).selectFirst('a');
             var attrs = a.attributes();
             var b = Array.from(attrs);
             [attrs.length, attrs.size(), b[0].toString(), b[1].toString(), b[2].getKey(), attrs.hasKey('href')].join(' / ')`,
            pageOf(1),
        )
        // 页面里那个 <a> 是 class / data-i / href，正好三个
        expect(value).toBe('3 / 3 / class="lnk" / data-i="0" / href / true')
    })

    it('`Array.from(...)` 之后只剩逐项方法（📂贝壳读书 要的正是逐项那几个）', async () => {
        const { value } = await callsOf(
            `var a = org.jsoup.Jsoup.parse(result).selectFirst('a');
             var b = Array.from(a.attributes());
             [typeof b.size, typeof b.hasKey, typeof b[0].getKey, typeof b[0].getValue].join(' / ')`,
            pageOf(1),
        )
        // 集合级那三个留在**原来那个数组**上（Array.from 只搬下标项）——
        // 语料里那个用法（`b[num-1].toString()`）只用逐项方法，所以这条不是问题
        expect(value).toBe('undefined / undefined / function / function')
    })

    it('按属性序号取值能跑通（📂贝壳读书 的形状）', async () => {
        const { value } = await callsOf(
            `function pick(html, ys, num) {
               var a = org.jsoup.Jsoup.parse(html);
               var b = Array.from(a.selectFirst(ys).attributes());
               return b[num - 1].toString().match(/"(.+)"/)[1];
             }
             pick(result, "a", 3)`,
            pageOf(1),
        )
        expect(value).toBe('/c/0')
    })

    it('`Array.from(java.getElements(...))` 拿得到全部（第七十八轮起它本身就是数组）', async () => {
        const { value } = await callsOf(
            `var x = Array.from(java.getElements('whatever'));
             [x.length, String(x[0]).indexOf('<a') >= 0, String(x[1]).indexOf('<a') >= 0].join('/')`,
            pageOf(1),
            // 三个片段，逐个都是「一个 <a>」
            ['<a href="/a">甲</a>', '<a href="/b">乙</a>', '<a href="/c">丙</a>'],
        )
        expect(value).toBe('3/true/true')
    })
})
