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
 * 沙箱在 Node 里跑不起来（QuickJS 的 `.wasm`），所以换成**回显型替身**：
 * 于是「脚本看到的是什么内容、什么形态」成了可断言的东西。
 *
 * **注意这一组钉的是「引擎交给沙箱什么」，不是端到端行为。** 其中**多命中**那两条
 * 在真实 workerd 里还没跑通（冒烟 4d 只断言了单命中那条）：同一个选择器命中 2 个以上
 * 元素时，宿主侧看起来拿到的是空节点集，`result.size()` 算出来是 0。
 * 差异还没定位，缺口记在 README 的「后续计划」里 —— 所以这里的绿色**不等于**那条路能用。
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

describe('优先级：按字符串用 > 按 jsoup 用', () => {
    it('两种写法混在一起时按字符串算，**内容也不换绑节点**', async () => {
        // `String(result)` 与 `result.split` 是字符串写法 → result 是取值结果（纯文本）
        const result = await seen(
            'div.row@js:String(result).split("甲").length + result.select("a").size()',
        )
        expect(typeof result).toBe('string')
        expect(result).toBe('甲\n乙')
    })

    it('顶格 `@js:` 仍然绑页面原文（前面没有选择器）', async () => {
        const result = await seen('@js:result.size() > 0 ? result : ""')
        expect(result).toBe(sel().source)
    })
})
