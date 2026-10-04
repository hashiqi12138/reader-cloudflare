/**
 * 规则方言的判定：这条规则该交给 CSS、JSOUP 简写、JSONPath 还是 XPath
 *
 * 判错的后果不是报错，而是**走错解析器** —— 而错的那一侧通常给的是空值或一句
 * 指向别处的报错：
 *
 *   `dd.2:3@text`（线上 📂阳光小说 的 kind）以前没被认成 JSOUP 简写，
 *   于是整条规则被当 CSS 解析，抛「CSS 选择器无效，无法解析：dd.2:3」。
 *   错误信息把方向指向 CSS 写法，而真正的问题是「这个简写形态没被认出来」。
 *
 * 沙箱在 Node 里跑不起来（QuickJS 的 `.wasm`），所以这里用替身（与 test/ruleOrder.test.ts 同一套）。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/engine/js', () => ({
    SandboxError: class SandboxError extends Error {},
    runInSandbox: async () => '',
    sandboxResultToString: () => '',
    sandboxResultToStrings: () => [],
}))

const { detectKind } = await import('../src/engine/analyze')

describe('规则方言判定', () => {
    it('JSOUP 简写的各种形态都认（含点号位置后面跟 `:N`）', () => {
        for (const rule of [
            'dd.2:3@text', // 线上一处：`标签.下标:下标`
            'class.odd.0@tag.a.0@text',
            'tag.a@href',
            'a.0',
            'head@.1@text',
            'text.下一页@href',
            'children',
            'dd[2:3]@text', // 方括号形态：与上面的点号形态走同一套位置解析
        ]) {
            expect(detectKind(rule).kind, rule).toBe('jsoup')
        }
    })

    it('真正的 CSS 不会被误判成简写', () => {
        for (const rule of [
            'div#content@textNodes',
            'div.item a@href',
            'h3.title@text',
            '.col-md-6@dl',
            'ul.lists@li',
        ]) {
            expect(detectKind(rule).kind, rule).toBe('css')
        }
    })
})
