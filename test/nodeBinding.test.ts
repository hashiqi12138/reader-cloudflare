import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `选择器@js:` 里的 `result` —— 脚本按 jsoup 用时**绑的是什么**
 *
 * Legado 那边 `result` 是 jsoup 的 `Elements`（节点集合，一个 List），
 * 于是脚本会写 `result.size()`、`result.forEach(e => e.attr('href'))`、
 * `result.select('a')` 之后再 `links[i]`。线上三处这么写
 * （⚡📂八一中文网、🔞西瓜书屋、🔞紫云宫），而它们原来都跑不起来：
 *
 *   1. **多命中**时 `result` 是**字符串数组**，`result.size is not a function`
 *   2. `result` 里装的是**按取值方式抠出来的字符串** —— 裸 CSS / JSOUP 简写的默认取值
 *      一个是「名为空串的属性」（恒空）、一个是 `text`，拿它当 HTML 解析什么都选不出来
 *
 * 所以改了两件：按 jsoup 用时把**节点本身的 HTML** 交给它；多命中时绑成数组
 * （沙箱侧再包成「数组形态的 Elements」）。**取值方式是显式写的（`@href` / `@html`）
 * 就不动它** —— 那已经是一份能用的 HTML/属性值了。
 *
 * 后来又把**形态**与**内容**拆成两个判据（见 `resultShape.ts` 的 `wantsJsoupResult`
 * 与 `usesJsoupOnResult`）：形态仍按「字符串优先」，但内容只要调了节点方法就给 HTML。
 * 合在一起用的时候，「同时按字符串用」的那批会拿到纯文本，`result.select(...)` 恒为 0。
 * 另外 `<js>` 块那条路（不是 `@js:` 尾巴）以前也走的是默认取值（文本），
 * 线上 6 条 `ruleToc.chapterList` 因此丢目录 —— 这两处都在下面有专门的用例。
 *
 * 沙箱在 Node 里跑不起来（QuickJS 的 `.wasm`），所以换成**回显型替身**：
 * 于是「脚本看到的是什么内容、什么形态」成了可断言的东西。
 *
 * 一条踩过的坑记在这里：夹具里的 `div.row` 是**没有 `href` 的 div**，
 * 断言「`attr('href')` 取到了值」必须用里面那个 `a`（`.row a`）。第一版用 `div.row`
 * 去验 `e.attr('href')`，红色的是测试自己 —— 元素本来就没有 href。
 */
const state = vi.hoisted(() => ({ calls: [] as Array<{ code: string; result: unknown }> }))

vi.mock('../src/engine/js', () => ({
    SandboxError: class SandboxError extends Error {},
    runInSandbox: async (code: string, globals: Record<string, unknown>) => {
        state.calls.push({ code, result: globals.result })
        return globals.result
    },
    sandboxResultToString: (value: unknown) =>
        value === null || value === undefined
            ? ''
            : Array.isArray(value)
              ? value.map((v) => String(v ?? '')).join('\n')
              : String(value),
    sandboxResultToStrings: (value: unknown) => {
        if (value === null || value === undefined) return []
        return Array.isArray(value) ? value.map((v) => String(v ?? '')) : [String(value)]
    },
}))

const { analyzeStrings, rootSelection } = await import('../src/engine/analyze')

const HTML = `<html><body><div class="row"><a href="/a">甲</a></div><div class="row"><a href="/b">乙</a></div><div class="one"><a href="/c">丙</a></div></body></html>`
const ctx = { baseUrl: 'https://example.com' }
const sel = () => rootSelection(HTML)

/** 跑一条规则，返回沙箱看到的那个 `result` */
async function seen(rule: string): Promise<unknown> {
    await analyzeStrings(sel(), rule, ctx)
    expect(state.calls).toHaveLength(1)
    return state.calls[0]!.result
}

beforeEach(() => {
    state.calls.length = 0
})

