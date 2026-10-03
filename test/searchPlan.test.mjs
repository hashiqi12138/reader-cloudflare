import { describe, expect, it } from 'vitest'
import {
    SEARCH_CONCURRENCY,
    SEARCH_GAP_MS,
    SEARCH_SLICE_SIZE,
    halveSlice,
    isCpuLimitError,
    planSlices,
    runPool,
} from '../public/js/searchPlan.js'

describe('planSlices', () => {
    it('按片大小切开，最后一片可以更短', () => {
        expect(planSlices(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    })

    it('刚好整除时不多出一片空的', () => {
        expect(planSlices(['a', 'b'], 2)).toEqual([['a', 'b']])
    })

    it('空列表得到空数组', () => {
        expect(planSlices([], 3)).toEqual([])
        expect(planSlices(null, 3)).toEqual([])
    })

    it('片大小非法时按 1 处理 —— 不能返回空数组，否则会一片都不搜', () => {
        expect(planSlices(['a', 'b'], 0)).toEqual([['a'], ['b']])
        expect(planSlices(['a', 'b'], -3)).toEqual([['a'], ['b']])
        expect(planSlices(['a', 'b'], 1.5)).toEqual([['a'], ['b']])
    })
})

describe('halveSlice', () => {
    it('偶数长度对半劈', () => {
        expect(halveSlice(['a', 'b', 'c', 'd'])).toEqual([
            ['a', 'b'],
            ['c', 'd'],
        ])
    })

    it('奇数长度前半多一个', () => {
        expect(halveSlice(['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']])
    })

    it('单片没得劈 —— 返回 null 而不是原样返回，否则会无限重试', () => {
        expect(halveSlice(['a'])).toBeNull()
        expect(halveSlice([])).toBeNull()
        expect(halveSlice(null)).toBeNull()
    })
})

describe('isCpuLimitError', () => {
    it('503 算', () => {
        expect(isCpuLimitError({ status: 503 })).toBe(true)
    })

    it('带 exceeded / CPU 字样的算', () => {
        expect(isCpuLimitError(new Error('Worker exceeded CPU time limit.'))).toBe(true)
    })

    it('业务错误不算 —— 劈半重试救不了它，白花请求', () => {
        expect(isCpuLimitError(new Error('请求体必须是 JSON'))).toBe(false)
        expect(isCpuLimitError({ status: 400 })).toBe(false)
        expect(isCpuLimitError(null)).toBe(false)
        expect(isCpuLimitError(undefined)).toBe(false)
    })
})

/**
 * 默认值本身也要钉住
 *
 * 线上实测：连着发请求时前几片连 226 ms CPU 都能过，之后连 10 ms 都被掐。
 * 所以这三个默认值是「宁可慢」的取向，调大它们之前先回看「第二十六轮」。
 */
describe('默认参数', () => {
    it('片大小与并发都在保守区间里', () => {
        expect(SEARCH_SLICE_SIZE).toBeGreaterThan(0)
        expect(SEARCH_SLICE_SIZE).toBeLessThanOrEqual(8)
        expect(SEARCH_CONCURRENCY).toBeGreaterThanOrEqual(1)
        expect(SEARCH_CONCURRENCY).toBeLessThanOrEqual(3)
    })

    it('片之间默认要歇一下（靠它把请求频率压下来）', () => {
        expect(SEARCH_GAP_MS).toBeGreaterThan(0)
    })
})

describe('runPool', () => {
    it('并发不超过 concurrency', async () => {
        let flying = 0
        let peak = 0
        await runPool(
            [1, 2, 3, 4, 5, 6],
            async () => {
                flying += 1
                peak = Math.max(peak, flying)
                await new Promise((resolve) => setTimeout(resolve, 5))
                flying -= 1
            },
            { concurrency: 2, gapMs: 0 },
        )
        expect(peak).toBe(2)
    })

    it('一片被掐就劈半重试，最后每个源都跑到过', async () => {
        const tried = []
        await runPool(
            [[1, 2, 3, 4], [5]],
            async (slice) => {
                tried.push(slice)
                if (slice.length > 1) {
                    throw Object.assign(new Error('Worker exceeded CPU time limit.'), {
                        status: 503,
                    })
                }
                return slice
            },
            {
                concurrency: 1,
                gapMs: 0,
                onError: (err, slice) => (isCpuLimitError(err) ? halveSlice(slice) : null),
            },
        )
        const singles = tried.filter((slice) => slice.length === 1).flat()
        expect(singles.sort()).toEqual([1, 2, 3, 4, 5])
        // 4 个源那片至少要劈三轮（4 → 2+2 → 1+1+1+1）
        expect(tried.length).toBeGreaterThan(5)
    })

    it('劈到单片还是失败就收手，不会无限重试', async () => {
        const results = await runPool(
            [[1, 2]],
            async () => {
                throw Object.assign(new Error('Worker exceeded CPU time limit.'), {
                    status: 503,
                })
            },
            {
                concurrency: 1,
                gapMs: 0,
                onError: (err, slice) => (isCpuLimitError(err) ? halveSlice(slice) : null),
            },
        )
        expect(results).toHaveLength(2)
        expect(results.every((entry) => entry.ok === false)).toBe(true)
        expect(results.every((entry) => entry.task.length === 1)).toBe(true)
    })

    it('每片都有结论，onSettled 的次数与结果条数一致', async () => {
        let settled = 0
        const results = await runPool(['a', 'b', 'c'], async (task) => task, {
            concurrency: 2,
            gapMs: 0,
            onSettled: () => (settled += 1),
        })
        expect(settled).toBe(3)
        expect(results).toHaveLength(3)
    })

    it('空任务列表直接返回空结果', async () => {
        expect(await runPool([], async () => {})).toEqual([])
    })

    it('gapMs 真的让每片之间歇一下', async () => {
        const started = Date.now()
        await runPool(['a', 'b', 'c'], async (task) => task, { concurrency: 1, gapMs: 40 })
        // 三片两次间隔，留足容差（CI 上定时器不精确）
        expect(Date.now() - started).toBeGreaterThanOrEqual(60)
    })
})
