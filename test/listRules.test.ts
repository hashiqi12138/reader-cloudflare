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

const { analyzeSelections, analyzeStrings, rootSelection } = await import('../src/engine/analyze')

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

/**
 * 列表规则的**末尾那个词**：已知取值名才算取值，其余当步骤
 *
 * 引擎的 jsoup 文法把末尾的裸词一概读成取值名（属性）——
 * `coverUrl: 'img.2@data-src'` 那种写法要求的。但列表规则里
 * `class.chapters@li@a` / `.book-list@li` / `.box@ul@li` 的末尾那个词是**标签**，
 * 照取值读会少选最后一层（拿到的还是上一层），条目少一层之后 `href` / `text`
 * 一律落空 —— 目录 0 条 / 搜索 0 条，全程不报错。
 *
 * 全量 dump 里列表规则的取值位共 479 处，已知取值名只有 2 处（`html`），
 * 其余 477 处全是标签；而字段规则里 `@title`（95 处）这类**确实是属性名**，
 * 所以这条路一个字没动（见「字段规则不受影响」那两条）。
 */
describe('列表规则的末尾那个词：标签 vs 取值', () => {
    const HTML2 = `<html><body>
<div class="box"><ul><li class="row"><a href="/1" title="第一章">甲</a></li>
<li class="row"><a href="/2" title="第二章">乙</a></li></ul></div>
<p class="one" data-id="7">丙</p>
</body></html>`
    const sel2 = () => rootSelection(HTML2)

    it('JSOUP 形状 `class.box@li@a`：条目标是 `a`（不是被吞掉那一层的 `li`）', async () => {
        const items = await analyzeSelections(sel2(), 'class.box@li@a', ctx)
        expect(items).toHaveLength(2)
        expect(await analyzeStrings(items[0]!, 'href', ctx)).toEqual(['/1'])
        expect(await analyzeStrings(items[1]!, 'href', ctx)).toEqual(['/2'])
    })

    it('CSS 形状 `.box@li`：同上（以前圈到的是 `.box` 本身）', async () => {
        const items = await analyzeSelections(sel2(), '.box@li', ctx)
        expect(items).toHaveLength(2)
        expect(await analyzeStrings(items[0]!, 'text', ctx)).toEqual(['甲'])
    })

    it('CSS 形状 + 显式步骤 `.box@tag.li`：以前整串交给 CSS，直接报错', async () => {
        const items = await analyzeSelections(sel2(), '.box@tag.li', ctx)
        expect(items).toHaveLength(2)
        // 条目是 `li`，地址在它里面的 `a` 上
        expect(await analyzeStrings(items[1]!, 'a@href', ctx)).toEqual(['/2'])
    })

    it('CSS 形状 + 两个 `@`（`.box@ul@li`）：以前同样报错', async () => {
        const items = await analyzeSelections(sel2(), '.box@ul@li', ctx)
        expect(items).toHaveLength(2)
    })

    it('末段是**真属性名**时不动它：`.one@data-id` 仍旧圈到 `.one` 自己', async () => {
        const items = await analyzeSelections(sel2(), '.one@data-id', ctx)
        expect(items).toHaveLength(1)
        expect(await analyzeStrings(items[0]!, 'data-id', ctx)).toEqual(['7'])
    })

    it('前导 `-`（倒置）在这条路上也认：条目顺序反过来', async () => {
        const items = await analyzeSelections(sel2(), '-.box@li', ctx)
        expect(items).toHaveLength(2)
        expect(await analyzeStrings(items[0]!, 'text', ctx)).toEqual(['乙'])
    })

    it('字段规则不受影响：`a@title` 仍旧按**属性**读（`@title` 线上 95 处）', async () => {
        expect(await analyzeStrings(sel2(), 'a@title', ctx)).toEqual(['第一章', '第二章'])
    })

    it('字段规则不受影响：`a@li@a` 这种末尾裸词仍旧是取值（不是步骤）', async () => {
        // 字段规则这条路一个字没改：末尾的 `a` 还是「名为 a 的属性」，取出来是空串
        // （空值在下游被剔掉，所以是 `[]`）。若被当成步骤，这里会是 `['甲','乙']`。
        expect(await analyzeStrings(sel2(), '.box@li@a', ctx)).toEqual([])
    })
})