describe('按 jsoup 用 result：绑节点本身的 HTML', () => {
    it('多命中 + `result.size()` —— 绑成数组，每一项是一段节点 HTML', async () => {
        const result = await seen('div.row@js:result.size() > 0 ? result : []')
        expect(Array.isArray(result)).toBe(true)
        const list = result as string[]
        expect(list).toHaveLength(2)
        // 是**节点**（outerHTML 里带标签），不是抠出来的文本
        for (const item of list) {
            expect(item).toContain('class="row"')
            expect(item).toContain('<a href="/')
        }
        expect(list[0]).toContain('甲')
        expect(list[1]).toContain('乙')
    })

    it('多命中 + 下标遍历 —— 每个元素都能 `text()` / `attr()`', async () => {
        const result = await seen(
            'div.row@js:(function(){var o=[];for(var i=0;i<result.size();i++){var e=result[i];o.push(e.attr("href"))}return o})()',
        )
        expect(Array.isArray(result)).toBe(true)
        expect(result).toHaveLength(2)
        // 元素要是**节点**才取得到 href；给纯文本的话这里是两个空串
        for (const item of result as string[]) expect(item).toContain('<a href="/')
    })

    it('多命中 + `result.forEach(e => …)` —— 迭代式同样拿到节点（🔞西瓜书屋 的形状）', async () => {
        // 只调 `forEach` 与元素级方法（没有集合级方法），判据靠 ITEM_AS_JSOUP 认出来
        const result = await seen(
            'div.row@js:(function(){var o=[];result.forEach(function(e){o.push(e.attr("href"))});return o})()',
        )
        expect(Array.isArray(result)).toBe(true)
        expect(result).toHaveLength(2)
        for (const item of result as string[]) expect(item).toContain('<a href="/')
    })

    it('多命中 + `result.toArray()` —— 也算「按节点用」（线上 20 个源 28 处在用）', async () => {
        // 📂文学小说 的 `list = result.toArray()` 就是这个形状。
        // 漏认它的后果：把节点集当纯文本，`result.toArray` 直接 not a function
        const result = await seen('div.row@js:result.toArray().length')
        expect(Array.isArray(result)).toBe(true)
        const list = result as string[]
        expect(list).toHaveLength(2)
        expect(list[0]).toContain('<a href="/a">甲</a>')
    })

    it('`<js>` 块里调 `toArray()` —— 块前面那段选择器同样给节点 HTML', async () => {
        // 6 条「海马书屋」形状的目录规则走的是 `<js>` 块这条路（不是 `@js:` 尾巴），
        // 而这条路以前**不看**脚本要什么，一律给默认取值（文本）
        const result = await seen('div.row<js>list = result.toArray(); result = list.length</js>')
        expect(Array.isArray(result)).toBe(true)
        const list = result as string[]
        expect(list).toHaveLength(2)
        for (const item of list) expect(item).toContain('class="row"')
    })

    it('单命中 —— 也是数组（只装一个元素），`forEach` / `[i]` 照样可用', async () => {
        const result = await seen('div.one@js:result.size() > 0 ? result : ""')
        expect(Array.isArray(result)).toBe(true)
        const list = result as string[]
        expect(list).toHaveLength(1)
        expect(list[0]).toContain('<a href="/c">')
        expect(list[0]).toContain('丙')
    })

    it('一点都没命中 —— 给**空数组**（`size()` 为 0），而不是把整页塞进去', async () => {
        // 这一条是 `⚡📂八一中文网` 的 `if(!!result.size())` 的前提：
        // 空命中时 `size()` 必须是 0，否则「没搜到」会被当成「搜到了」，
        // 于是永远走不到它那个「自动更新搜索链接」的 else 分支。
        const result = await seen('div.nope@js:result.size() > 0 ? result : ""')
        expect(result).toEqual([])
    })
})

describe('显式写了取值方式就不动它', () => {
    it('`@href` —— 交出去的还是抠出来的属性值', async () => {
        const result = await seen('div.row a@href@js:result.size() > 0 ? result : []')
        expect(result).toEqual(['/a', '/b'])
    })

    it('`@html` —— 交出去的是 inner HTML，不是节点自己', async () => {
        const result = await seen('div.one@html@js:result.size() > 0 ? result : ""')
        expect(String(result)).toBe('<a href="/c">丙</a>')
    })
})

describe('优先级：按字符串用 > 按 jsoup 用（**形态**按字符串，**内容**仍是节点 HTML）', () => {
    it('两种写法混在一起时按字符串算，但交给脚本的仍是节点 HTML', async () => {
        /**
         * 两件事要分开看，它们由两个判据分别决定：
         *
         *   - **形态**：`String(result)` 是字符串写法 → 绑成字符串而不是数组
         *     （见 `resultGlobals` 的 `wantsJsoupResult`）
         *   - **内容**：脚本调了 `result.select(...)` → 里面必须有标记 → 给节点 HTML
         *     （见 `evalRule` 的 `usesJsoupOnResult`）
         *
         * 以前这两件事共用一个判据，于是「同时按字符串用」时内容退回**纯文本**，
         * `result.select("a").size()` 恒为 0 —— 不报错，只是查询永远查不到东西。
         * 线上 6 条 `ruleToc.chapterList`（🔞PO5 / 📂海马书屋 那一族）就是这么丢目录的。
         */
        const result = await seen(
            'div.row@js:String(result).split("甲").length + result.select("a").size()',
        )
        expect(typeof result).toBe('string')
        expect(result).toBe(
            '<div class="row"><a href="/a">甲</a></div>\n<div class="row"><a href="/b">乙</a></div>',
        )
    })

    it('顶格 `@js:` 仍然绑页面原文（前面没有选择器）', async () => {
        const result = await seen('@js:result.size() > 0 ? result : ""')
        expect(result).toBe(sel().source)
    })
})
