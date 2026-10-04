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

    it('字段规则不受影响：`a@li@a` 的**末段**裸词仍旧是取值（不是标签）', async () => {
        // 字段规则这条路上，**末段**永远按取值读（`@title` 95 处、`@data-id` 就是靠这个）。
        // 这一条锁的是那一点：`.box@li@a` 里 `a` 是「名为 a 的属性」，取出来是空串
        // （`.box` 下两个 `li` 都没有 `a` 属性）。
        //
        // 中间那段 `li` 在第三十八轮之后会当**步骤**（`@` 分派与列表规则共用）——
        // 所以这里有**两个**空串而不是一个：条目从「一个 `.box`」变成了「两个 `li`」。
        // 若把末段的 `a` 也当成标签，这里会是 `['甲','乙']`。
        expect(await analyzeStrings(sel2(), '.box@li@a', ctx)).toEqual(['', ''])
    })

    /**
     * 列表规则里的 `!` **排除下标**
     *
     * `class.grid@tag.tr!0`（⚡📂笔趣阁）、`class.listmain@dd!0:1:…:11`（⚡📂鬼吹灯）、
     * `.txt-list li!0`（📂格格党）—— 线上列表规则里这一类共 **110 处 / 129 个源**。
     * 以前 `tr!0` 被整段当成标签名交给 CSS，cheerio 对非法选择器**不报错、静默返回空**：
     * 症状与上一轮那族一样，是「目录 0 条 / 搜索 0 条，全程不报错」。
     */
    it('CSS 形状 `.box li!0`：排除第 1 个条目（`!` 与 `[!0]` 等价）', async () => {
        const items = await analyzeSelections(sel2(), '.box li!0', ctx)
        expect(items).toHaveLength(1)
        expect(await analyzeStrings(items[0]!, 'text', ctx)).toEqual(['乙'])
        expect(await analyzeSelections(sel2(), '.box li[!0]', ctx)).toHaveLength(1)
    })

    it('JSOUP 形状 `class.box@li!0@a`：排除第 1 个，地址仍按条取到', async () => {
        const items = await analyzeSelections(sel2(), 'class.box@li!0@a', ctx)
        expect(items).toHaveLength(1)
        expect(await analyzeStrings(items[0]!, 'href', ctx)).toEqual(['/2'])
    })

    it('`!` 后面用 `:` 隔开是一串下标：`.box li!0:1` 两个都排除 → 空', async () => {
        expect(await analyzeSelections(sel2(), '.box li!0:1', ctx)).toEqual([])
    })

    it('`!` 与开头 `-`（倒置）并存：`.box li!0` 倒过来仍是同一条', async () => {
        const items = await analyzeSelections(sel2(), '-.box li!0', ctx)
        expect(items).toHaveLength(1)
        expect(await analyzeStrings(items[0]!, 'text', ctx)).toEqual(['乙'])
    })
})

/**
 * CSS 式首段里的 **JSOUP 位置后缀**：`.book-dir.1@li`、`.chapter[1]@a`、`.row[-1]@a`
 *
 * 书源会把 JSOUP 的位置写法直接缀在 CSS 选择器后面，线上这一类 **46 处 / 42 个源**。
 * 整段交给 CSS 的话 `.book-dir.1` 不是合法选择器（也会被判成「CSS 选择器无效」或被静默
 * 忽略），目录一律 0 条 —— ⚡📂企鹅阅读、📂冰清阁小说 就是这么躺着的。
 *
 * 语义：**先把位置套在首段上，再往下走 `@` 后面的步骤**。
 */
