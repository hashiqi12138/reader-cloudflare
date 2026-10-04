import { describe, expect, it, vi } from 'vitest'

/**
 * `@put:{…}` / `@get:{键}` 在**规则求值**这一层的行为
 *
 * 解析单独在 `infoVars.test.ts` 里钉住；这里看的是「写完能不能读到」以及
 * 「嵌在文字 / 地址里会不会被当成选择器」—— 后者是这条路的典型症状：
 * 不处理的话整段被当成 CSS 选择器，cheerio **不报错、只返回空**。
 *
 * 形状取自线上：`⚡📂万象书城` / 📂夜伴书屋 的 `init` 是顶格多键 `@put:{…}`、
 * 其余字段 `@get:{a}`；`📂言情小说大全` 的 intro 是「`@put:` + 文字 + `@get:`」；
 * `🎨武芊漫画` 的 chapterUrl 是「URL 里嵌 `@get:`」。
 */
vi.mock('../src/engine/js', () => ({
    SandboxError: class SandboxError extends Error {},
    runInSandbox: async () => {
        throw new Error('（测试替身）沙箱不可用')
    },
    sandboxResultToString: (value: unknown) => String(value ?? ''),
    sandboxResultToStrings: (value: unknown) => [String(value ?? '')],
}))

const { analyzeStrings, rootSelection } = await import('../src/engine/analyze')
const { readInfoVar } = await import('../src/engine/infoVars')

const HTML = `<html><body>
<div class="book-info">
<h1 class="book-name">测试小说·甲</h1>
<span class="book-author">作者甲</span>
<div class="book-intro">这是一本用于验证链路的小说。</div>
<a class="toc-link" href="/fixture/toc/1">查看目录</a>
</div>
</body></html>`

/** 一次「请求」= 一个 ctx：变量表挂在它上面（有会话时挂在会话上） */
const ctx = () => ({ baseUrl: 'https://example.com' })
const sel = () => rootSelection(HTML)

describe('`@put:` / `@get:` 端到端', () => {
    it('顶格 `@put:{…}` 写变量，`@get:{键}` 读回来（`init` 的形状）', async () => {
        const c = ctx()
        await analyzeStrings(
            sel(),
            '@put:{n:".book-name@text", a:".book-author@text", i:".book-intro@text"}',
            c,
        )
        expect(readInfoVar(c, 'n')).toBe('测试小说·甲')
        expect(await analyzeStrings(sel(), '@get:{n}', c)).toEqual(['测试小说·甲'])
        expect(await analyzeStrings(sel(), '@get:{a}', c)).toEqual(['作者甲'])
        expect(await analyzeStrings(sel(), '@get:{i}', c)).toEqual(['这是一本用于验证链路的小说。'])
    })

    it('取不到的键给空串（不是「没实现」也不是报错）', async () => {
        expect(await analyzeStrings(sel(), '@get:{没有这个键}', ctx())).toEqual([''])
    })

    it('后缀写法：规则自身的值仍是前缀那条规则（`title@put:{bid:$.id}`）', async () => {
        const c = ctx()
        const values = await analyzeStrings(sel(), '.book-name@put:{bid:".toc-link@href"}', c)
        expect(values).toEqual(['测试小说·甲'])
        expect(readInfoVar(c, 'bid')).toBe('/fixture/toc/1')
    })

    it('嵌在文字里：`编号：@get:{n}` 是字面文本，不是选择器', async () => {
        const c = ctx()
        await analyzeStrings(sel(), '@put:{n:".book-name@text"}', c)
        expect(await analyzeStrings(sel(), '编号：@get:{n}', c)).toEqual(['编号：测试小说·甲'])
    })

    it('嵌在地址里：`…&comic_id=@get:{k}&order=0` 整条是字面地址', async () => {
        const c = ctx()
        await analyzeStrings(sel(), '@put:{cid:".toc-link@href"}', c)
        expect(
            await analyzeStrings(sel(), 'https://x.test/a?p=1&cid=@get:{cid}&order=0', c),
        ).toEqual(['https://x.test/a?p=1&cid=/fixture/toc/1&order=0'])
    })

    it('「`@put:` + 文字 + `@get:`」一起写（`📂言情小说大全` 的 intro）', async () => {
        const c = ctx()
        const intro = await analyzeStrings(
            sel(),
            '@put:{bookid:".toc-link@href"}\n编号：@get:{bookid}\n作者：@get:{a}',
            c,
        )
        expect(intro).toEqual(['编号：/fixture/toc/1\n作者：'])
    })

    it('变量只活在这一次上下文里（换一个 ctx 读不到）', async () => {
        const c1 = ctx()
        await analyzeStrings(sel(), '@put:{n:".book-name@text"}', c1)
        expect(await analyzeStrings(sel(), '@get:{n}', ctx())).toEqual([''])
    })
})
