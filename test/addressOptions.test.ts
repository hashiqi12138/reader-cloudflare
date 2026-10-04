/**
 * 地址类字段里的请求选项：**先拆、后拼**（`src/legado/ops.ts` 的 `resolveAddress`）
 *
 * 书源给一条地址写请求选项是很常见的形态：
 *
 *   /api/chapter_info,{"method":"POST","body":"chapter_id=1"}
 *   /cover/1.jpg,{"headers":{"Referer":"https://guiwb.nnmh.info/"}}
 *
 * 而地址类字段拿到的是**相对**地址，要先补成绝对地址。问题就出在这两件事的**顺序**上：
 * `new URL()` 会把 `{` `"` 百分号编码，选项段一旦被编码，
 * `splitUrlAndOptions` 就再也认不出那个 `,{` —— 选项变成地址的一部分被请求，
 * 得到一个必然 404 的地址（**不报错**，症状是「搜不到书 / 目录空 / 封面挂」）。
 *
 * 所以这里守的是一条**闭环**：`resolveAddress` 出来的串，`splitUrlAndOptions` 必须
 * 还能拆回一模一样的选项。顺带把「顺序反了会怎样」也钉住。
 *
 * 沙箱在 Node 里跑不起来（QuickJS 的 `.wasm` 是顶层 import），所以替换掉它 ——
 * 本文件只用纯函数。
 */

import { describe, expect, it, vi } from 'vitest'

/** `<js>` / `@js:` 段的输出，用来造多行的规则值 */
const sandbox = vi.hoisted(() => ({ output: '' }))

vi.mock('../src/engine/js', () => ({
    SandboxError: class SandboxError extends Error {},
    runInSandbox: async () => sandbox.output,
    sandboxResultToString: (value: unknown) => String(value ?? ''),
    sandboxResultToStrings: (value: unknown) => [String(value ?? '')],
}))

const {
    analyzeAddress,
    booksFromItems,
    hasAddressOptions,
    needsCoverProxy,
    resolveAddress,
    resolveCoverAddress,
    resolveUrl,
} = await import('../src/legado/ops')
const { analyzeSelections, rootSelection } = await import('../src/engine/analyze')
const { splitUrlAndOptions } = await import('../src/legado/urlOptions')
type BookSource = import('../src/engine/types').BookSource
type FieldWarning = import('../src/legado/ops').FieldWarning

const BASE = 'https://guiwb.nnmh.info/comic/1.html'
const COVER_OPTIONS = ',{"headers":{"Referer":"https://guiwb.nnmh.info/"}}'

