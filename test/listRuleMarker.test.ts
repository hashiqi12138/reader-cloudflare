import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 列表规则上的两个「标记」：开头的 `+` 与**顶格** `<js>` 块里的 `result`
 *
 * 两件事都出自同一类症状 —— **规则跑起来了，但看到的不是它要的那份内容**：
 *
 *   1. 开头的 `+`（线上 8 处）早先直接抛「列表规则 AllInOne(js) 暂未实现」，
 *      于是 `+@css:.bookbox` 这种纯 CSS 列表规则整条目录/搜索变成一条明确报错。
 *      语料证明它不是 AllInOne（AllInOne 必须以 `:` 开头），剥掉即可。
 *   2. 顶格 `<js>` 块里的 `result` 之前是**空串**（它从 `values = []` 起步），
 *      而 Top-level `<js>` 与顶格 `@js:` 是同一件事：`result` 该是**页面原文**。
 *      `⚡📂全本小说网`/`📂基友书屋`/`📂趣书小说`/`🔞po18城` 的目录规则都靠它。
 *
 * 沙箱在 Node 里跑不起来（QuickJS 的 `.wasm`），所以换成**回显型替身**：
 * 把 `result` 原样回显，于是「脚本看到的是什么」成了可断言的东西。
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

const { analyzeSelections, rootSelection } = await import('../src/engine/analyze')

const HTML = `<html><body><div class="x"><p>甲</p><p>乙</p></div><ul class="bd"><li>一</li><li>二</li></ul></body></html>`
const ctx = { baseUrl: 'https://example.com' }
const sel = () => rootSelection(HTML)

/** 取整页原文（`rootSelection` 的 source） */
const PAGE = sel().source

beforeEach(() => {
    state.calls.length = 0
})

describe('列表规则开头的 `+`：剥掉之后按后面的规则求值', () => {
    it('`+@css:` 与不带 `+` 的写法结果一致', async () => {
        const withPlus = await analyzeSelections(sel(), '+@css:.x', ctx)
        const without = await analyzeSelections(sel(), '@css:.x', ctx)
        expect(withPlus.length).toBe(1)
        expect(withPlus.map((s) => s.source)).toEqual(without.map((s) => s.source))
        // 剥掉之后跑的是选择器，沙箱一次都不该进
        expect(state.calls).toHaveLength(0)
    })

    it('`+@css:` 里的列表级连接符照常生效', async () => {
        const items = await analyzeSelections(sel(), '+@css:.nope||@css:ul.bd li', ctx)
        expect(items).toHaveLength(2)
    })

    it('`+@js:` 剥完就是顶格 `@js:` —— `result` 是页面原文', async () => {
        const items = await analyzeSelections(sel(), '+@js:result', ctx)
        expect(state.calls).toHaveLength(1)
        expect(state.calls[0]!.result).toBe(PAGE)
        // 回显回来的就是整页，于是条目数 1、内容为整页
        expect(items).toHaveLength(1)
        expect(items[0]!.source).toBe(PAGE)
    })

    it('`+@js:` 里的脚本看到的是**没被净化过**的原文（与顶格 `@js:` 同一份）', async () => {
        const plus = await analyzeSelections(sel(), '+@js:result', ctx)
        const bare = await analyzeSelections(sel(), '@js:result', ctx)
        expect(state.calls.map((c) => c.result)).toEqual([PAGE, PAGE])
        expect(plus.map((s) => s.source)).toEqual(bare.map((s) => s.source))
    })

    it('`+<js>…</js>` 剥完是顶格 `<js>` —— 同样拿到页面原文', async () => {
        await analyzeSelections(sel(), '+<js>result.match(/li/g)</js>', ctx)
        expect(state.calls).toHaveLength(1)
        expect(state.calls[0]!.result).toBe(PAGE)
    })

    it('`ctx.result` 在时优先于页面原文（与 `@js:` 那条路一致）', async () => {
        await analyzeSelections(sel(), '+@js:result', {
            baseUrl: 'https://example.com',
            result: '响应体',
        })
        expect(state.calls[0]!.result).toBe('响应体')
    })

    it('只有一个 `+` 时返回空列表，而不是把空串交给下游', async () => {
        expect(await analyzeSelections(sel(), '+', ctx)).toEqual([])
        expect(await analyzeSelections(sel(), '  +  ', ctx)).toEqual([])
        expect(state.calls).toHaveLength(0)
    })
})

describe('顶格 `<js>` 块里的 `result`：页面原文', () => {
    it('块在规则最前面时，`result` 是页面原文', async () => {
        await analyzeSelections(sel(), '<js>String(result)</js>ul.bd li', ctx)
        expect(state.calls).toHaveLength(1)
        expect(state.calls[0]!.result).toBe(PAGE)
    })

    it('**前面跑过选择器**时不许塞整页：命中 0 个就该是空', async () => {
        // 「选择器取不到东西」不能变成「取到一整页」——那会让一个空规则变成通配。
        // 这里 `result` 原样返回，所以按 `resultShape.ts` 的判据绑成**数组**，
        // 空命中就是空数组；下面那一条换成读字符串的写法，验的是空串。
        await analyzeSelections(sel(), '.nope<js>result</js>', ctx)
        expect(state.calls).toHaveLength(1)
        expect(state.calls[0]!.result).toEqual([])

        state.calls.length = 0
        await analyzeSelections(sel(), '.nope<js>String(result)</js>', ctx)
        expect(state.calls[0]!.result).toBe('')
    })

    it('前面跑过选择器且**命中**时，`result` 是命中内容的拼接', async () => {
        await analyzeSelections(sel(), 'ul.bd li<js>result</js>', ctx)
        expect(state.calls).toHaveLength(1)
        expect(String(state.calls[0]!.result)).toContain('一')
        expect(String(state.calls[0]!.result)).toContain('二')
        expect(String(state.calls[0]!.result)).not.toBe(PAGE)
    })

    it('`<js></js>` 空块仍然只当分隔符，不进沙箱（也就无所谓 result 是什么）', async () => {
        await analyzeSelections(sel(), '<js></js>ul.bd li', ctx)
        expect(state.calls).toHaveLength(0)
    })
})
