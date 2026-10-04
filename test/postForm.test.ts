/**
 * 取网层里「带请求体时的 Content-Type」这条规则的单元测试
 *
 * 为什么值得单独钉一条：这一行缺失时的表现是**静默的** —— 站点收不到参数、
 * 返回一个空结果页，引擎那边是「跑通但 0 条」，不报任何错。线上 320 个源（39%）
 * 用 POST 搜索，只有 4 个自己声明了 Content-Type，这个缺口一直没被发现，
 * 正是因为没有任何一条用例盯过「请求头长什么样」。
 */

import { describe, expect, it } from 'vitest'

import { requestHeaders } from '../src/lib/http'

const RESULT_KEY = 'Content-Type'
const FORM = 'application/x-www-form-urlencoded'

/** 大小写不敏感地取一个头（fetch 的头名本来就不区分大小写） */
function header(headers: Record<string, string>, name: string): string | undefined {
    const found = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
    return found === undefined ? undefined : headers[found]
}

describe('带请求体时的 Content-Type', () => {
    it('POST 有 body 就补表单类型 —— 这是书源里 POST 的实际写法', () => {
        const headers = requestHeaders('POST', 'searchkey={{key}}&page=1', {})
        expect(header(headers, RESULT_KEY)).toBe(FORM)
    })

    it('方法大小写不影响判断', () => {
        expect(header(requestHeaders('post', 'a=1', {}), RESULT_KEY)).toBe(FORM)
    })

    it('PUT 这类同样要补 —— 判断依据是「有没有体」，不是「是不是 POST」', () => {
        expect(header(requestHeaders('PUT', 'a=1', {}), RESULT_KEY)).toBe(FORM)
    })

    it('书源自己配了 Content-Type 就不覆盖（JSON 接口那几条靠它）', () => {
        const headers = requestHeaders('POST', '{"a":1}', {
            'Content-Type': 'application/json',
        })
        expect(header(headers, RESULT_KEY)).toBe('application/json')
    })

    it('大小写不同的 Content-Type 也算配过（书源里 `content-type` 很常见）', () => {
        const headers = requestHeaders('POST', '{"a":1}', { 'content-type': 'application/json' })
        // 关键是不能**再加一个**同名不同大小写的头：两个都发出去，站点按哪个判定就说不准了
        expect(Object.keys(headers).filter((k) => k.toLowerCase() === 'content-type')).toHaveLength(
            1,
        )
        expect(headers['content-type']).toBe('application/json')
    })

    it('GET / HEAD 不带体，也不该凭空多一个 Content-Type', () => {
        expect(header(requestHeaders('GET', 'a=1', {}), RESULT_KEY)).toBeUndefined()
        expect(header(requestHeaders('HEAD', 'a=1', {}), RESULT_KEY)).toBeUndefined()
    })

    it('没有体的 POST 不动它 —— 凭空声明表单会让部分站点误判', () => {
        expect(header(requestHeaders('POST', undefined, {}), RESULT_KEY)).toBeUndefined()
        expect(header(requestHeaders('POST', '', {}), RESULT_KEY)).toBeUndefined()
    })

    it('其它头原样保留', () => {
        const headers = requestHeaders('POST', 'a=1', { Referer: 'https://x.test/' })
        expect(headers.Referer).toBe('https://x.test/')
        expect(header(headers, RESULT_KEY)).toBe(FORM)
    })
})