describe('resolveAddress：先拆选项，再补全地址，再把选项接回去', () => {
    it('相对地址被补成绝对地址，选项**一个字符都没变**（闭环）', () => {
        const out = resolveAddress(`/cover/1.jpg${COVER_OPTIONS}`, BASE)
        expect(out).toBe(`https://guiwb.nnmh.info/cover/1.jpg${COVER_OPTIONS}`)
        // 闭环：这一步出来的串，下游（buildPlan / 媒体代取）还要能原样拆开
        expect(splitUrlAndOptions(out).options).toEqual({
            headers: { Referer: 'https://guiwb.nnmh.info/' },
        })
    })

    it('POST 选项（目录 / 章节地址的那些）同样原样保留', () => {
        const raw = '/api/chapter_info,{"method":"POST","body":"chapter_id=7&token=x"}'
        const out = resolveAddress(raw, 'https://api.newlucifer.com/s/Reader/x')
        expect(out).toBe(
            'https://api.newlucifer.com/api/chapter_info,{"method":"POST","body":"chapter_id=7&token=x"}',
        )
        expect(splitUrlAndOptions(out).options).toEqual({
            method: 'POST',
            body: 'chapter_id=7&token=x',
        })
    })

    it('逗号后带空白（`, {`）也算选项，接回去时不留那截空白', () => {
        const out = resolveAddress('/search.php, \t {"method": "post"}', 'http://a.com/')
        expect(out).toBe('http://a.com/search.php,{"method": "post"}')
        expect(splitUrlAndOptions(out).options).toEqual({ method: 'post' })
    })

    it('选项里的 `{{}}` 模板原样留着（要在 buildPlan 那一层才展开）', () => {
        const out = resolveAddress('/s,{"body":"k={{key}}&p={{page}}"}', 'https://a.com/')
        expect(out).toBe('https://a.com/s,{"body":"k={{key}}&p={{page}}"}')
        expect(splitUrlAndOptions(out).options).toEqual({ body: 'k={{key}}&p={{page}}' })
    })

    it('没有选项时与 resolveUrl 完全一致（绝大多数地址走这条）', () => {
        for (const raw of ['/book/1.html', 'https://other.com/a?b=1', '', '  ']) {
            expect(resolveAddress(raw, BASE)).toBe(resolveUrl(raw, BASE))
        }
    })

    it('可选段 `<,{{page}}>` **不被**当成选项（认错会抛「选项不是合法 JSON」）', () => {
        // 这个形态只出现在 `searchUrl` / `exploreUrl`（走 buildPlan，可选段在展开模板时
        // 就处理掉了），地址类字段里没有它；这里守的是「判据与 splitUrlAndOptions 一致」
        const raw = '/list/<,index_{{page}}.html>'
        expect(resolveAddress(raw, BASE)).toBe(resolveUrl(raw, BASE))
        expect(splitUrlAndOptions(resolveAddress(raw, BASE)).options).toEqual({})
    })

    it('**顺序反了会怎样**：先补全地址，选项就永久坏了（这就是改前那条路）', () => {
        const wrong = resolveUrl(`/cover/1.jpg${COVER_OPTIONS}`, BASE)
        expect(wrong).toContain('%7B') // 花括号被百分号编码
        expect(splitUrlAndOptions(wrong).options).toEqual({}) // 下游再也拆不出来
    })
})

describe('模板拼出来的字面地址 + 选项（`⚡📂新小书亭` 的形状）', () => {
    /**
     * 这条链**依赖展开顺序**：先由字段规则那一层把 `{{$.bookId}}` 展开成数字，
     * 再交给 `resolveAddress` 拆选项 —— 展开之后 `{"bookId":7}` 才是合法 JSON。
     * 顺序反了（先解析选项）就会报「请求选项不是合法 JSON」，而这正是书源原文的样子：
     * 它写的是 `"bookId": {{$.bookId}}`，**不加引号**。
     */
    it('选项里不加引号的模板，展开成数字之后能被拆开', async () => {
        const item = rootSelection('{"id":7}')
        const raw = await analyzeAddress(
            item,
            'http://app.1001p.com/api/book/bookDetail,{"body":{"bookId":{{$.id}}},"method":"POST"}',
            { baseUrl: 'http://app.1001p.com' },
        )
        expect(raw).toBe(
            'http://app.1001p.com/api/book/bookDetail,{"body":{"bookId":7},"method":"POST"}',
        )
        const split = splitUrlAndOptions(raw)
        expect(split.url).toBe('http://app.1001p.com/api/book/bookDetail')
        expect(split.options.body).toBe('{"bookId":7}')
    })
})

