/*
 * 替换净化规则的校验测试
 *
 * 只测 `parseReplaceRules` 这个纯函数：读/写要落到 D1 上，用一个自己写的假
 * D1 去测等于测那个假实现 —— 那一半交给冒烟测试（`scripts/smoke.mjs`），
 * 它跑的是真的 workerd 与真的 SQLite。
 *
 * 这里钉住的是「坏在第几条要说得出来」以及「字段层面归一而不是拒绝」这两条：
 * 前者决定用户能不能自己修好，后者决定「少写一个字段」不会让整份规则传不上去。
 */

import { describe, expect, it } from 'vitest'

import { MAX_REPLACE_FIELD, MAX_REPLACE_RULES, parseReplaceRules } from '../src/data/replaceRules'
import { DataError } from '../src/data/types'

const rule = (partial: Record<string, unknown> = {}) => ({
    name: '去广告',
    group: '通用',
    pattern: '广告',
    replacement: '',
    enabled: true,
    ...partial,
})

/**
 * 取第 n 条（默认第一条）
 *
 * 直接解构写 `const [one] = ...` 在 `noUncheckedIndexedAccess` 下是 `T | undefined`，
 * 于是每处断言都要写一个 `!` —— 而 `!` 一旦成了习惯，真取空的那次也看不出来。
 * 这里在**取不到时就炸**，断言本身保持干净。
 */
function at(rules: ReturnType<typeof parseReplaceRules>, index = 0) {
    const one = rules[index]
    if (!one) throw new Error(`期望有第 ${index + 1} 条规则，实际只有 ${rules.length} 条`)
    return one
}

describe('替换规则校验', () => {
    it('整份不是数组就报错，并指出形状', () => {
        expect(() => parseReplaceRules({ rules: [] })).toThrow(DataError)
        expect(() => parseReplaceRules(null)).toThrow(/必须是一个数组/)
    })

    it('条数超上限时把上限与实际条数都说出来', () => {
        const tooMany = Array.from({ length: MAX_REPLACE_RULES + 1 }, () => rule())
        expect(() => parseReplaceRules(tooMany)).toThrow(new RegExp(`最多 ${MAX_REPLACE_RULES} 条`))
    })

    it('坏在第几条就报到第几条（不说「格式不对」）', () => {
        expect(() => parseReplaceRules([rule(), rule(), '这不是对象'])).toThrow(/第 3 条/)
    })

    it('缺字段与多余字段都收敛：归一而不是拒绝', () => {
        const only = at(parseReplaceRules([{ pattern: '广告' }]))
        expect(only.pattern).toBe('广告')
        expect(only.name).toBe('')
        expect(only.group).toBe('默认')
        expect(only.replacement).toBe('')
        expect(only.enabled).toBe(true)
    })

    it('只有显式写 false 才算停用', () => {
        expect(at(parseReplaceRules([rule({ enabled: false })])).enabled).toBe(false)
        // `enabled: 0` / `'false'` 不是我们发的形状，按「没写」处理 —— 宁可启用一条
        // 用户看不出来的规则，也不要安静地停用他以为在工作的一条
        expect(at(parseReplaceRules([rule({ enabled: 0 })])).enabled).toBe(true)
    })

    it('数字、null 这类字段值会被转成字符串，而不是原样透传', () => {
        const one = at(parseReplaceRules([rule({ name: 123, replacement: null })]))
        expect(one.name).toBe('123')
        expect(one.replacement).toBe('')
    })

    it('超长字段被截断到上限（一行 JSON 不该被单条规则撑爆）', () => {
        const long = 'x'.repeat(MAX_REPLACE_FIELD + 500)
        const one = at(parseReplaceRules([rule({ pattern: long })]))
        expect(one.pattern.length).toBe(MAX_REPLACE_FIELD)
    })

    it('空数组是合法的：那就是「一份没有规则的规则」', () => {
        expect(parseReplaceRules([])).toEqual([])
    })
})
