import { describe, expect, it } from 'vitest'

import { sourceGlobals, sourceLimits, sourcePayload, baseGlobals } from '../src/engine/globals'
import type { BookSource, RuleContext } from '../src/engine/types'

/**
 * 沙箱里 `source` / `infoMap` / `jsLib` 的组装
 *
 * 这三个东西的取值来源只有一个（`RuleContext.source`），但要覆盖两条求值路径
 * （`analyze.ts` 的规则求值与 `legado/source.ts` 的 URL 模板）。这里钉住形状，
 * 免得出现「规则里 source 有值、URL 模板里没有」这类只在某些源上才暴露的分歧。
 */

const source: BookSource = {
    bookSourceName: '示例源',
    bookSourceUrl: 'https://example.com',
    bookSourceComment: '备注',
    header: '{"User-Agent":"ua"}',
    loginUrl: 'https://example.com/login',
    searchUrl: 'https://example.com/s?q={{key}}',
    jsLib: 'function host(){ return "https://example.com" }',
}

const ctx = (extra: Partial<RuleContext> = {}): RuleContext => ({
    baseUrl: 'https://example.com',
    key: '斗破',
    source,
    ...extra,
})

describe('sourcePayload', () => {
    it('没有书源时返回 null（沙箱里 source 会是空对象而不是报错）', () => {
        expect(sourcePayload(undefined)).toBeNull()
    })

    it('带上脚本常用的那几个字段', () => {
        const payload = sourcePayload(source) as Record<string, unknown>
        expect(payload.bookSourceUrl).toBe('https://example.com')
        expect(payload.bookSourceComment).toBe('备注')
        expect(payload.header).toBe('{"User-Agent":"ua"}')
        expect(payload.loginUrl).toBe('https://example.com/login')
    })

    /**
     * `key` 是**书源地址**，不是搜索词
     *
     * 这条以前写反了：`key` 取自 `ctx.key`（搜索词），于是 122 个源、206 处
     * `source.getKey()` / `source.key` 拿到一个搜索词，而它们在书源里全是当**站点地址**用的
     * （`source.key + "/search.html"`、`java.connect(source.getKey())`、
     * `cookie.removeCookie(source.getKey())`）。搜索词有单独的 `key` 全局。
     */
    it('key 是**书源地址**（`BaseSource.getKey()` 的形状），不是搜索词', () => {
        expect((sourcePayload(source) as Record<string, unknown>).key).toBe('https://example.com')
        // 上下文里带着搜索词也不该串进来
        expect((sourcePayload(source) as Record<string, unknown>).key).not.toBe('斗破')
    })

    it('书源没有地址时 key 是空串，而不是 undefined', () => {
        expect(
            (sourcePayload({ bookSourceName: 'x' } as BookSource) as Record<string, unknown>).key,
        ).toBe('')
    })

    /**
     * `variable` 必须**总是**出现在 payload 里（哪怕是空串）
     *
     * 它是 `source.getVariable()` 无参时的返回值 —— 而 816 条源里**一条都没有**这个字段
     * （起点是空串，靠书源自己 `setVariable` 填）。如果按「undefined 就不进 payload」
     * 的规则把它漏掉，沙箱那侧拿到的是 undefined，`getVariable()` 会回 "undefined"。
     */
    it('`variable` 总是作为字符串出现 —— 书源里没有这个字段时是空串', () => {
        expect((sourcePayload(source) as Record<string, unknown>).variable).toBe('')
        expect(
            (sourcePayload({ ...source, variable: '{"线路":2}' }) as Record<string, unknown>)
                .variable,
        ).toBe('{"线路":2}')
    })

    it('不透传规则文本：整份书源里带着所有规则，逐次求值序列化它是纯浪费', () => {
        const payload = sourcePayload(source) as Record<string, unknown>
        expect(payload.ruleSearch).toBeUndefined()
        expect(payload.ruleContent).toBeUndefined()
        expect(payload.ruleToc).toBeUndefined()
    })

    it('undefined 字段不进 payload（进沙箱会变成 null，脚本判断会走错分支）', () => {
        const payload = sourcePayload({
            bookSourceName: 'x',
            bookSourceUrl: 'https://a.com',
        }) as Record<string, unknown>
        expect('bookSourceGroup' in payload).toBe(false)
        expect('loginUrl' in payload).toBe(false)
    })
})

