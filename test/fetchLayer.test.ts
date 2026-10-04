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

import { SEARCH_TIMEOUT_MS, fetchText } from '../src/lib/http'
import type { FetchPlan } from '../src/engine/types'

interface Seen {
    method: string
    contentType: string | undefined
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
                contentType: req.headers['content-type'],
                body,
            })
            // `/stall` 故意不响应：用来量超时
            if (req.url === '/stall') return
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
