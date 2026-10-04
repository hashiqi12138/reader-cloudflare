import { describe, expect, it, vi } from 'vitest'

/**
 * **字段规则**里的 CSS 式规则：`首段@步骤…@取值`
 *
 * 与 `listRules.test.ts` 分开写，因为两条路的语义**有一处故意不同**：
 *   - 列表规则：末段那个裸词若是 HTML 标签名，要当**步骤**（`#chapterlist@li a` 的 `a`）
 *   - 字段规则：末段永远当**取值**（`@title` 95 处、`@data-id` 就是靠这个），
 *     中间的段才按标签/步骤处理
 *
 * 这条路上的病与列表规则同源：以前只切最后一个 `@`，剩下的 `.xsm.0@a` 被当成 CSS，
 * cheerio 对非法选择器**不报错、只是返回空** —— 症状是「搜索成功、书名/作者整列空着」。
 * 线上这类「中间还有段」的共 **746 处 / 221 个源**。
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

const HTML = `<html><body>
<div class="book"><h2 class="title"><a href="/b1">书名甲</a></h2>
<p class="author"><a href="/aut1">作者甲</a></p></div>
<div class="book"><h2 class="title"><a href="/b2">书名乙</a></h2>
<p class="author"><a href="/aut2">作者乙</a></p></div>
<ul class="list"><li>一</li><li>二</li><li>三</li></ul>
<p class="one" data-id="7">丙</p>
</body></html>`

const ctx = { baseUrl: 'https://example.com' }
const sel = () => rootSelection(HTML)

describe('字段规则：CSS 式「首段 + 步骤」', () => {
    it('中间有步骤 `.book@h2@a@text`：以前整串当 CSS，静默取不到', async () => {
        expect(await analyzeStrings(sel(), '.book@h2@a@text', ctx)).toEqual(['书名甲', '书名乙'])
    })

    it('`@` 后面是 CSS 片段（`.book@.author@a@text`）：`.author` 拼回首段', async () => {
        expect(await analyzeStrings(sel(), '.book@.author@a@text', ctx)).toEqual([
            '作者甲',
            '作者乙',
        ])
    })

    it('首段带下标 `.book.0@a@text` / `.book[-1]@a@text`：下标套在首段上', async () => {
        expect(await analyzeStrings(sel(), '.book.0@h2@a@text', ctx)).toEqual(['书名甲'])
        expect(await analyzeStrings(sel(), '.book[-1]@h2@a@text', ctx)).toEqual(['书名乙'])
    })

    it('中间段带 `!` 排除下标 `.list li!0@text`：排出第 1 条', async () => {
        // 与列表规则同一套「排除」语义（第三十七轮追加的那一半）
        expect(await analyzeStrings(sel(), '.list li!0@text', ctx)).toEqual(['二', '三'])
        expect(await analyzeStrings(sel(), '.list li!1:2@text', ctx)).toEqual(['一'])
    })

    it('前导 `-`（倒置）与列表规则同一套语义', async () => {
        expect(await analyzeStrings(sel(), '-.list@li@text', ctx)).toEqual(['三', '二', '一'])
    })

    it('单段的规则一个字没变：`.one@data-id` 仍旧是属性取值', async () => {
        expect(await analyzeStrings(sel(), '.one@data-id', ctx)).toEqual(['7'])
        expect(await analyzeStrings(sel(), '.book@h2@a@href', ctx)).toEqual(['/b1', '/b2'])
    })

    it('末段永远是取值（字段规则与列表规则**在这里故意不同**）', async () => {
        // `.list@li` 的末段 `li` 是「名为 li 的属性」，不是标签 —— 首段就是那**一个** `ul`，
        // 取 `li` 属性取不到，所以是一个空串。若把末段当标签（列表规则那条路的语义），
        // 这里会是三个 `li` 节点、`text` 取值给出 `['一','二','三']`。
        expect(await analyzeStrings(sel(), '.list@li', ctx)).toEqual([''])
        expect(await analyzeStrings(sel(), '.list@li@text', ctx)).toEqual(['一', '二', '三'])
    })

    it('不吃掉 `@` 在方括号里的规则（属性选择器原样交给 CSS）', async () => {
        // 全量语料里 CSS 式字段规则「`@` 出现在方括号内」是 0 处，这一条把它钉成不变量
        expect(await analyzeStrings(sel(), '.book a[href="/b2"]@text', ctx)).toEqual(['书名乙'])
    })
})
