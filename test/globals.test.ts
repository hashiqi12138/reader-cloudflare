import { describe, expect, it } from 'vitest'

import { sourceGlobals, sourceLimits, sourcePayload } from '../src/engine/globals'
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
        const payload = sourcePayload(source, '斗破') as Record<string, unknown>
        expect(payload.bookSourceUrl).toBe('https://example.com')
        expect(payload.bookSourceComment).toBe('备注')
        expect(payload.header).toBe('{"User-Agent":"ua"}')
        expect(payload.loginUrl).toBe('https://example.com/login')
    })

    it('key 是**当前搜索词**，取自上下文而不是书源本身', () => {
        expect((sourcePayload(source, '斗破') as Record<string, unknown>).key).toBe('斗破')
        expect((sourcePayload(source, '') as Record<string, unknown>).key).toBe('')
    })

    it('不透传规则文本：整份书源里带着所有规则，逐次求值序列化它是纯浪费', () => {
        const payload = sourcePayload(source, 'k') as Record<string, unknown>
        expect(payload.ruleSearch).toBeUndefined()
        expect(payload.ruleContent).toBeUndefined()
        expect(payload.ruleToc).toBeUndefined()
    })

    it('undefined 字段不进 payload（进沙箱会变成 null，脚本判断会走错分支）', () => {
        const payload = sourcePayload(
            { bookSourceName: 'x', bookSourceUrl: 'https://a.com' },
            '',
        ) as Record<string, unknown>
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