describe('CSS 式首段带 JSOUP 位置后缀', () => {
    const HTML3 = `<html><body>
<div class="list"><div class="chapter"><a href="/1">甲</a></div>
<div class="chapter"><a href="/2">乙</a></div>
<div class="chapter"><a href="/3">丙</a></div></div>
<div class="wrap"><ul class="dir"><li><a href="/x">丁</a></li>
<li><a href="/y">戊</a></li></ul></div>
</body></html>`
    const sel3 = () => rootSelection(HTML3)

    it('点号形式 `.chapter.1@a`：取第 2 个 `.chapter`（下标从 0 起）', async () => {
        const items = await analyzeSelections(sel3(), '.chapter.1@a', ctx)
        expect(items).toHaveLength(1)
        expect(await analyzeStrings(items[0]!, 'href', ctx)).toEqual(['/2'])
    })

    it('方括号形式 `.chapter[-1]@a`：取最后一个', async () => {
        const items = await analyzeSelections(sel3(), '.chapter[-1]@a', ctx)
        expect(items).toHaveLength(1)
        expect(await analyzeStrings(items[0]!, 'href', ctx)).toEqual(['/3'])
    })

    it('CSS 片段混在 `@` 后面：`.wrap@.dir@li a`（`.dir` 与带空格的 `li a` 都当 CSS）', async () => {
        // 注意这一段**不能**写成 `.wrap@#dir`：`@#` 是 `splitRegexChain` 里「字面量 #」的
        // 转义（见 `regex.ts` 的 `protectEscapes`），选择器里那么写会被还原成 `.wrap#dir`，
        // 语义完全不同。全量语料里 `@#` 出现 **0 次**，所以那是条没有人踩的路。
        const items = await analyzeSelections(sel3(), '.wrap@.dir@li a', ctx)
        expect(items).toHaveLength(2)
        expect(await analyzeStrings(items[0]!, 'href', ctx)).toEqual(['/x'])
    })

    it('区间形式（`[0:1]`）也认：首段只留前两个', async () => {
        const items = await analyzeSelections(sel3(), '.chapter[0:1]@a', ctx)
        expect(items).toHaveLength(2)
        expect(await analyzeStrings(items[1]!, 'href', ctx)).toEqual(['/2'])
    })

    it('不是位置的那些后缀原样交给 CSS：`[href="/2"]` 不被当成序号吞掉', async () => {
        // `[…]` 里不是数字（属性选择器）时 `splitCssIndex` 原样返回 —— 这一条锁的是
        // 那个回退：不能把 `.data[*]` / `[href*='.html']` 这类当成位置吞掉
        const items = await analyzeSelections(sel3(), 'div.chapter a[href="/2"]', ctx)
        expect(items).toHaveLength(1)
        expect(await analyzeStrings(items[0]!, 'text', ctx)).toEqual(['乙'])
    })
})

/**
 * JSOUP 简写：`class.A B` 里的空格 = **「这两个类都要有」**
 *
 * jsoup 的 `getElementsByClass(名字)` 内部把参数按空白拆开、要求**每一个**都命中（AND），
 * 所以 `class.tags text-truncate` 等价于 CSS 的 `.tags.text-truncate`。
 * 线上这个形状共 **151 处 / 71 源**，横跨五个分组（ruleBookInfo 68、ruleSearch 32、
 * ruleToc 29、ruleContent 13、ruleExplore 9），是「主类 + 工具类」那种写法：
 * `class.comics-card__title text-truncate`、`class.playlist clearfix`。
 *
 * 以前整段当成**一个**类名去转义，得到 `.tags\ text-truncate`
 * —— 那是「类名里带空格」，现实里不存在：cheerio 不报错、**静默返回 0 条**。
 */
describe('JSOUP 简写：`class.A B` 是「两个类都要有」', () => {
    const PAGE = `<html><body>
<div class="playlist clearfix"><a href="/1">甲</a></div>
<div class="playlist"><a href="/2">乙</a></div>
<div class="clearfix"><a href="/3">丙</a></div>
</body></html>`

    it('列表规则：圈到的是两个类都有的那个', async () => {
        const items = await analyzeSelections(rootSelection(PAGE), 'class.playlist clearfix@a', ctx)
        expect(items).toHaveLength(1)
        expect(await analyzeStrings(items[0]!, 'text', ctx)).toEqual(['甲'])
    })

    it('字段规则：同一条转换，`@` 后面接着取文本', async () => {
        expect(
            await analyzeStrings(rootSelection(PAGE), 'class.playlist clearfix@a@text', ctx),
        ).toEqual(['甲'])
    })

    it('是 AND：只带一个类的元素不命中，也不是「后代」', async () => {
        // 单类各命中 2 个（甲、乙 与 甲、丙），两个类一起只命中 1 个（甲）。
        // 若实现成 OR 会得到 3 条，实现成后代选择器（`.playlist clearfix`）会得到 0 条。
        expect(await analyzeStrings(rootSelection(PAGE), 'class.playlist@text', ctx)).toHaveLength(
            2,
        )
        expect(await analyzeStrings(rootSelection(PAGE), 'class.clearfix@text', ctx)).toHaveLength(
            2,
        )
        expect(
            await analyzeStrings(rootSelection(PAGE), 'class.playlist clearfix@text', ctx),
        ).toEqual(['甲'])
    })
})
