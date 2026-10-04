/**
 * 取网层：**发出去的请求到底长什么样**，以及超时怎么报
 *
 * 这两条都只能在这一层验，而且都必须验：
 *
 *   1. 带请求体时有没有声明 `Content-Type`。缺失时的表现是**静默的** ——
 *      站点收不到参数、返回空结果页，引擎那侧是「跑通、0 条、不报错」。
 *      线上 320 个源（39%）用 POST 搜索，只有 4 个自己声明了 Content-Type。
 *      （冒烟里还有一个端到端的对照：测试站点那个端点照 PHP 的行为写，
 *        没有表单类型就当作没收到参数。）
 *   2. 超时。以前**完全没有超时**，站点不响应就只能等上游自己放弃（实测最慢 39 秒）；
 *      搜索那次尤其致命，因为一页几个源并发，整页要等最慢的那个。
 *
 * 这里起一个真的本地 HTTP 服务，把收到的请求头记下来 —— 比断言「函数返回了某个对象」
 * 更接近事实：验的是**网线上发出去的东西**。跑起来只要几百毫秒，不碰外网。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'

import { SEARCH_TIMEOUT_MS, fetchDetailed, fetchText } from '../src/lib/http'
import { emptyJar } from '../src/lib/cookies'
import type { FetchPlan } from '../src/engine/types'

interface Seen {
    method: string
    url: string
    contentType: string | undefined
    cookie: string | undefined
    body: string
}

const seen: Seen[] = []
let server: Server
let base = ''

beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => {
            body += chunk
        })
        req.on('end', () => {
            seen.push({
                method: req.method ?? '',
                url: req.url ?? '',
                contentType: req.headers['content-type'],
                cookie: req.headers.cookie,
                body,
            })
            /**
             * 重定向的靶子（第五十五轮）
             *
             * 这些端点以前是测不到的：`redirect: 'follow'` 会把 302 连同它的
             * `Set-Cookie` 与 `Location` 一起吃干净。改成自己跟之后才有得验 ——
             * 而「每一跳的 cookie 都要收」「POST 变成 GET」这类语义**错一点都很难发现**：
             * 站点侧要么收到重复提交、要么会话丢了，表现都是别的东西。
             */
            if (req.url?.startsWith('/redirect/set')) {
                res.setHeader('Set-Cookie', 'rc_r=1; Path=/')
                res.setHeader('Location', '/target')
                res.statusCode = 302
                res.end('去别处')
                return
            }
            if (req.url?.startsWith('/redirect/post')) {
                res.setHeader('Location', '/echo')
                res.statusCode = 302
                res.end('去别处')
                return
            }
            if (req.url?.startsWith('/redirect/keep')) {
                res.setHeader('Location', '/echo')
                res.statusCode = 307
                res.end('去别处')
                return
            }
            if (req.url?.startsWith('/redirect/relative')) {
                // 相对 Location：按**当前这一跳的地址**解析，不是按最初的地址
                res.setHeader('Location', 'target-relative')
                res.statusCode = 302
                res.end('去别处')
                return
            }
            if (req.url?.startsWith('/redirect/loop')) {
                res.setHeader('Location', '/redirect/loop')
                res.statusCode = 302
                res.end('绕圈')
                return
            }
            // 两跳各慢 150ms：用来量「超时是整条链共享的」
            if (req.url?.startsWith('/redirect/slow2')) {
                setTimeout(() => {
                    res.setHeader('Content-Type', 'text/html; charset=utf-8')
                    res.end('<html><body>慢</body></html>')
                }, 150)
                return
            }
            if (req.url?.startsWith('/redirect/slow')) {
                setTimeout(() => {
                    res.setHeader('Location', '/redirect/slow2')
                    res.statusCode = 302
                    res.end('慢')
                }, 150)
                return
            }
            // `/stall` 故意不响应：用来量超时
            if (req.url === '/stall') return
            // `/forbidden` 演一出「非 2xx + 带 Set-Cookie」：java.connect 的 code()/headers() 靠它
            if (req.url === '/forbidden') {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8')
                res.setHeader('Set-Cookie', 'rc_connect=fake; Path=/')
                res.statusCode = 403
                res.end('connect-error-403')
                return
            }
            // `/set-cookie` 下发两个 cookie（其中一条带删除属性）
            if (req.url === '/set-cookie') {
                res.setHeader('Set-Cookie', ['rc_a=1; Path=/; HttpOnly', 'rc_b=2; Path=/'])
                res.setHeader('Content-Type', 'text/plain; charset=utf-8')
                res.end('已下发')
                return
            }
            // `/drop-cookie` 删掉 rc_a（`Max-Age=0` 是站点删 cookie 的标准写法）
            if (req.url === '/drop-cookie') {
                res.setHeader('Set-Cookie', 'rc_a=; Path=/; Max-Age=0')
                res.setHeader('Content-Type', 'text/plain; charset=utf-8')
                res.end('已删除')
                return
            }
            // `/same-cookie` 反复下发同一个值：用来验证「没变就不写库」
            if (req.url === '/same-cookie') {
                res.setHeader('Set-Cookie', 'rc_same=1; Path=/')
                res.setHeader('Content-Type', 'text/plain; charset=utf-8')
                res.end('已下发')
                return
            }
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end('<html><body>好了</body></html>')
        })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
})

