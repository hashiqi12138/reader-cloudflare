/*
 * 正文的 HTML 摊平（`src/engine/htmlText.ts`）
 *
 * 这一层守的是「正文里不能出现标签、`<br>` 与块级边界要变成换行」。
 * 为什么要有它、线上实测到了什么，见那个文件的文件头。
 *
 * 只测这一个文件：它除了 cheerio 什么都不依赖，能在 Node 里直接跑。
 * 「摊平之后还要过 `normalizeContent`」那一半在 `npm run smoke` 里端到端验
 * —— 收尾那个函数住在 `src/legado/ops.ts`，把它拉进单测会把 QuickJS 的 WASM
 * 一起拽进来（Node 里加载不了那个 `import '*.wasm'`）。
 *
 * 断言用 `lines()`（按行切开、去空白、丢空行）而不是比整串：**行首尾的空白与空行
 * 本来就不是这一层的职责**（`htmlToText` 会留下缩进产生的空白行，`normalizeContent`
 * 随后统一收掉）。这一层真正要钉住的是「哪几段、什么顺序」。
 * 唯一的例外是「本来就是纯文本时原样返回」那一条 —— 那必须是逐字相同。
 */

import { describe, expect, it } from 'vitest'

import { htmlToText, looksLikeHtml } from '../src/engine/htmlText'

/** 摊平后的**段落**（去空白、丢空行），也就是阅读界面最终看到的那几行 */
const lines = (text: string) =>
    text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')

describe('looksLikeHtml', () => {
    it('有真标签就是 HTML', () => {
        expect(looksLikeHtml('<br>')).toBe(true)
        expect(looksLikeHtml('第一段<br>第二段')).toBe(true)
        expect(looksLikeHtml('<p>x</p>')).toBe(true)
        expect(looksLikeHtml('</p>')).toBe(true)
        expect(looksLikeHtml('<div class="a">')).toBe(true)
        expect(looksLikeHtml('<P>')).toBe(true)
    })

    it('「含 `<`」不算 —— 小说正文里出现小于号是有可能的', () => {
        expect(looksLikeHtml('他写下 x<y 与 a<b')).toBe(false)
        expect(looksLikeHtml('甲<乙>丙')).toBe(false)
        expect(looksLikeHtml('<3')).toBe(false)
        expect(looksLikeHtml('<无名>')).toBe(false)
    })

    it('纯文本当然不算', () => {
        expect(looksLikeHtml('')).toBe(false)
        expect(looksLikeHtml('第一段\n第二段')).toBe(false)
        expect(looksLikeHtml('“斗之力，三段！”')).toBe(false)
    })
})

describe('htmlToText', () => {
    it('`<br>` 变成换行（这一轮要修的就是这件事）', () => {
        expect(lines(htmlToText('第一段<br>第二段'))).toEqual(['第一段', '第二段'])
        expect(lines(htmlToText('第一段<br/>第二段'))).toEqual(['第一段', '第二段'])
        expect(lines(htmlToText('第一段<BR>第二段'))).toEqual(['第一段', '第二段'])
    })

    it('块级边界变成换行', () => {
        expect(lines(htmlToText('<p>甲</p><p>乙</p>'))).toEqual(['甲', '乙'])
        expect(lines(htmlToText('<div>甲</div><div>乙</div>'))).toEqual(['甲', '乙'])
        expect(lines(htmlToText('<div>甲<div>乙</div>丙</div>'))).toEqual(['甲', '乙', '丙'])
        expect(lines(htmlToText('<ul><li>甲</li><li>乙</li></ul>'))).toEqual(['甲', '乙'])
        expect(lines(htmlToText('<h1>卷名</h1>正文'))).toEqual(['卷名', '正文'])
    })

    it('**内联**元素不切段：`<span>甲</span><span>乙</span>` 还是「甲乙」', () => {
        expect(lines(htmlToText('<span>甲</span><span>乙</span>'))).toEqual(['甲乙'])
        expect(lines(htmlToText('甲<b>乙</b>丙'))).toEqual(['甲乙丙'])
        expect(lines(htmlToText('<a href="/x">链接</a>之后'))).toEqual(['链接之后'])
    })

    it('连续 `<br>` 与嵌套块不会切出空段', () => {
        expect(lines(htmlToText('甲<br><br>乙'))).toEqual(['甲', '乙'])
        expect(lines(htmlToText('<div><p>甲</p></div>'))).toEqual(['甲'])
        expect(lines(htmlToText('<p>甲</p><p> </p><p>乙</p>'))).toEqual(['甲', '乙'])
    })

    it('`<script>` / `<style>` / 注释都不进正文', () => {
        expect(lines(htmlToText('<div><script>read_top()</script>正文</div>'))).toEqual(['正文'])
        expect(lines(htmlToText('<style>.a{color:red}</style>正文'))).toEqual(['正文'])
        expect(lines(htmlToText('甲<!-- 注释 -->乙'))).toEqual(['甲乙'])
    })

    it('实体在解析时就解开了', () => {
        expect(htmlToText('甲&nbsp;乙')).toBe('甲\u00a0乙')
        expect(htmlToText('甲&amp;乙')).toBe('甲&乙')
        expect(htmlToText('甲&lt;乙&gt;丙')).toBe('甲<乙>丙')
    })

    it('只剩空壳的标签什么都不产出 —— 净化正则删掉文字后留下的正是这种', () => {
        expect(lines(htmlToText('<a href="javascript:top()"></a>'))).toEqual([])
        expect(lines(htmlToText('正文<a href="javascript:top()"></a>'))).toEqual(['正文'])
    })

    it('本来就没有标签的字符串**逐字**返回（`@textNodes` 那条路就靠它）', () => {
        expect(htmlToText('普通正文')).toBe('普通正文')
        expect(htmlToText('第一段\n第二段')).toBe('第一段\n第二段')
        expect(htmlToText('')).toBe('')
    })
})

describe('线上那两个真实形状', () => {
    it('梦芳小说：`id.rtext@html`，段落全在 `<p>` 里；正则删掉文字后留下空壳', () => {
        const text = htmlToText(
            '<p>“斗之力，三段！” </p><p> </p><p>望着测验魔石碑</p><a href="javascript:$()">↑返回顶部↑</a>',
        )
        expect(lines(text)).toEqual(['“斗之力，三段！”', '望着测验魔石碑', '↑返回顶部↑'])
        expect(text).not.toMatch(/<[^>]*>/)
    })

    it('笔趣全家桶：`#nr1@html`，正文 div 里还挂着 `<script>read_top()</script>`', () => {
        const text = htmlToText(
            '<script>read_top()</script> <div id="text"><p> 萧炎：主角</p></div>',
        )
        expect(lines(text)).toEqual(['萧炎：主角'])
        expect(text).not.toContain('read_top')
        expect(text).not.toMatch(/<[^>]*>/)
    })

    it('情豆书坊：`#nr1@html` 那种一整页 `<p> </p>` 空段', () => {
        const text = htmlToText('<p> </p> <p> 文案：</p> <p> 好想见你 可不可以</p> <p> </p>')
        expect(lines(text)).toEqual(['文案：', '好想见你 可不可以'])
    })
})
