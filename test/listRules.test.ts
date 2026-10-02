import { describe, expect, it, vi } from 'vitest'

/**
 * 列表规则（`bookList`）的分支与条目圈定
 *
 * 这层之所以值得单独测：列表规则圈错的后果**不是报错**，而是
 * 「分类拉得出来、书目却是空的」—— 排查时只能靠猜。
 *
 * `analyze.ts` 会 import 沙箱（`engine/js.ts`），而沙箱带着 QuickJS 的 `.wasm`，
 * 在 Node 里加载不了。所以这里把沙箱整个替换掉：本文件的用例**没有一个需要真的跑 JS**，
 * 需要的只是「JS 规则会被交给沙箱」这件事可观察 —— 抛一个可辨认的错误就够了。
 */
vi.mock('../src/engine/js', () => ({
    SandboxError: class SandboxError extends Error {},
    runInSandbox: async () => {
        throw new Error('（测试替身）沙箱不可用')
    },
    sandboxResultToString: (value: unknown) => String(value ?? ''),
    sandboxResultToStrings: (value: unknown) => [String(value ?? '')],
}))

const { analyzeSelections, rootSelection } = await import('../src/engine/analyze')

const HTML = `<html><body>
<ol class="book-ol book-ol-normal"><li class="book-li"><a href="/a"><h4 class="book-title">甲</h4></a></li>
<li class="book-li"><a href="/b"><h4 class="book-title">乙</h4></a></li></ol>
<ul class="list"><li><a href="/c">丙</a></li></ul>
</body></html>`

const ctx = { baseUrl: 'https://example.com' }
const sel = () => rootSelection(HTML)

describe('列表规则的连接符', () => {
    it('`||` 取第一个有结果的分支 —— 老版/新版页面各用一个选择器', async () => {
        // 第一个分支（`ol.jsBooks`）在新版页面里根本不存在，但**不能**因此返回空：
        // 早先整串连同 `||` 被当成一个 CSS 选择器，cheerio 抛错后被咽掉，结果就是空书目
        const items = await analyzeSelections(
            sel(),
            'ol.book-ol.book-ol-normal li.book-li||ol.jsBooks li.book-li',
            ctx,
        )
        expect(items).toHaveLength(2)
    })

    it('第一分支为空时落到第二分支', async () => {
        const items = await analyzeSelections(sel(), 'ol.nope li.book-li||ul.list li', ctx)
        expect(items).toHaveLength(1)
    })

    it('两个分支都没结果时返回空列表，而不是抛错', async () => {
        expect(await analyzeSelections(sel(), 'ol.nope li||ul.also-nope li', ctx)).toEqual([])
    })

    it('`&&` 把两个分支的结果并起来', async () => {
        const items = await analyzeSelections(sel(), 'ol.book-ol li.book-li&&ul.list li', ctx)
        expect(items).toHaveLength(3)
    })

    it('`||` 不切进 `@js:` 代码里', async () => {
        // JS 里的 `||` 极常见（默认值写法）。整条被当成 JS 规则交给沙箱，
        // 说明连接符没有生效 —— 若被切开会先按 CSS 解析，报的是另一种错
        await expect(
            analyzeSelections(sel(), '@js:var a = window.__x || []; return a', ctx),
        ).rejects.toThrow('沙箱不可用')
    })
})

describe('AllInOne 与连接符的顺序', () => {
    it('以 `:` 开头的 AllInOne 规则里的 `||` 不会被当成连接符切开', async () => {
        // AllInOne 后面是**正则原文**，`||` 在正则里是合法写法（两个空分支）。
        // 若先拆连接符，这条规则会被切成 `:book-title">(甲` 与 `乙)<` 两块：
        // 第一块的正则因为括号没闭合而匹配不到，于是 `||` 落到第二块，
        // 第二块 `乙)<` 是个非法 CSS 选择器 → 抛「CSS 选择器无效」。
        // 所以「返回 2 条」本身就证明顺序是对的。
        const items = await analyzeSelections(sel(), ':book-title">(甲||乙)<', ctx)
        expect(items).toHaveLength(2)
    })
})
