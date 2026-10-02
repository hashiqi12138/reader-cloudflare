import { describe, expect, it, vi } from 'vitest'

/**
 * XPath 规则末尾的取值后缀，走**整条求值链**验一遍
 *
 * 单测（`xpath.test.ts` 里的 `splitXPathExtract`）钉的是拆分规则本身；
 * 这里钉的是「拆完之后，整条规则真的按预期取到值」—— 中间要经过
 * 连接符切分、`##` 正则链剥离、方言分派、`//` → `.//` 改写、取值后缀应用。
 *
 * 用例的形态都取自线上真实规则（594 条源里 XPath 段 250 处）：
 *   - `//a[text()="下一页"]/../../../div[3]@html`（🎈腐小说 的正文）
 *   - `…/pre@text##……`（🔞御宅屋 的简介：取值后缀 + 正则链）
 *   - `//div[@class='title_box']/a/@href`（📂搬山人小说网：属性节点，**不能**当后缀）
 *
 * `analyze.ts` 会 import 沙箱（带 QuickJS 的 `.wasm`，Node 里加载不了），
 * 所以把沙箱换成会抛错的替身 —— 本文件没有一条用例需要真的跑 JS。
 */
vi.mock('../src/engine/js', () => ({
    SandboxError: class SandboxError extends Error {},
    runInSandbox: async () => {
        throw new Error('（测试替身）沙箱不可用')
    },
    sandboxResultToString: (value: unknown) => String(value ?? ''),
    sandboxResultToStrings: (value: unknown) => [String(value ?? '')],
}))

const { analyzeSelections, analyzeString, rootSelection } = await import('../src/engine/analyze')

/**
 * 页面结构照着「下一页 + 正文」那类站点的样子摆：
 * 导航里有个写着「下一页」的链接，正文是容器里的第 3 个 div 子节点。
 */
const HTML = `<html><body>
<div id="container">
  <div class="header"><div class="nav"><a href="/n/2" title="标题">下一页</a></div></div>
  <div>隔一个</div>
  <div class="real-content" data-id="7">真正的正文<em>粗体</em></div>
</div>
<h3>简介</h3>
<div class="intro-box"><pre>第一行
第二行</pre></div>
<ul class="chapter-list">
  <li><a href="/c/1">第一章</a></li>
  <li><a href="/c/2">第二章</a></li>
</ul>
</body></html>`

const ctx = { baseUrl: 'https://example.com' }
const sel = () => rootSelection(HTML)

describe('XPath 取值后缀：真的取到值', () => {
    it('`div[3]@html` 取内部 HTML（🎈腐小说 的正文就是这个形状）', async () => {
        expect(await analyzeString(sel(), '//a[text()="下一页"]/../../../div[3]@html', ctx)).toBe(
            '真正的正文<em>粗体</em>',
        )
    })

    it('`@text` 取文本，且后面接的 `##` 正则链照样生效', async () => {
        // 🔞御宅屋 的简介形态：先按后缀取值，再跑净化链
        expect(await analyzeString(sel(), '//div[@class="real-content"]@text', ctx)).toBe(
            '真正的正文粗体',
        )
        expect(
            await analyzeString(sel(), '//div[@class="real-content"]@text##粗体$##（完）', ctx),
        ).toBe('真正的正文（完）')
    })

    it('多级轴后面接后缀也认（`following-sibling` + `@text`）', async () => {
        expect(
            await analyzeString(
                sel(),
                "//h3[contains(text(),'简介')]/following-sibling::div[1]/pre@text",
                ctx,
            ),
        ).toBe('第一行\n第二行')
    })

    it('`@XPath:` 前缀写法与裸 `//` 等价', async () => {
        expect(await analyzeString(sel(), '@XPath://div[@class="real-content"]@html', ctx)).toBe(
            '真正的正文<em>粗体</em>',
        )
    })
})

describe('XPath 自己的属性节点不能被当成取值后缀（线上 70 处都是这一形态）', () => {
    it('`/@href`、`/@title`、`/@data-id` 取的是属性', async () => {
        expect(await analyzeString(sel(), '//a[@title="标题"]/@href', ctx)).toBe('/n/2')
        expect(await analyzeString(sel(), '//a[@title="标题"]/@title', ctx)).toBe('标题')
        expect(await analyzeString(sel(), '//div[@class="real-content"]/@data-id', ctx)).toBe('7')
    })

    it('谓词里的 `@class` 不会把表达式切坏', async () => {
        // 按「最后一个 @」切的话这里会变成 `//div[` → XPath 语法错误
        expect(await analyzeString(sel(), '//div[@class="real-content"]', ctx)).toBe(
            '真正的正文粗体',
        )
    })
})

describe('取值后缀不影响列表规则', () => {
    it('列表规则把后缀丢掉，条目本身照常圈出来', async () => {
        // 列表规则要的是节点（后续字段规则还要在上面筛），后缀在这里没有意义；
        // 留着它会变成 `//ul[...]/li@html` → 不是合法 XPath → 整条目录为空
        const items = await analyzeSelections(sel(), '//ul[@class="chapter-list"]/li@html', ctx)
        expect(items).toHaveLength(2)
        // 圈出来的确实是那两个 li：在条目上继续跑字段规则能取到章节名
        expect(await analyzeString(items[0]!, 'a@text', ctx)).toBe('第一章')
        expect(await analyzeString(items[1]!, 'a@text', ctx)).toBe('第二章')
    })

    it('没有后缀的列表规则行为不变', async () => {
        const items = await analyzeSelections(sel(), '//ul[@class="chapter-list"]/li', ctx)
        expect(items).toHaveLength(2)
    })

    it('列表规则是属性节点时仍然丢掉属性（属性不能当后续规则的上下文）', async () => {
        const items = await analyzeSelections(sel(), '//ul[@class="chapter-list"]//@href', ctx)
        expect(items).toHaveLength(0)
    })
})

describe('函数名与 `(` 之间有空格（⚡📂书荒小说 的目录规则就是这么写的）', () => {
    it('规范化之后照常求值', async () => {
        // XPath 1.0 允许这个空格，`xpath` 包不允许 —— 不规范化的话整条规则报解析错
        expect(
            await analyzeString(
                sel(),
                "//h3[(contains (.,'简介'))]/following-sibling::div[1]/pre",
                ctx,
            ),
        ).toBe('第一行\n第二行')
    })

    it('`and (` / `or (` 这类运算符不受影响', async () => {
        // 去掉运算符后的空白会把它变成函数调用，语义就变了 —— 所以规范化只认函数名白名单
        expect(await analyzeString(sel(), "//div[@class='real-content' and (1 = 1)]", ctx)).toBe(
            '真正的正文粗体',
        )
    })
})

describe('标量表达式与无后缀路径不受影响', () => {
    it('选中元素但没写后缀时取它的文本（原有行为）', async () => {
        expect(await analyzeString(sel(), '//div[@class="real-content"]', ctx)).toBe(
            '真正的正文粗体',
        )
    })

    it('裸的函数式 XPath（`string(...)`）走不到 XPath —— 线上 0 处，先不动分派', async () => {
        // `detectKind` 只把 `@xpath:` / `//` / `(/` 开头的规则分给 XPath，所以这种写法
        // 会被当成 CSS 选择器。线上 594 条源里一处都没有（量过），而改分派要动**所有规则**
        // 的路由，所以先不改。这里钉住的是「至少是明确报错，不是静默返回空」——
        // 将来真要支持，把它改成断言结果即可
        await expect(analyzeString(sel(), 'string(//div)', ctx)).rejects.toThrow(/CSS 选择器无效/)
    })
})
