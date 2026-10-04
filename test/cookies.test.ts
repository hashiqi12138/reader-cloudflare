/**
 * cookie 罐的纯函数部分（宿主侧那一份，见 `src/lib/cookies.ts`）
 *
 * 这一层值得单测，因为它同时被取网层与落库用到，而**沙箱里还有一份镜像**
 * （`GLOBALS_PRELUDE` 里的 `cookie.*`，QuickJS 里 import 不了这一份）：
 * 两份行为必须一致，任一处走偏，症状都是「某个站的会话时有时无」——
 * 现场在别人家的服务器上，靠线上复现极难。
 *
 * 分工：
 *   - 宿主侧这一份（收 / 发 / 落库序列化）：这里测 + `test/fetchLayer.test.ts` 在真实 HTTP 线上测
 *   - 沙箱侧那一份（`cookie.setCookie` / `replaceCookie` / `removeCookie` / `getKey` 的读写语义）：
 *     冒烟第 41 段测 —— 沙箱在 vitest 里跑不起来（QuickJS 的 .wasm），与其它沙箱行为同一种处理
 */

import { describe, expect, it } from 'vitest'

import {
    cookieHeaderFor,
    dumpJar,
    emptyJar,
    hostOf,
    mergeSetCookie,
    parseJar,
} from '../src/lib/cookies'

describe('hostOf', () => {
    it('绝对地址取主机名（小写、去端口、去路径）', () => {
        expect(hostOf('https://M.Qidian.COM/book/1?x=1')).toBe('m.qidian.com')
        expect(hostOf('http://127.0.0.1:8787/fixture/book/1')).toBe('127.0.0.1')
        expect(hostOf('https://user:pw@a.com/x')).toBe('a.com')
    })

    /**
     * 裸域名也要认
     *
     * 🏷起点 / 🏷阅文集团 写的是 `cookie.getKey("qidian.com", "ywkey")` —— 没有协议头，
     * 而 `new URL("qidian.com")` 是**抛错**的。不补一个 `http://` 再试，这两个源
     * （338 处模板）拿到的永远是空串。
     */
    it('裸域名也认（书源里 `cookie.getKey("qidian.com", …)` 就是这个形状）', () => {
        expect(hostOf('qidian.com')).toBe('qidian.com')
        expect(hostOf('qidian.com/rank')).toBe('qidian.com')
        expect(hostOf('  m.a.com  ')).toBe('m.a.com')
    })

    it('空串与彻底不是地址的给空串（而不是抛错）', () => {
        expect(hostOf('')).toBe('')
        expect(hostOf('   ')).toBe('')
        expect(hostOf('about:blank')).toBe('')
    })
})

describe('收 Set-Cookie', () => {
    it('只留 名字=值，其余属性全丢', () => {
        const jar = emptyJar()
        expect(
            mergeSetCookie(jar, 'https://a.com/x', [
                'sid=abc; Path=/; Domain=.a.com; Secure; HttpOnly',
                'theme=dark',
            ]),
        ).toBe(true)
        expect(jar.hosts['a.com']).toBe('sid=abc; theme=dark')
    })

    it('同名覆盖，但**顺序按首次出现**（免得每次响应都重排一遍）', () => {
        const jar = emptyJar()
        mergeSetCookie(jar, 'https://a.com/', ['a=1', 'b=2'])
        mergeSetCookie(jar, 'https://a.com/', ['a=9'])
        expect(jar.hosts['a.com']).toBe('a=9; b=2')
    })

    it('什么都没变时返回 false（调用方据此决定要不要写库）', () => {
        const jar = emptyJar()
        mergeSetCookie(jar, 'https://a.com/', ['a=1'])
        expect(mergeSetCookie(jar, 'https://a.com/', ['a=1'])).toBe(false)
        expect(mergeSetCookie(jar, 'https://other.com/', [])).toBe(false)
    })

    it('`Max-Age=0` / 已过期的 Expires 是站点在删 cookie', () => {
        const jar = emptyJar()
        mergeSetCookie(jar, 'https://a.com/', ['a=1', 'b=2'])
        mergeSetCookie(jar, 'https://a.com/', ['a=; Max-Age=0'])
        expect(jar.hosts['a.com']).toBe('b=2')
        mergeSetCookie(jar, 'https://a.com/', ['b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])
        expect(jar.hosts['a.com']).toBeUndefined()
    })

    it('空的 Expires 不当成过期（站点写坏属性时不能把键误删）', () => {
        const jar = emptyJar()
        mergeSetCookie(jar, 'https://a.com/', ['a=1'])
        mergeSetCookie(jar, 'https://a.com/', ['a=2; Expires='])
        expect(jar.hosts['a.com']).toBe('a=2')
    })

    it('没有主机名的地址（about:blank）不动罐子', () => {
        const jar = emptyJar()
        expect(mergeSetCookie(jar, 'about:blank', ['a=1'])).toBe(false)
        expect(jar.hosts).toEqual({})
    })
})

describe('发 Cookie 头', () => {
    it('按「目标主机 + 各级父域」取，同名的以更具体的为准', () => {
        const jar = emptyJar()
        jar.hosts['a.com'] = 'x=1; y=2'
        jar.hosts['m.a.com'] = 'x=9'
        expect(cookieHeaderFor(jar, 'https://m.a.com/rank')).toBe('x=9; y=2')
    })

    /**
     * 父域上的 cookie **不**发给别的子域，子域上的也**不**发给父域
     *
     * 这是「会不会把 A 站的会话泄露给 B 站」的那条线，宁可窄不可宽。
     * 沙箱里 `cookie.getCookie` 看到的那份比这里宽（还往下找子域），
     * 那是「脚本查这个站的 cookie」，不是「这次请求发什么」—— 两件事的取舍不同。
     */
    it('不会横向或向上乱带（严格按父子域）', () => {
        const jar = emptyJar()
        jar.hosts['a.com'] = 'p=1'
        jar.hosts['m.a.com'] = 'q=2'
        expect(cookieHeaderFor(jar, 'https://shop.a.com/')).toBe('p=1')
        expect(cookieHeaderFor(jar, 'https://a.com/')).toBe('p=1')
        expect(cookieHeaderFor(jar, 'https://other.com/')).toBe('')
    })

    it('没有罐子时回空串（书源没开 CookieJar 的那 359 条）', () => {
        expect(cookieHeaderFor(undefined, 'https://a.com/')).toBe('')
    })
})

describe('落库那一份', () => {
    it('存的是「主机名 → cookie 串」的 JSON，能原样读回来', () => {
        const jar = emptyJar()
        jar.hosts['a.com'] = 'a=1'
        jar.hosts['m.b.com'] = 'b=2'
        const restored = parseJar(dumpJar(jar))
        expect(restored.hosts).toEqual({ 'a.com': 'a=1', 'm.b.com': 'b=2' })
    })

    it('库里那一份坏掉时当空罐（cookie 不该挡住整条链路）', () => {
        expect(parseJar('不是 JSON').hosts).toEqual({})
        expect(parseJar('[1,2]').hosts).toEqual({})
        expect(parseJar('').hosts).toEqual({})
        expect(parseJar(undefined).hosts).toEqual({})
    })

    it('空值不写进罐子（免得存出一堆空主机）', () => {
        expect(parseJar('{"a.com":"","b.com":"b=2"}').hosts).toEqual({ 'b.com': 'b=2' })
    })
})