function plan(over: Partial<FetchPlan>): FetchPlan {
    return {
        url: `${base}/search`,
        method: 'GET',
        headers: {},
        charset: 'auto',
        webView: false,
        ...over,
    }
}

describe('带请求体时的 Content-Type', () => {
    it('POST 表单：站点收到的就是表单类型（这是书源里 POST 的实际形态）', async () => {
        const text = await fetchText(plan({ method: 'POST', body: 'q=斗破苍穹&p=1' }))
        expect(text).toContain('好了')
        const last = seen.at(-1)!
        expect(last.method).toBe('POST')
        expect(last.contentType).toBe('application/x-www-form-urlencoded')
        expect(last.body).toBe('q=斗破苍穹&p=1')
    })

    it('书源自己配了 Content-Type 就不覆盖（JSON 接口那几条靠它）', async () => {
        await fetchText(
            plan({
                method: 'POST',
                body: '{"q":"x"}',
                headers: { 'Content-Type': 'application/json' },
            }),
        )
        expect(seen.at(-1)!.contentType).toBe('application/json')
    })

    it('GET 不会凭空多一个 Content-Type', async () => {
        await fetchText(plan({ method: 'GET' }))
        expect(seen.at(-1)!.contentType).toBeUndefined()
    })
})

describe('上游超时', () => {
    it('超过这次请求的时限就报「请求超时」，而不是一直等', async () => {
        const started = Date.now()
        await expect(
            fetchText(plan({ url: `${base}/stall`, timeoutMs: 300 })),
        ).rejects.toThrowError(/请求超时（>300ms）/)
        // 断言的是「真的按这个时限放弃了」，不是等上游自己超时（那要几十秒）
        expect(Date.now() - started).toBeLessThan(3_000)
    })

    it('搜索用的时限明显更短 —— 一页几个源并发，整页要等最慢的那个', () => {
        // 这条钉的是**取向**：搜索的时限必须短。默认那个（20 秒）用在读正文上没问题，
        // 放在搜索上就是「点一次继续加载等 20 秒」。
        expect(SEARCH_TIMEOUT_MS).toBeLessThanOrEqual(8_000)
    })
})

/**
 * `fetchDetailed`：`java.connect` 的那条路
 *
 * 它与 `fetchText` 的**全部差别**就是这一点：HTTP 非 2xx **不当成失败**。
 * 书源用 `res.code() == 403` 决定要不要换 cookie、用 `res.raw().headers('Set-Cookie')`
 * 取新 cookie（📂天籁小说 整条 searchUrl 就是干这个），抛错会把判断变成异常。
 *
 * 所以这里必须真的收到一个 403 才能断言 —— 用一个只会回 200 的服务，这条路一行都测不到。
 * 两条一起验：`fetchDetailed` 拿到 403 不抛错、而 `fetchText` 对同一个地址照样抛错
 * （否则「不抛错」会被写进所有链路，搜索就会把错误页当成正文）。
 */
