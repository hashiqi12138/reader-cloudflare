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
    /** 给 `java.getElements(规则)` 用的替身：直接回这几段 HTML（规则求值那一层不在本文件范围） */
    fragments: string[] = [],
): Promise<{ calls: number; value: unknown }> {
    const session = createSandboxSession()
    const before = session.jsoupCalls
    const value = await runInSandbox(
        code,
        { result: html },
        fragments.length > 0 ? { session, getElements: async () => fragments } : { session },
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

    it('`JsoupElements` 是**可迭代**的 —— `Array.from` 不再安静地给空数组', async () => {
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
