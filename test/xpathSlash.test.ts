import { describe, expect, it, vi } from 'vitest'

/**
 * **单斜杠开头的 XPath 按「相对当前节点」解释**
 *
 * 线上 `⚡📂飘天文学` / `📂飘天文学手机版` 的五个字段是这么写的：
 *
 *   bookList: `//div[@class='hot_sale']`      ← 列表规则，作用在整页上
 *   name:     `/a/p[1]/text()`                 ← 字段规则，作用在**这一条**上
 *   author:   `/a/p[2]/text()`
 *   intro:    `/a/p[3]/text()`
 *   bookUrl:  `/a/@href`
 *   coverUrl: `/a/img/@src`
 *
 * 两个错误曾经同时存在，且**都指向静默/看不懂的报错**：
 *
 *   1. `detectKind` 只认 `//` 开头的 XPath，`/a/p[1]/text()` 被当 **CSS** 交给 cheerio
 *      → 抛「CSS 选择器无效，无法解析：/a/p[1]/text()」→ **整条源一本书都搜不到**。
 *   2. 就算认成 XPath，若不前缀 `.`，`/a` 会被当**文档根下的 `a`** 去解释
 *      （根节点下只有 `<html>`，所以一条都取不到）—— 不报错，只是整列字段空着。
 *
 * 这里两边都钉住：`detectKind` 在 test/ruleKind.test.ts，求值语义在本文件。
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

/** 页面里**故意**再放一个文档根层级的 `<a>`：绝对路径若被错用，会先撞上它 */
const PAGE = `<html><body>
<a href="/WRONG" id="doc-level"><p>整页第一个 a</p></a>
<div class="hot_sale">
  <a href="/ptwxz/84039/">
    <img src="https://img.ptwxz.org/files/1479900s.jpg">
    <p>悟空，就决定是你了</p>
    <p>作 者 ：肥宅新秀</p>
    <p>简介：某程序员重生到修真世界</p>
  </a>
</div>
<div class="hot_sale">
  <a href="/ptwxz/84040/">
    <img src="https://img.ptwxz.org/files/1479901s.jpg">
    <p>第二本书名</p>
    <p>作 者 ：另一位</p>
    <p>简介：另一本书的简介</p>
  </a>
</div>
</body></html>`

const ctx = { baseUrl: 'https://m.ptwxz.org/' }
const sel = () => rootSelection(PAGE)

describe('单斜杠 XPath：字段规则相对当前条目', () => {
    it('列表规则 `//div[@class="hot_sale"]` 命中两条条目', async () => {
        const items = await analyzeSelections(sel(), "//div[@class='hot_sale']", ctx)
        expect(items).toHaveLength(2)
    })

    it('五个字段都取到**这一条**的值（不是整页第一个 a、也不是空）', async () => {
        const items = await analyzeSelections(sel(), "//div[@class='hot_sale']", ctx)
        const first = items[0]!
        expect(await analyzeStrings(first, '/a/p[1]/text()', ctx)).toEqual(['悟空，就决定是你了'])
        expect(await analyzeStrings(first, '/a/p[2]/text()', ctx)).toEqual(['作 者 ：肥宅新秀'])
        expect(await analyzeStrings(first, '/a/p[3]/text()', ctx)).toEqual([
            '简介：某程序员重生到修真世界',
        ])
        expect(await analyzeStrings(first, '/a/@href', ctx)).toEqual(['/ptwxz/84039/'])
        expect(await analyzeStrings(first, '/a/img/@src', ctx)).toEqual([
            'https://img.ptwxz.org/files/1479900s.jpg',
        ])
    })

    it('换一条条目，取到的是**那一条**的值（证明是相对当前节点，不是文档级）', async () => {
        const items = await analyzeSelections(sel(), "//div[@class='hot_sale']", ctx)
        const second = items[1]!
        expect(await analyzeStrings(second, '/a/p[1]/text()', ctx)).toEqual(['第二本书名'])
        expect(await analyzeStrings(second, '/a/@href', ctx)).toEqual(['/ptwxz/84040/'])
        // 若被当文档级 `/a`，这里会先撞上 id="doc-level" 那个 a 的 `/WRONG`
        expect(await analyzeStrings(second, '/a/@href', ctx)).not.toContain('/WRONG')
    })

    it('`//` 开头的字段规则语义不变（仍旧相对当前条目往下找）', async () => {
        const items = await analyzeSelections(sel(), "//div[@class='hot_sale']", ctx)
        const first = items[0]!
        expect(await analyzeStrings(first, '//p[1]/text()', ctx)).toEqual(['悟空，就决定是你了'])
    })
})
