import { describe, expect, it, vi } from 'vitest'

/**
 * `ruleBookInfo.init` 的「**换掉求值的根**」那一半（线上 42 处 / 约 41 个源）
 *
 * 症状与「只取副作用」那半完全不同，值得单独钉住：init 是 `$.data` 而字段写成 `$.title`
 * 时，不换根就是**每条规则都差一层** —— 取到空、不报错。真实接口那几家
 * （⚡📂米读小说 `init: $.data`、⚡📂茄子免费小说 `$.data.book`）返回的都是
 * `{code:0, data:{title:…}}` 这个形状。
 */
vi.mock('../src/engine/js', () => ({
    SandboxError: class SandboxError extends Error {},
    runInSandbox: async () => {
        throw new Error('（测试替身）沙箱不可用')
    },
    sandboxResultToString: (value: unknown) => String(value ?? ''),
    sandboxResultToStrings: (value: unknown) => [String(value ?? '')],
}))

const { analyzeString, resolveInitSelection, rootSelection } = await import('../src/engine/analyze')
const { readInfoVar } = await import('../src/engine/infoVars')

const ctx = () => ({ baseUrl: 'https://example.com' })

const JSON_PAGE = JSON.stringify({
    code: 0,
    data: {
        title: '测试小说·甲',
        author: '作者甲',
        cover: 'https://img.test/1.jpg',
        extra: { note: '嵌套里也有' },
    },
})

const HTML_PAGE = `<html><body>
<div class="book-info"><h1 class="book-name">测试小说·甲</h1>
<span class="book-author">作者甲</span></div>
<div class="other"><span class="book-author">不该被选到</span></div>
</body></html>`

describe('`init` 换根：JSON', () => {
    it('`$.data` + `$.title`：字段相对新的根求值', async () => {
        const c = ctx()
        const sel = rootSelection(JSON_PAGE)
        const base = await resolveInitSelection(sel, '$.data', c)
        expect(base).not.toBeNull()
        expect(await analyzeString(base!, '$.title', c)).toBe('测试小说·甲')
        expect(await analyzeString(base!, '$.author', c)).toBe('作者甲')
        // 递归下降（`$..note`）也在新的根里面找
        expect(await analyzeString(base!, '$..note', c)).toBe('嵌套里也有')
        // 不换根时 `$.title` 什么都取不到 —— 这正是改前的样子
        expect(await analyzeString(sel, '$.title', c)).toBe('')
    })

    it('裸字段名（`title`）与点号路径（`data.book`）也认', async () => {
        const c = ctx()
        const base = await resolveInitSelection(rootSelection(JSON_PAGE), '$.data', c)
        expect(await analyzeString(base!, 'title', c)).toBe('测试小说·甲')

        const nested = JSON.stringify({ data: { book: { t: '乙' } } })
        const two = await resolveInitSelection(rootSelection(nested), 'data.book', c)
        expect(two).not.toBeNull()
        expect(await analyzeString(two!, '$.t', c)).toBe('乙')

        // 裸词 `data` 也当 JSON 路径（`⚡📂少年梦阅读` 的形状）
        const bare = await resolveInitSelection(rootSelection(JSON_PAGE), 'data', c)
        expect(await analyzeString(bare!, '$.title', c)).toBe('测试小说·甲')

        // 带下标的裸词（`⚡📂绿柠小说` 的 `init: data[0]`）
        const list = JSON.stringify({ data: [{ title: '丁' }, { title: '戊' }] })
        const indexed = await resolveInitSelection(rootSelection(list), 'data[0]', c)
        expect(indexed).not.toBeNull()
        expect(await analyzeString(indexed!, '$.title', c)).toBe('丁')
    })

    it('命中一个**字符串**时，那个字符串自己就是新的根（双重编码的接口）', async () => {
        const c = ctx()
        const wrapped = JSON.stringify({ data: JSON.stringify({ title: '丙' }) })
        const base = await resolveInitSelection(rootSelection(wrapped), '$.data', c)
        expect(base).not.toBeNull()
        expect(await analyzeString(base!, '$.title', c)).toBe('丙')
    })

    it('取不到值时**不换根**（沿用整页，不把本来能用的字段一起弄丢）', async () => {
        const c = ctx()
        expect(await resolveInitSelection(rootSelection(JSON_PAGE), '$.nope.deep', c)).toBeNull()
    })

    it('`class.menu` 这种 JSOUP 步骤在 JSON 内容上**不当** JSON 路径', async () => {
        // 不加这条判据的话 `class.menu` 会变成 `$.class.menu` —— 一个永远取不到值的路径
        const c = ctx()
        expect(await resolveInitSelection(rootSelection(JSON_PAGE), 'class.menu', c)).toBeNull()
    })
})

describe('`init` 换根：DOM', () => {
    it('选中的节点成为新的根，后续选择器只在它里面找', async () => {
        const c = ctx()
        const base = await resolveInitSelection(rootSelection(HTML_PAGE), '.book-info', c)
        expect(base).not.toBeNull()
        expect(await analyzeString(base!, '.book-name@text', c)).toBe('测试小说·甲')
        // `.other` 里的同名元素在新根之外 —— 换根之后不该被选到
        expect(await analyzeString(base!, '.book-author@text', c)).toBe('作者甲')
    })

    it('一个节点都没选中时不换根', async () => {
        const c = ctx()
        expect(await resolveInitSelection(rootSelection(HTML_PAGE), '.nope', c)).toBeNull()
    })
})

describe('`init` 只取副作用的那一类：不换根，但要求值', () => {
    it('顶格 `@put:{…}`：变量写进去了，返回 null', async () => {
        const c = ctx()
        const base = await resolveInitSelection(
            rootSelection(HTML_PAGE),
            '@put:{n:".book-name@text"}',
            c,
        )
        expect(base).toBeNull()
        expect(readInfoVar(c, 'n')).toBe('测试小说·甲')
    })

    it('带 `{{}}` / `@js:` / `<js>` 的 init 一律不换根（脚本要自己拿整页）', async () => {
        const c = ctx()
        expect(await resolveInitSelection(rootSelection(HTML_PAGE), '{{$.a}}', c)).toBeNull()
        expect(await resolveInitSelection(rootSelection(HTML_PAGE), '@js:result', c)).toBeNull()
        expect(
            await resolveInitSelection(rootSelection(HTML_PAGE), '<js>result</js>', c),
        ).toBeNull()
    })

    it('init 自己失败时**不抛**：后面的字段空着就好，不连累整页', async () => {
        // 沙箱在测试里是替身（一调用就抛），正好当「脚本写坏」这一路
        const c = ctx()
        expect(
            await resolveInitSelection(rootSelection(HTML_PAGE), '@js:throw new Error("boom")', c),
        ).toBeNull()
        expect(await resolveInitSelection(rootSelection(HTML_PAGE), '<js>boom</js>', c)).toBeNull()
    })
})