describe('fetchDetailed 与 fetchText 的分工', () => {
    it('HTTP 403 时 fetchDetailed 不抛错，把状态码与响应头原样交出', async () => {
        const response = await fetchDetailed(plan({ url: `${base}/forbidden` }))
        expect(response.status).toBe(403)
        expect(response.body).toContain('connect-error-403')
        // 响应头名字要小写成可查的键，且 Set-Cookie 是**数组**（可能有多条）
        expect(response.headers['set-cookie']).toEqual(['rc_connect=fake; Path=/'])
    })

    it('同一个 403 地址，fetchText 仍然抛错（链路不能把错误页当成正文）', async () => {
        await expect(fetchText(plan({ url: `${base}/forbidden` }))).rejects.toThrowError(
            /上游返回 HTTP 403/,
        )
    })

    it('2xx 时两者给出同一份正文', async () => {
        const detailed = await fetchDetailed(plan({}))
        expect(detailed.status).toBe(200)
        expect(detailed.body).toBe(await fetchText(plan({})))
    })
})

/**
 * cookie 罐：**收**（响应的 Set-Cookie）与**发**（下一个请求的 Cookie 头）
 *
 * 这两件事都发生在取网层，所以只能在这一层验，而且必须验在真实的 HTTP 线上 ——
 * 「函数返回了某个对象」证明不了网线上到底发了什么。
 *
 * 书源的场景决定了它必须跨请求（搜索 / 详情 / 目录 / 正文是四次互不相干的请求），
 * 所以这里同时验「收完就写库」这一条：漏了它，会话 cookie 只活一趟，
 * 表现是「搜得到书、点进去 403」。
 */
describe('cookie 罐的收发', () => {
    it('响应里的 Set-Cookie 进罐，且立刻写回库（跨请求那一趟要用）', async () => {
        const jar = emptyJar()
        let persisted = 0

        await fetchText(
            plan({
                url: `${base}/set-cookie`,
                cookieJar: jar,
                persistCookies: () => void persisted++,
            }),
        )

        // 属性（Path / HttpOnly）必须被丢掉 —— 留着它们会在拼 Cookie 头时把属性当键发出去
        expect(jar.hosts['127.0.0.1']).toBe('rc_a=1; rc_b=2')
        expect(persisted).toBe(1)
    })

    it('下一个请求自动带上罐里的 Cookie（书源自己没写的时候）', async () => {
        const jar = emptyJar()
        jar.hosts['127.0.0.1'] = 'rc_a=1'
        await fetchText(plan({ cookieJar: jar }))
        expect(seen.at(-1)!.cookie).toBe('rc_a=1')
    })

    it('书源自己声明了 Cookie 就不覆盖 —— 有些站点要的是专用 cookie', async () => {
        const jar = emptyJar()
        jar.hosts['127.0.0.1'] = 'rc_a=1'
        await fetchText(plan({ cookieJar: jar, headers: { Cookie: 'mine=1' } }))
        expect(seen.at(-1)!.cookie).toBe('mine=1')
    })

    it('`Max-Age=0` 是站点在删 cookie（退出登录就靠它），罐子里要真的没了', async () => {
        const jar = emptyJar()
        jar.hosts['127.0.0.1'] = 'rc_a=1; rc_b=2'
        await fetchDetailed(plan({ url: `${base}/drop-cookie`, cookieJar: jar }))
        expect(jar.hosts['127.0.0.1']).toBe('rc_b=2')
        // 删掉之后下一个请求就不该再带它
        await fetchText(plan({ cookieJar: jar }))
        expect(seen.at(-1)!.cookie).toBe('rc_b=2')
    })

    it('罐子没变就不写库（同一个值反复下发不该变成每次请求一次 UPDATE）', async () => {
        const jar = emptyJar()
        jar.hosts['127.0.0.1'] = 'rc_same=1'
        let persisted = 0
        await fetchDetailed(
            plan({
                url: `${base}/same-cookie`,
                cookieJar: jar,
                persistCookies: () => void persisted++,
            }),
        )
        expect(jar.hosts['127.0.0.1']).toBe('rc_same=1')
        expect(persisted).toBe(0)
    })

    it('没有罐子时行为与以前一模一样（书源关掉 CookieJar 的 359 条就是这条路）', async () => {
        await fetchText(plan({ url: `${base}/set-cookie` }))
        expect(seen.at(-1)!.cookie).toBeUndefined()
    })
})

