/**
 * 宽容 JSON 解析的单元测试
 *
 * 这些用例全部来自真实书源里实际出现的写法 —— 社区书源在 Legado 里能跑，
 * 是因为 Legado 用的是宽松解析器；严格 JSON.parse 会把它们整批拒掉。
 */

import { describe, expect, it } from 'vitest'

import { parseLooseJson } from '../src/lib/json'

describe('宽容 JSON 解析', () => {
    it('标准 JSON 原样通过', () => {
        expect(parseLooseJson('{"method":"POST"}')).toEqual({ method: 'POST' })
    })

    it('单引号的键与值是真实书源里的写法（白光小说）', () => {
        expect(parseLooseJson("{'method': 'POST', 'body': 'keyword={{key}}'}")).toEqual({
            method: 'POST',
            body: 'keyword={{key}}',
        })
    })

    it('键不带引号也能解析', () => {
        expect(parseLooseJson('{method: "GET", charset: "gbk"}')).toEqual({
            method: 'GET',
            charset: 'gbk',
        })
    })

    it('尾逗号不会让解析失败', () => {
        expect(parseLooseJson('{"method":"GET",}')).toEqual({ method: 'GET' })
    })

    it('值里带双引号也能原样保留', () => {
        expect(parseLooseJson("{'ua': 'Mozilla/5.0 \"x\"'}")).toEqual({ ua: 'Mozilla/5.0 "x"' })
    })

    it('值里带换行会保留为换行', () => {
        expect(parseLooseJson("{'body': 'a\nb'}")).toEqual({ body: 'a\nb' })
    })

    it('嵌套结构同样能被修补', () => {
        expect(parseLooseJson("{'h': {'User-Agent': 'x'}}")).toEqual({ h: { 'User-Agent': 'x' } })
    })

    it('修补之后仍然不是 JSON 时抛错，而不是猜一个值', () => {
        expect(() => parseLooseJson('这不是 JSON')).toThrow()
        expect(() => parseLooseJson("{'a': }")).toThrow()
    })

    it('抛的是严格解析的错误 —— 它对应原文，比修补后的报错更好定位', () => {
        let message = ''
        try {
            parseLooseJson("{'a': }")
        } catch (err) {
            message = err instanceof Error ? err.message : String(err)
        }
        // 严格解析在第二个字符就报错，说明拿到的是原文而不是修补后的版本
        expect(message).toMatch(/position/i)
    })
})
