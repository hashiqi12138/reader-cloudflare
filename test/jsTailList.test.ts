import { describe, expect, it, vi } from 'vitest'

/**
 * 列表规则：`<js>` 块后面还跟一段 HTML 选择器时，**条目要给节点**
 *
 * 线上这个形状共 46 处（约 34 个源），🔞PO5 / 新龙小说 / 废纸文学 / 冷冷文学 /
 * 海马书屋 / 海棠看书 这一族的 `chapterList` 就是它：
 *
 *   class.BCsectionTwo-top-chapter@li
 *   <js>list = result.toArray(); … l.join("")</js>
 *   tag.a
 *
 * Legado 的 `getElements(ruleStr)` 是按段分发的：`<js>` 段跑脚本，下一段选择器
 * 用 jsoup 的 `getElements` 在那段输出上重新解析 —— 条目是 **Element**。字段规则
 * 于是在**那一个元素**上求值（`String(result)` / `String(src)` = 这一条的 outer HTML）。
 *
 * 我们以前把尾段的**默认取值（文本）**当条目，后果有两个，都不报错或报得莫名其妙：
 *   - `chapterUrl: 'href'` 在文本条目上取不到属性 → 章节全被丢掉（目录 0 章）
 *   - `chapterName` 里按 HTML 写的正则匹配不到 → catch 里再 `[1]` 抛
 *     `cannot read property of null`（线上报的就是这句，指向脚本第 6 行）
 *
 * 与 `listRules.test.ts` 一样，这里把沙箱整个替换掉：用例不需要真的跑 JS，
 * 只需要「`<js>` 段的输出」这件事可控 —— 让替身返回一段固定的 HTML 就够了。
 */
const sandbox = vi.hoisted(() => ({ output: '' }))

vi.mock('../src/engine/js', () => ({
    SandboxError: class SandboxError extends Error {},
    runInSandbox: async () => sandbox.output,
    sandboxResultToString: (value: unknown) => String(value ?? ''),
    sandboxResultToStrings: (value: unknown) =>
        Array.isArray(value) ? value.map((v) => String(v ?? '')) : [String(value ?? '')],
}))

const { analyzeSelections, analyzeStrings, rootSelection } = await import('../src/engine/analyze')

const PAGE = `<html><body><div class="item"><li>旧的</li></div></body></html>`
const ctx = { baseUrl: 'https://example.com' }
const sel = () => rootSelection(PAGE)

/** `<js>` 段产出的 HTML：两条 `<a>`，各自带 `class="g"` 与自己的地址 */
const JS_OUT = `<li class="row"><a href="/1" class="g">甲</a></li>
<li class="row"><a href="/2" class="g">乙</a></li>`

/** 形状：选择器 + `<js>` + 尾段选择器（脚本里出现 `toArray` 才会拿到节点 HTML） */
const PO5_SHAPE = `div.item
<js>list = result.toArray(); l = []; for (var i = 0; i < list.length; i++) l.push(list[i]); l.join("")</js>
tag.a`

describe('`<js>` 块 + 尾段 HTML 选择器：条目保留 DOM', () => {
    it('条目是节点，`source` 是**这一条自己的 HTML**（不是文本、也不是整页）', async () => {
        sandbox.output = JS_OUT
        const items = await analyzeSelections(sel(), PO5_SHAPE, ctx)

        expect(items).toHaveLength(2)
        // 这一条就是 `result` / `src` 在字段规则里看到的东西
        expect(items[0]!.source).toContain('class="g"')
        expect(items[0]!.source).toContain('href="/1"')
        expect(items[1]!.source).toContain('href="/2"')
        // 是节点而不是文本节点：解析出来的节点挂在条目上
        expect(items[0]!.nodes).toHaveLength(1)
    })

    it('后续字段规则能在条目里继续筛（`href` 取到这一条自己的地址）', async () => {
        sandbox.output = JS_OUT
        const items = await analyzeSelections(sel(), PO5_SHAPE, ctx)

        expect(await analyzeStrings(items[0]!, 'href', ctx)).toEqual(['/1'])
        expect(await analyzeStrings(items[1]!, 'href', ctx)).toEqual(['/2'])
        expect(await analyzeStrings(items[0]!, 'text', ctx)).toEqual(['甲'])
    })

    it('顶格 `<js>` + 尾段选择器同样保留 DOM（脚本自己拼 HTML 的那种源）', async () => {
        sandbox.output =
            '<html><body><ul><li><a href="/hq/1.html">分节 1</a></li><li><a href="/hq/2.html">分节 2</a></li></ul></body></html>'
        const items = await analyzeSelections(sel(), `<js>sb</js>\nul li`, ctx)

        expect(items).toHaveLength(2)
        expect(await analyzeStrings(items[0]!, 'a@href', ctx)).toEqual(['/hq/1.html'])
    })
})

describe('不该被这条改动影响的两类尾段', () => {
    it('尾段写了取值方式（`a@href`）：**仍旧给节点** —— 列表规则忽略取值方式', async () => {
        // Legado 的 `getElements(ruleStr)` 只取节点，取值方式（`@href` / `@text`）是
        // `getString` 那一层的事。线上 46 处 HTML 尾段里有一大半写成
        // `.sp-chapter-grid@a` / `class.zj_list@dd` —— 末尾那个词在书源本意里是
        // 「标签 a / 标签 dd」，只是我们的 jsoup 文法会把它读成属性名
        sandbox.output = JS_OUT
        const items = await analyzeSelections(sel(), `div.item\n<js>x</js>\na@href`, ctx)

        expect(items).toHaveLength(2)
        expect(items[0]!.source).toContain('href="/1"')
        expect(await analyzeStrings(items[0]!, 'href', ctx)).toEqual(['/1'])
    })

    it('尾段是 JSONPath：走原来的路（条目是取出来的文本，不是节点）', async () => {
        // 接口型书源的形态：页面本身就是 JSON，`<js>` 段跑完再用 `$.路径` 取列表
        const jsonPage = rootSelection('{"data":{"list":[{"name":"甲"},{"name":"乙"}]}}')
        sandbox.output = 'x'
        const items = await analyzeSelections(jsonPage, `<js>x</js>\n$.data.list`, ctx)

        expect(items).toHaveLength(2)
        expect(items[0]!.source).toContain('"name":"甲"')
        expect(items[0]!.source).not.toContain('<')
    })

    it('没有 `<js>` 段的普通列表规则不受影响', async () => {
        const items = await analyzeSelections(sel(), 'div.item', ctx)
        expect(items).toHaveLength(1)
        // 普通路径下 `source` 仍是整页（后续规则靠 nodes 在条目里筛）
        expect(items[0]!.source).toBe(PAGE)
    })
})