describe('多行的规则值：取「第一条地址」，但**选项块整体保留**', () => {
    const item = () => rootSelection('<html><body></body></html>')
    const rule = '@js:result'

    it('选项块是排版过的 JSON（三行）时不能被按行切开', async () => {
        // `⚡📂新小书亭` 的 bookUrl / tocUrl / chapterUrl、`⚡📂米读小说` 的 bookUrl
        // 都是这个形状。按行切只会剩半截 `…getDetail,{`
        sandbox.output =
            'http://app.1001p.com/api/book/bookDetail,{\n  "body": { "bookId": 12345 },\n  "method": "POST"\n}'
        const raw = await analyzeAddress(item(), rule, { baseUrl: 'https://a.com' })
        expect(raw).toBe(
            'http://app.1001p.com/api/book/bookDetail,{\n  "body": { "bookId": 12345 },\n  "method": "POST"\n}',
        )
        // 下游还要能拆开 —— 这才是「整段保留」的意义
        const split = splitUrlAndOptions(raw)
        expect(split.url).toBe('http://app.1001p.com/api/book/bookDetail')
        // 对象 body 会被序列化（见 urlOptions 的 normalizeBody），空白随之规范化
        expect(split.options.body).toBe('{"bookId":12345}')
        expect(split.options.method).toBe('POST')
    })

    it('多个并列候选（没有选项块）仍旧取第一条', async () => {
        // 喜马拉雅的 nextTocUrl 一次拼出 9 条地址，就是这个形状
        sandbox.output = 'https://a.com/1.html\nhttps://a.com/2.html\nhttps://a.com/3.html'
        expect(await analyzeAddress(item(), rule, { baseUrl: 'https://a.com' })).toBe(
            'https://a.com/1.html',
        )
    })

    it('多行选项块后面还跟着别的候选时，只取带选项的那一段', async () => {
        sandbox.output = 'https://a.com/x,{\n "method": "POST"\n}\nhttps://b.com/y'
        expect(await analyzeAddress(item(), rule, { baseUrl: 'https://a.com' })).toBe(
            'https://a.com/x,{\n "method": "POST"\n}',
        )
    })

    it('选项块里的字符串值带括号也不会配错（`{`/`}` 在引号里不算配平）', async () => {
        sandbox.output = 'https://a.com/x,{"method":"POST","body":"a={b}"}\nhttps://b.com/y'
        const raw = await analyzeAddress(item(), rule, { baseUrl: 'https://a.com' })
        expect(raw).toBe('https://a.com/x,{"method":"POST","body":"a={b}"}')
        expect(splitUrlAndOptions(raw).options.body).toBe('a={b}')
    })
})

describe('展示用字段的容错：坏规则不该让整条搜索失败', () => {
    /**
     * 第四十五轮抽样体检的量：🎨拷贝漫画 的 `coverUrl` 写着一个多了一个 `)` 的 XPath，
     * 求值抛错 → 整条搜索 `ok=false`，一本书都搜不到（书名、地址、目录都是好的）。
     */
    const PAGE = `<html><body><div class="item">
        <a href="/book/1">书</a><p class="intro">简介</p>
    </div></body></html>`
    const source = { bookSourceName: 'x', bookSourceUrl: 'https://a.com' } as BookSource
    const itemsOf = () =>
        analyzeSelections(rootSelection(PAGE), 'div.item', { baseUrl: 'https://a.com' })

    it('坏掉的 `coverUrl` 只让该字段为空，书照常返回，好的字段不受连累', async () => {
        const warnings: FieldWarning[] = []
        const books = await booksFromItems(
            source,
            await itemsOf(),
            {
                name: 'a@text',
                bookUrl: 'a@href',
                intro: 'p.intro@text',
                coverUrl: '//p[@class="x"])/@src',
            },
            { baseUrl: 'https://a.com' },
            'https://a.com',
            warnings,
        )
        expect(books).toHaveLength(1)
        expect(books[0]!.name).toBe('书')
        expect(books[0]!.coverUrl).toBeUndefined()
        expect(books[0]!.intro).toBe('简介')
        expect(books[0]!.bookUrl).toBe('https://a.com/book/1')
        // 留空但**不静默**：原因带在 warnings 里
        expect(warnings).toHaveLength(1)
        expect(warnings[0]!.field).toBe('coverUrl')
        expect(warnings[0]!.message).toMatch(/XPath/)
    })

    it('链路字段（`bookUrl`）坏掉时必须**抛错** —— 吞掉它就成了「搜不到书、不报错」', async () => {
        await expect(
            booksFromItems(
                source,
                await itemsOf(),
                { name: 'a@text', bookUrl: '//p[@class="x"])/@href' },
                { baseUrl: 'https://a.com' },
                'https://a.com',
                [],
            ),
        ).rejects.toThrow()
    })
})

