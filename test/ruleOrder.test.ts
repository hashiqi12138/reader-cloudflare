import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 规则的求值顺序：**连接符 → `@js:` → `##` 链**
 *
 * 这个顺序本身有语义，两件事都挂在上面：
 *
 *   1. `@js:` 是分界线，两边的 `##` 链各归各自那一侧：
 *        `选择器@js:代码##过滤##替换`  →  选择器 → JS → 链
 *        `选择器##过滤##替换@js:代码`  →  选择器 → 链 → JS
 *      两种写法线上各 20 多处。旧实现在 `##` 链**之后**才找 `@js:`，于是第二种里的
 *      `@js:` 连同代码一起进了替换串：脚本一次都不执行，而且不报错
 *      （🎨🔞污污漫画 的正文因此少了包 `<img>` 那一步）。
 *   2. **空选择器 = 当前原文**：`##正则##替换` 直接开头的规则靠这条从整页里抠字段
 *      （⚡📂未来天王 六个字段、🔞PO18文学、📂被电子书 …）。之前它落到空数组上，
 *      这些字段一律取不到值，而且不报错。
 *
 * 沙箱在 Node 里跑不起来（QuickJS 的 `.wasm`），所以这里换成**回显型替身**：
 * 它把 `result` 原样回显，于是"脚本看到的是什么"就成了可断言的东西 ——
 * 这正是先后顺序的唯一证据。
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

const { analyzeSelections, analyzeStrings, rootSelection } = await import('../src/engine/analyze')
const { splitJsTail } = await import('../src/engine/ruleText')

const HTML = `<html><body><div class="x"><p>甲</p><p>乙</p></div><span>总字数：12345<</span></body></html>`
const ctx = { baseUrl: 'https://example.com' }
const sel = () => rootSelection(HTML)

beforeEach(() => {
    state.calls.length = 0
})

describe('splitJsTail：把规则切成「前置 + JS + 尾链」', () => {
    it('链在 JS 之前 —— 前置那一段整个带着链', () => {
        expect(splitJsTail('div.x##过滤##替换@js:代码')).toEqual({
            before: 'div.x##过滤##替换',
            code: '代码',
            after: '',
        })
    })

    it('链在 JS 之后 —— 尾链单独切出来', () => {
        expect(splitJsTail('div.x@js:代码##过滤##替换')).toEqual({
            before: 'div.x',
            code: '代码',
            after: '##过滤##替换',
        })
    })

    it('两边各有一条链', () => {
        expect(splitJsTail('div.x##前##A@js:代码##后##B')).toEqual({
            before: 'div.x##前##A',
            code: '代码',
            after: '##后##B',
        })
    })

    it('整条以 `@js:` 开头（`before` 为空）', () => {
        expect(splitJsTail('@js:代码')).toEqual({ before: '', code: '代码', after: '' })
    })

    it('`@js:` 的大小写不敏感（线上有 `@JS:`）', () => {
        expect(splitJsTail('div.x@JS:代码')?.code).toBe('代码')
        expect(splitJsTail('div.x@Js:代码')?.code).toBe('代码')
    })

    it('代码里**引号内**的 `##` 不算链的分界', () => {
        // `jsCodeEnd` 只看不在引号里的 `##`，代码本身可以放心写 `"##"`
        expect(splitJsTail('div.x@js:a = "##"; b##过滤##替换')).toEqual({
            before: 'div.x',
            code: 'a = "##"; b',
            after: '##过滤##替换',
        })
    })

    it('没有 `@js:` 就是 null', () => {
        expect(splitJsTail('div.x##过滤##替换')).toBeNull()
        expect(splitJsTail('div.x')).toBeNull()
    })

    it('`<js>` 块里写的 `@js:` 是脚本文本，不算标记', () => {
        expect(splitJsTail(`div.x<js>var s = '@js: 假的'</js>`)).toBeNull()
    })
})

describe('`选择器##过滤##@js:代码`：脚本在链之后跑', () => {
    it('脚本看到的 `result` 已经是过滤过的值', async () => {
        expect(await analyzeStrings(sel(), '.x p@text##甲##A@js:code', ctx)).toEqual(['A\n乙'])
        expect(state.calls).toHaveLength(1)
        expect(state.calls[0]?.code).toBe('code')
        // 关键：`甲` 已经被链换成了 `A`，脚本拿到的不是原始值
        expect(state.calls[0]?.result).toBe('A\n乙')
    })

    it('尾链再作用在脚本的输出上（两边各一条链）', async () => {
        // 前置链把 `甲` 换成 `A`，脚本原样回显，尾链再把 `A` 换成 `B`
        expect(await analyzeStrings(sel(), '.x p@text##甲##A@js:code##A##B', ctx)).toEqual([
            'B\n乙',
        ])
    })
})

