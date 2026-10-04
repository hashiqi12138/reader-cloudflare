/*
 * 书源列表缓存的单元测试
 *
 * 这里钉住的都是「判错也不会报错、只会静默给错数据」的地方：
 * 该复用的没复用（白拉 130 KB）、不该复用的复用了（导入完看不见新书源）、
 * 失败被当成结果记下来（一次抖动让后续 30 秒都在报错）。这类问题在浏览器里
 * 极难复现，所以边界要在这里一条条写死。
 */

import { describe, expect, it } from 'vitest'

import { createSourcesCache } from '../public/js/sourcesCache.js'

/** 手动决定何时兑现的 promise，用来摆布「请求还在飞」的那一瞬间 */
function deferred() {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

/** 把微任务队列排空 —— 让「请求回来后」的收尾逻辑先跑完再断言 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('书源列表缓存', () => {
    it('连着读两次只打一次网络', async () => {
        let calls = 0
        const cache = createSourcesCache(async () => {
            calls += 1
            return { sources: [] }
        })

        await cache.load()
        await cache.load()

        expect(calls).toBe(1)
    })

    it('同时要列表的几个调用共用同一趟请求', async () => {
        let calls = 0
        const gate = deferred()
        const cache = createSourcesCache(() => {
            calls += 1
            return gate.promise
        })

        const both = Promise.all([cache.load(), cache.load()])
        gate.resolve({ sources: [] })
        const [a, b] = await both

        expect(calls).toBe(1)
        expect(a).toBe(b)
    })

    it('过了时限会重新拉', async () => {
        let calls = 0
        let clock = 0
        const cache = createSourcesCache(
            async () => {
                calls += 1
                return { sources: [] }
            },
            { ttlMs: 1000, now: () => clock },
        )

        await cache.load()
        clock = 999
        await cache.load()
        expect(calls).toBe(1)

        clock = 1000
        await cache.load()
        expect(calls).toBe(2)
    })

    it('失败不入缓存 —— 下次还要再试，而不是把错误记满整个时限', async () => {
        let calls = 0
        const cache = createSourcesCache(async () => {
            calls += 1
            if (calls === 1) throw new Error('断网了')
            return { sources: [] }
        })

        await expect(cache.load()).rejects.toThrow('断网了')
        await expect(cache.load()).resolves.toEqual({ sources: [] })
        expect(calls).toBe(2)
    })

    it('失败之后别的调用也拿得到这个失败，不会各自再打一遍', async () => {
        let calls = 0
        const gate = deferred()
        const cache = createSourcesCache(() => {
            calls += 1
            return gate.promise
        })

        const both = Promise.allSettled([cache.load(), cache.load()])
        gate.reject(new Error('断网了'))
        const results = await both

        expect(calls).toBe(1)
        expect(results.every((one) => one.status === 'rejected')).toBe(true)
    })

    it('失效之后立刻重新拉，不再给旧的', async () => {
        let calls = 0
        const cache = createSourcesCache(async () => {
            calls += 1
            return { n: calls }
        })

        expect(await cache.load()).toEqual({ n: 1 })
        cache.invalidate()
        expect(await cache.load()).toEqual({ n: 2 })
    })

    it('失效**之前**发出的那趟回来了，也不许写进缓存', async () => {
        const oldGate = deferred()
        let calls = 0
        const cache = createSourcesCache(() => {
            calls += 1
            return calls === 1 ? oldGate.promise : Promise.resolve({ n: '新' })
        })

        const stale = cache.load() // 这一趟在飞
        cache.invalidate() // 用户在这期间改了书源
        const fresh = cache.load() // 于是重新拉
        expect(await fresh).toEqual({ n: '新' })

        oldGate.resolve({ n: '旧' }) // 旧的那趟这才回来
        await stale

        // 旧数据不能顶掉新的：否则接下来整个时限内读到的都是它
        expect(await cache.load()).toEqual({ n: '新' })
        expect(calls).toBe(2)
    })

    it('旧的那趟回来，不会把新那趟「正在飞」的标记清掉', async () => {
        const oldGate = deferred()
        const newGate = deferred()
        let calls = 0
        const cache = createSourcesCache(() => {
            calls += 1
            return calls === 1 ? oldGate.promise : newGate.promise
        })

        const first = cache.load()
        cache.invalidate()
        const second = cache.load()

        oldGate.resolve({ n: '旧' })
        await first
        await settle()

        // 新的那趟还在飞，这一步应当复用它 —— 清错了标记就会白白再起一趟
        const third = cache.load()
        expect(calls).toBe(2)

        newGate.resolve({ n: '新' })
        const [one, two] = await Promise.all([second, third])
        // `load` 是 async 的，每次返回的 promise 都是新的包装，所以比的是**结果**：
        // 两次拿到同一个对象，说明确实走的同一趟请求
        expect(two).toBe(one)
        expect(one).toEqual({ n: '新' })
    })
})
