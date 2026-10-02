import { describe, expect, it, vi } from 'vitest'

/**
 * 规则前缀的大小写
 *
 * 线上真实分布（594 条源的规则**开头**）：`@CSS:` 32 处、`@JSon:` 25 处、
 * `@Json:` 4 处、`@XPath:` 3 处。早先只认全小写，这些规则会**静默返回空** ——
 * 而 `{{@JSon:$.a}}`（模板那条路）却因为 `template.ts` 带了 `/i` 能用，
 * 同一个引擎对同一个前缀有两种行为。
 *
 * 这里测的是**可观察的结果**，不是匹配函数本身：前缀认出来之后，
 * `@CSS:` 要真的按 CSS 选、`@JSon:` 要真的按 JSONPath 取、`@JS:` 要真的进沙箱。
 *
 * `analyze.ts` 会 import 沙箱（带 QuickJS 的 `.wasm`，Node 里加载不了），
 * 所以把沙箱整个换成会抛错的替身 —— 这样「有没有进沙箱」本身就成了可断言的信号。
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

const HTML = `<html><body>
<div class="item"><h3>甲</h3><a href="/a">链接甲</a></div>
<div class="item"><h3>乙</h3><a href="/b">链接乙</a></div>
</body></html>`

const JSON_TEXT = '{"attributes":{"author":"作者甲"},"data":{"books":[{"name":"书甲"}]}}'

const ctx = { baseUrl: 'https://example.com' }
const html = () => rootSelection(HTML)
const json = () => rootSelection(JSON_TEXT)

describe('@css: 的大小写', () => {
    it('@CSS: 与 @css: 结果一致（线上 32 处，含 ruleContent.content）', async () => {
        const lower = await analyzeString(html(), '@css:div.item h3@text', ctx)
        const upper = await analyzeString(html(), '@CSS:div.item h3@text', ctx)
        expect(upper).toBe(lower)
        expect(upper).toBe('甲\n乙')
    })

    it('@Css: 这种混合写法也认', async () => {
        expect(await analyzeString(html(), '@Css:div.item h3@text', ctx)).toBe('甲\n乙')
    })

    it('@CSS: 用在列表规则上时圈出的是 2 个条目，不是整页 1 个', async () => {
        // 前缀没认出来时它会被当成 JSOUP 简写：`@CSS` 解析出空步骤，
        // `selectNodes` 原样返回根节点 —— 也就是**整页变成一个条目**
        const items = await analyzeSelections(html(), '@CSS:div.item', ctx)
        expect(items).toHaveLength(2)
    })

    it('带取值后缀与净化链的正文规则照常工作', async () => {
        // 🎭🎬露西弗俱乐部的正文就是这一形态：`@CSS:div.luf_news_contents@html##<font…`
        expect(await analyzeString(html(), '@CSS:div.item a@href', ctx)).toBe('/a\n/b')
    })
})

describe('@json: 的大小写', () => {
    it('@JSon: 与 @json: 结果一致（线上 25 处）', async () => {
        expect(await analyzeString(json(), '@json:$.attributes.author', ctx)).toBe('作者甲')
        expect(await analyzeString(json(), '@JSon:$.attributes.author', ctx)).toBe('作者甲')
    })

    it('@Json: 也认（🎨再漫画 的 ruleSearch.bookList 就是这个写法）', async () => {
        expect(await analyzeString(json(), '@Json:$.data.books[0].name', ctx)).toBe('书甲')
    })
})

describe('@xpath: 的大小写', () => {
    it('三种写法结果一致', async () => {
        const lower = await analyzeString(html(), '@xpath://h3/text()', ctx)
        const camel = await analyzeString(html(), '@XPath://h3/text()', ctx)
        const upper = await analyzeString(html(), '@XPATH://h3/text()', ctx)
        expect(lower).toBe('甲\n乙')
        expect(camel).toBe(lower)
        expect(upper).toBe(lower)
    })
})

describe('@js: 的大小写', () => {
    it('@JS: 会进沙箱，而不是被当成选择器静默返回空', async () => {
        // 替身抛错就是「进了沙箱」的证据
        await expect(analyzeString(html(), '@JS:1+1', ctx)).rejects.toThrow('沙箱不可用')
    })

    it('选择器后面接的 @JS: 尾巴同样会进沙箱', async () => {
        await expect(analyzeString(html(), 'div.item@JS:result', ctx)).rejects.toThrow('沙箱不可用')
    })

    it('`|` 连接符切分时也把 @JS: 当 JS 区域（否则 JS 里的 || 会被切碎）', async () => {
        // 规则里 JS 代码含 `||`：切分只要把 `@JS:` 认成普通选择器，这段就会被切成两半，
        // 进沙箱的那半截语法不合法 —— 断言「进了沙箱」而不是「报语法错」就够区分了
        await expect(analyzeString(html(), 'div.item@JS:result || ""', ctx)).rejects.toThrow(
            '沙箱不可用',
        )
    })
})

describe('前缀之外不做大小写折叠', () => {
    it('CSS 选择器本身仍然区分大小写（只折叠前缀）', async () => {
        // 若实现是「整条规则转小写再比前缀」，这条就会误命中
        expect(await analyzeString(html(), '@CSS:DIV.ITEM@text', ctx)).toBe('')
        expect(await analyzeString(html(), '@CSS:div.item@text', ctx)).toBe('甲链接甲\n乙链接乙')
    })

    it('JSONPath 的字段名同样区分大小写', async () => {
        expect(await analyzeString(json(), '@JSon:$.ATTRIBUTES.author', ctx)).toBe('')
        expect(await analyzeString(json(), '@JSon:$.attributes.author', ctx)).toBe('作者甲')
    })
})
