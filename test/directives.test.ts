import { describe, expect, it } from 'vitest'

import { indexOfJsMarker, JS_MARKER, matchDirective, ruleHasJs } from '../src/engine/directives'

/**
 * 规则前缀的匹配（`@css:` / `@json:` / `@js:` / `@xpath:` 与 `<js>`）
 *
 * 这个模块存在的意义就是「五处共用一个源」，所以这里除了常规用例，
 * 重点钉两种**互相认错**的边界：
 *   - `@json:` 不能被当成 `@js:`（少一个字母就换了整条求值路径）；
 *   - 大小写只折叠**前缀**，前缀之后的内容原样保留（CSS 选择器与 JSONPath 字段名都区分大小写）。
 */
describe('matchDirective', () => {
    it('拆出前缀与剩余部分', () => {
        expect(matchDirective('@css:div.item')).toEqual({ name: 'css', body: 'div.item' })
        expect(matchDirective('@json:$.a.b')).toEqual({ name: 'json', body: '$.a.b' })
        expect(matchDirective('@js:1+1')).toEqual({ name: 'js', body: '1+1' })
        expect(matchDirective('@xpath://h3')).toEqual({ name: 'xpath', body: '//h3' })
    })

    it('大小写不敏感（线上 @CSS: 32 处、@JSon: 25 处、@Json: 4 处）', () => {
        for (const rule of ['@CSS:div', '@Css:div', '@css:div']) {
            expect(matchDirective(rule)).toEqual({ name: 'css', body: 'div' })
        }
        for (const rule of ['@JSon:$.a', '@Json:$.a', '@json:$.a']) {
            expect(matchDirective(rule)).toEqual({ name: 'json', body: '$.a' })
        }
        for (const rule of ['@XPath://a', '@XPATH://a', '@xpath://a']) {
            expect(matchDirective(rule)).toEqual({ name: 'xpath', body: '//a' })
        }
        for (const rule of ['@JS:x', '@js:x', '@Js:x']) {
            expect(matchDirective(rule)).toEqual({ name: 'js', body: 'x' })
        }
    })

    it('**只折叠前缀**：前缀之后的内容原样保留大小写', () => {
        expect(matchDirective('@CSS:DIV.Item@text')).toEqual({ name: 'css', body: 'DIV.Item@text' })
        expect(matchDirective('@JSon:$.AUTHOR')).toEqual({ name: 'json', body: '$.AUTHOR' })
        expect(matchDirective('@JS:result.TEXT()')).toEqual({ name: 'js', body: 'result.TEXT()' })
    })

    it('不是指令就返回 null', () => {
        expect(matchDirective('div.item')).toBeNull()
        expect(matchDirective('$.a.b')).toBeNull()
        expect(matchDirective('//h3')).toBeNull()
        expect(matchDirective('css:div')).toBeNull() // 少了 `@`
        expect(matchDirective('@css')).toBeNull() // 少了冒号
        expect(matchDirective('')).toBeNull()
    })

    it('前置空白不算指令 —— 调用方各自先 trim（与原来的 /^@js:/ 行为一致）', () => {
        expect(matchDirective(' @css:div')).toBeNull()
        expect(matchDirective('@css:div')).not.toBeNull()
    })

    it('不认识的前缀不会被误认', () => {
        // `@get:` / `@post:` 是 URL 字段上的请求方法标记，不是选择器指令
        expect(matchDirective('@get:https://a')).toBeNull()
        expect(matchDirective('@webjs:x')).toBeNull()
    })
})

describe('indexOfJsMarker', () => {
    it('找得到 `@js:` 的位置，大小写不敏感', () => {
        expect(indexOfJsMarker('div.item@js:code')).toBe(8)
        expect(indexOfJsMarker('div.item@JS:code')).toBe(8)
        expect(indexOfJsMarker('div.item@Js:code')).toBe(8)
    })

    it('找不到返回 -1', () => {
        expect(indexOfJsMarker('div.item')).toBe(-1)
        expect(indexOfJsMarker('div.item@text')).toBe(-1)
    })

    it('`@json:` **不能**被当成 `@js:`', () => {
        // 少一个字母就换了整条求值路径：`@json:` 该走 JSONPath，被当成 `@js:` 就成了
        // 「`on:$.a` 这段代码」交给沙箱 —— 两个都不报错，只是结果全不对
        expect(indexOfJsMarker('@json:$.a')).toBe(-1)
        expect(indexOfJsMarker('div@JSON:$.a')).toBe(-1)
    })

    it('从 from 之后开始找（连接符切分要一段一段往后扫）', () => {
        const rule = 'a@js:xb@Js:y' // 第二个标记在下标 7
        const first = indexOfJsMarker(rule)
        expect(first).toBe(1)
        expect(indexOfJsMarker(rule, first + JS_MARKER.length)).toBe(7)
        expect(indexOfJsMarker(rule, 8)).toBe(-1)
    })

    it('`@js:` 的长度是常量 4（切片时用，不能写死数字）', () => {
        expect(JS_MARKER).toBe('@js:')
        expect(JS_MARKER.length).toBe(4)
    })
})

describe('ruleHasJs', () => {
    it('三种形态都算含 JS', () => {
        expect(ruleHasJs('@js:1+1')).toBe(true)
        expect(ruleHasJs('@JS:1+1')).toBe(true)
        expect(ruleHasJs('div.item@js:result')).toBe(true)
        expect(ruleHasJs('div.item@JS:result')).toBe(true)
        expect(ruleHasJs('<js>1+1</js>')).toBe(true)
        expect(ruleHasJs('<JS>1+1</JS>')).toBe(true)
        expect(ruleHasJs('{{$.a}}')).toBe(true)
    })

    it('纯选择器 / JSONPath 不算含 JS', () => {
        expect(ruleHasJs('@css:div.item@text')).toBe(false)
        expect(ruleHasJs('@json:$.a.b')).toBe(false)
        expect(ruleHasJs('class.item.0@tag.a@href')).toBe(false)
        expect(ruleHasJs('//h3/text()')).toBe(false)
        // `@json:` 不是 `@js:` —— 认错的话沙箱会拒掉一条本来合法的规则
        expect(ruleHasJs('@json:$."js:"')).toBe(false)
    })

    it('`</js>` 单独出现不算（闭合标签不需要开标签）', () => {
        expect(ruleHasJs('div.x</js>')).toBe(false)
    })
})