/**
 * 重定向：自己跟（第五十五轮）
 *
 * 以前是交给 `fetch` 的 `redirect: 'follow'`，代价是两样东西被吃掉：
 * **每一跳的 `Set-Cookie`**（站点常用 302 下发会话 cookie）与 **`Location` 本身**
 * （线上 11 个源的 searchUrl 靠它找真正的搜索页地址）。
 *
 * 自己跟就要把规矩抄全，否则会静默地做出与浏览器不一样的事 ——
 * 「302 之后 POST 变 GET 且不再发 body」这一条尤其要紧：站点把「表单已提交」的
 * 那一次 302 指向结果页，再发一遍 body 就是**重复提交**。
 */
describe('重定向是自己跟的', () => {
    it('跟到最终页面，正文是最后一跳的', async () => {
        const text = await fetchText(plan({ url: `${base}/redirect/set` }))
        expect(text).toContain('好了')
        expect(seen.at(-1)!.url).toBe('/target')
    })

    it('302 上的 Set-Cookie 也进罐（这是「302 下发会话」那个漏点）', async () => {
        const jar = emptyJar()
        await fetchText(plan({ url: `${base}/redirect/set`, cookieJar: jar }))
        expect(jar.hosts['127.0.0.1']).toBe('rc_r=1')
    })

    it('第一跳的 status 与 Location 留在 redirectedFrom 里（11 个源要的就是它）', async () => {
        const response = await fetchDetailed(plan({ url: `${base}/redirect/set` }))
        expect(response.status).toBe(200)
        expect(response.redirectedFrom).toEqual({
            status: 302,
            location: `${base}/target`,
        })
        // 没有跳转时不该有这个字段（别让书源以为每次请求都被重定向了）
        expect((await fetchDetailed(plan({}))).redirectedFrom).toBeUndefined()
    })

    it('302 之后 POST 变 GET、并且不再发 body（不该重复提交）', async () => {
        await fetchText(plan({ url: `${base}/redirect/post`, method: 'POST', body: 'q=1&p=1' }))
        const first = seen.at(-2)!
        const second = seen.at(-1)!
        expect([first.method, first.body]).toEqual(['POST', 'q=1&p=1'])
        expect([second.method, second.body, second.url]).toEqual(['GET', '', '/echo'])
        // 第二跳连 Content-Type 都不该带（没有 body 了）
        expect(second.contentType).toBeUndefined()
    })

    it('307 之后 POST 还是 POST、body 原样（站点明确要求保留时不能改）', async () => {
        await fetchText(plan({ url: `${base}/redirect/keep`, method: 'POST', body: 'q=1&p=1' }))
        const second = seen.at(-1)!
        expect([second.method, second.body, second.url]).toEqual(['POST', 'q=1&p=1', '/echo'])
    })

    it('相对 Location 按**当前这一跳**的地址解析', async () => {
        await fetchText(plan({ url: `${base}/redirect/relative` }))
        expect(seen.at(-1)!.url).toBe('/redirect/target-relative')
    })

    it('绕圈时停下来（跳数有上限），最终那个 302 照常当失败报出来', async () => {
        const before = seen.length
        await expect(fetchText(plan({ url: `${base}/redirect/loop` }))).rejects.toThrowError(
            /上游返回 HTTP 302/,
        )
        // 1 次 + 最多 5 跳：既没绕死，也没少跟
        expect(seen.length - before).toBe(6)
    })

    it('整条链共享一份超时预算（不是每一跳各给一份）', async () => {
        /**
         * 两跳各慢 150ms，给 220ms：共享预算下第二跳会被掐掉；
         * 要是每一跳各给一份（220 + 220 = 440 > 300），这次请求反而会「成功」。
         * 所以这条断言能分辨那两种实现 —— 而症状差别是「搜索整页被一个源拖住 5 倍时间」。
         */
        const started = Date.now()
        await expect(
            fetchText(plan({ url: `${base}/redirect/slow`, timeoutMs: 220 })),
        ).rejects.toThrowError(/请求超时/)
        expect(Date.now() - started).toBeLessThan(400)
    })
})