describe('resolveCoverAddress：封面**保留**选项，交给 /api/media 代取（第四十七轮）', () => {
    /**
     * 第四十三轮这里把选项**丢掉**了，理由是「封面由浏览器 `<img src>` 直接加载」。
     * 丢掉之后地址是合法的 —— 但对**防盗链**封面没有用：地址对、图仍然 403。
     * 第四十七轮改成保留选项 + 由 `/api/media` 代取（会合并选项里的 `Referer`）。
     */
    it('选项被保留 —— 代取正要靠它里面的 Referer', () => {
        const out = resolveCoverAddress(`/cover/1.jpg${COVER_OPTIONS}`, BASE)
        expect(out).toBe(`https://guiwb.nnmh.info/cover/1.jpg${COVER_OPTIONS}`)
        // 闭环：这张封面被签进 /api/media 的令牌之后，代取那一侧还要能拆回同一个请求头
        expect(splitUrlAndOptions(out).options).toEqual({
            headers: { Referer: 'https://guiwb.nnmh.info/' },
        })
    })

    it('行为与 resolveAddress 一致（封面只是**叫法不同**，好让意图写在名字上）', () => {
        expect(resolveCoverAddress('https://cdn.a.com/c.jpg', BASE)).toBe('https://cdn.a.com/c.jpg')
        expect(resolveCoverAddress('/c.jpg', BASE)).toBe('https://guiwb.nnmh.info/c.jpg')
        expect(resolveCoverAddress(`/cover/1.jpg${COVER_OPTIONS}`, BASE)).toBe(
            resolveAddress(`/cover/1.jpg${COVER_OPTIONS}`, BASE),
        )
    })
})

describe('hasAddressOptions：一张封面要不要走代取', () => {
    it('带 `,{...}` 的算，其余不算', () => {
        expect(hasAddressOptions(`https://a.com/1.jpg${COVER_OPTIONS}`)).toBe(true)
        expect(hasAddressOptions('https://a.com/1.jpg')).toBe(false)
        // 可选段 `<,{{page}}>` 里那个 `,{` 不算（判据与 splitUrlAndOptions 同一条）
        expect(hasAddressOptions('https://a.com/list/<,{{page}}>.html')).toBe(false)
        expect(hasAddressOptions('')).toBe(false)
    })
})

/**
 * 代取的判据（第四十八轮：从「只看带选项」放宽到「再加 http」）
 *
 * 抽样实测：真实返回的封面里 **86%** 是 `http:`（老小说站大量没有 https）——
 * 而我们部署在 https 上，这些封面会被当成**混合内容**拦掉，浏览器连请求都不发。
 * 所以判据是「带选项 **或** http」，其余（https 且不带选项）不代取。
 */
describe('needsCoverProxy：这两类封面浏览器自己取不到', () => {
    it('带请求选项的算（防盗链，线上 8 处 / 4 源）', () => {
        expect(needsCoverProxy(`http://a.com/1.jpg${COVER_OPTIONS}`)).toBe(true)
        expect(needsCoverProxy(`https://a.com/1.jpg${COVER_OPTIONS}`)).toBe(true)
    })

    it('http 的算（混合内容，抽样里占 86%）', () => {
        expect(needsCoverProxy('http://www.8xiaoshuo.net/headimgs/0/86/s86.jpg')).toBe(true)
        expect(needsCoverProxy('http://a.com/1.jpg')).toBe(true)
    })

    it('https 且不带选项的不算 —— 浏览器直接就能加载，不为它多花一次签名与子请求', () => {
        expect(needsCoverProxy('https://img.ptwxz.org/files/1s.jpg')).toBe(false)
        expect(needsCoverProxy('https://a.com/1.jpg')).toBe(false)
        expect(needsCoverProxy('')).toBe(false)
    })
})