describe('sourceGlobals', () => {
    it('infoMap 缺省是空对象 —— 脚本里的 `infoMap["频道"] || "分类"` 才能落到默认值', () => {
        const globals = sourceGlobals(ctx())
        expect(globals.__infoMap).toEqual({})
    })

    it('infoMap 有值时原样透传', () => {
        const globals = sourceGlobals(ctx({ infoMap: { 频道: '全本' } }))
        expect(globals.__infoMap).toEqual({ 频道: '全本' })
    })

    it('变量表以 JSON 串注入（Legado 的 source.getVariable() 返回的就是 JSON 串）', () => {
        const globals = sourceGlobals(ctx({ vars: { a: '1' } }))
        expect(JSON.parse(String(globals.__sourceVars))).toEqual({ a: '1' })
    })

    it('没有书源时 __source 为 null，而不是缺这个键', () => {
        const globals = sourceGlobals({ baseUrl: 'https://a.com' })
        expect('__source' in globals).toBe(true)
        expect(globals.__source).toBeNull()
    })
})

describe('sourceLimits', () => {
    it('有 jsLib 时作为沙箱前置脚本传入', () => {
        expect(sourceLimits(ctx()).preludeJs).toContain('function host()')
    })

    it('没有 jsLib、或只有空白时不传 —— 少一次无意义的 evalCodeAsync', () => {
        expect(sourceLimits({ baseUrl: 'https://a.com' }).preludeJs).toBeUndefined()
        expect(
            sourceLimits(ctx({ source: { ...source, jsLib: '   \n ' } })).preludeJs,
        ).toBeUndefined()
    })
})

/**
 * `baseGlobals` 是**所有**沙箱求值共用的那一份全局
 *
 * 它以前在四个地方各写了一份（规则求值、`{{}}` 模板、URL 里的 `@js:`、发现页），
 * 于是每加一个字段就要在四处补齐 —— 而漏掉一处**不会报错**，只会让那一处的书源
 * 少看见一个全局（`book` 就是这样被漏掉的：`book.name` 54 处 / 39 源一直是 undefined）。
 */
describe('baseGlobals', () => {
    it('book / chapter 缺省是空对象 —— 脚本里拼出来的是空串，而不是 undefined', () => {
        const globals = baseGlobals(ctx())
        expect(globals.book).toEqual({})
        expect(globals.chapter).toEqual({})
    })

    it('book / chapter 有值时原样透传（书源靠它拿书名、作者、章节号）', () => {
        const globals = baseGlobals(
            ctx({
                book: { name: '斗破苍穹', author: '天蚕土豆' },
                chapter: { title: '第一章 陨落的天才', index: 0 },
            }),
        )
        expect(globals.book).toEqual({ name: '斗破苍穹', author: '天蚕土豆' })
        expect(globals.chapter).toEqual({ title: '第一章 陨落的天才', index: 0 })
    })

    it('key / page 是标量全局（与 `source.key` 那个「书源地址」不是一回事）', () => {
        const globals = baseGlobals(ctx({ page: 3 }))
        expect(globals.key).toBe('斗破')
        expect(globals.page).toBe(3)
    })

    it('书的变量以 JSON 串注入 —— 那是沙箱里 `book.getVariable` 的初值', () => {
        const globals = baseGlobals(ctx({ bookVars: { 序: '7' } }))
        expect(JSON.parse(String(globals.__bookVars))).toEqual({ 序: '7' })
    })

    it('会话里写过的书变量**优先**于库里读到的那份（同一次请求内先写后读）', () => {
        // 结构化地造一个会话：只要形状对，不需要真的实例化 QuickJS
        const session = {
            module: Promise.resolve(),
            queue: Promise.resolve(),
            vars: {},
            bookVars: { 序: '3' },
        } as unknown as RuleContext['sandbox']
        const globals = baseGlobals(ctx({ bookVars: { 序: '7', 元: 'div' }, sandbox: session }))
        expect(JSON.parse(String(globals.__bookVars))).toEqual({ 序: '3', 元: 'div' })
    })

    it('同时也带上 source / __sourceVars / __infoMap（两条求值路径共用同一份）', () => {
        const globals = baseGlobals(ctx())
        expect(globals.__source).not.toBeNull()
        expect('__sourceVars' in globals).toBe(true)
        expect(globals.__infoMap).toEqual({})
    })
})

describe('sourceLimits 的两条落库路径', () => {
    it('persistSourceVariable / persistBookVariable 都跟着上下文走', () => {
        const a = () => {}
        const b = () => {}
        const limits = sourceLimits(ctx({ persistSourceVariable: a, persistBookVariable: b }))
        expect(limits.persistSourceVariable).toBe(a)
        expect(limits.persistBookVariable).toBe(b)
    })

    it('没注入时不传这两个键 —— 变量只活在本请求内，而不是抛错', () => {
        const limits = sourceLimits(ctx())
        expect('persistSourceVariable' in limits).toBe(false)
        expect('persistBookVariable' in limits).toBe(false)
    })
})