describe('`选择器@js:代码##过滤##替换`：脚本在链之前跑（主线写法，不能被改坏）', () => {
    it('脚本看到的是原始值，链作用在脚本输出上', async () => {
        expect(await analyzeStrings(sel(), '.x p@text@js:code##甲##A', ctx)).toEqual(['A\n乙'])
        expect(state.calls[0]?.result).toBe('甲\n乙')
    })
})

describe('`@js:` 尾巴的其余形态', () => {
    it('整条只有 `@js:` 时，`result` 是页面原文', async () => {
        await analyzeStrings(sel(), '@js:code', ctx)
        expect(state.calls[0]?.result).toBe(HTML)
    })

    it('没有 `@js:` 的规则根本不进沙箱', async () => {
        expect(await analyzeStrings(sel(), '.x p@text', ctx)).toEqual(['甲', '乙'])
        expect(state.calls).toHaveLength(0)
    })

    it('冗余的 `@` 标记（`选择器@@js:代码`）照样认', async () => {
        // 选择器不会以 `@` 结尾，尾巴上那个 `@` 只可能属于标记
        expect(await analyzeStrings(sel(), '.x p@text@@js:code', ctx)).toEqual(['甲\n乙'])
    })

    it('`<js>` 块走自己那条路，块里的 `@js:` 文本不会被当成标记', async () => {
        await analyzeStrings(sel(), `.x p@text<js>var s = '@js: 假的'</js>`, ctx)
        expect(state.calls).toHaveLength(1)
        expect(state.calls[0]?.code).toBe(`var s = '@js: 假的'`)
    })
})

describe('空选择器 = 当前原文', () => {
    it('`##正则##替换` 直接从整页里抠字段（🔞PO18文学 的 wordCount 就是这个形状）', async () => {
        expect(await analyzeStrings(sel(), '##总字数：([^<]+)<##$1###', ctx)).toEqual(['12345'])
    })

    it('取值链（`###`）作用在整页上：取第一个匹配', async () => {
        // `##甲##A###`：从整页里找第一个 `甲` 并把它换成 `A` → 结果就是那**一段**
        expect(await analyzeStrings(sel(), '##甲##A###', ctx)).toEqual(['A'])
    })

    it('空选择器只对**取值链**成立：净化链没有「被净化的值」，就什么都不取', async () => {
        // `##广告##`（净化）要的是一个「被净化的值」，空选择器给不出来。
        // 真按整页净化的话，`text||##最新章节.*` 这种 `||` 兜底分支会返回整页
        expect(await analyzeStrings(sel(), '##广告##', ctx)).toEqual([])
        expect(await analyzeStrings(sel(), '.x p@nope@text||##最新章节.*', ctx)).toEqual([])
    })

    it('空选择器 + `@js:` 尾巴：脚本拿到的是**链处理过的**原文', async () => {
        // 🔞PO18文学#14 / 🔞肉文屋# / ⚡📂️笔趣阁 / 🔞御宅屋 的 wordCount 都是这个形状。
        // 修 `@js:` 顺序之前脚本一次都不跑（取到空）；只修顺序而不认空选择器的话，
        // 脚本会拿到空串、`'' + '字'` 得出一个假值 —— 所以这两件事必须一起做
        expect(await analyzeStrings(sel(), '##总字数：([^<]+)<##$1###@js:code', ctx)).toEqual([
            '12345',
        ])
        expect(state.calls[0]?.result).toBe('12345')
    })
})

describe('列表规则也要认这些写法', () => {
    it('`选择器##过滤##@js:代码` 会交给沙箱，而不是走节点那条路把 JS 丢掉', async () => {
        // 节点那条路（CSS/XPath）跑不了脚本：`ops` 之后的结果会被直接当条目。
        // 所以这里必须看到沙箱被调用过 —— 没有这一步就是「静默少了一整段逻辑」
        const items = await analyzeSelections(sel(), 'div.x p##甲##A@js:code', ctx)
        expect(state.calls).toHaveLength(1)
        expect(state.calls[0]?.code).toBe('code')
        expect(items).toHaveLength(1)
    })
})
