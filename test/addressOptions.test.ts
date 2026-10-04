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

vi.mock('../src/engine/js', () => ({
    SandboxError: class SandboxError extends Error {},
    runInSandbox: async () => '',
    sandboxResultToString: (value: unknown) => String(value ?? ''),
    sandboxResultToStrings: (value: unknown) => [String(value ?? '')],
}))

const { analyzeAddress, resolveAddress, resolveCoverAddress, resolveUrl } =
    await import('../src/legado/ops')
const { rootSelection } = await import('../src/engine/analyze')
const { splitUrlAndOptions } = await import('../src/legado/urlOptions')

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

describe('resolveCoverAddress：封面要的是**能被浏览器直接加载**的地址', () => {
    it('选项被丢掉，只留补全后的地址', () => {
        const out = resolveCoverAddress(`/cover/1.jpg${COVER_OPTIONS}`, BASE)
        expect(out).toBe('https://guiwb.nnmh.info/cover/1.jpg')
        expect(out).not.toContain('{')
    })

    it('没有选项时与 resolveAddress 一致', () => {
        expect(resolveCoverAddress('https://cdn.a.com/c.jpg', BASE)).toBe('https://cdn.a.com/c.jpg')
        expect(resolveCoverAddress('/c.jpg', BASE)).toBe('https://guiwb.nnmh.info/c.jpg')
    })
})
