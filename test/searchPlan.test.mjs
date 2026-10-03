import { describe, expect, it } from 'vitest'
import { halveSlice, isCpuLimitError, planSlices, runPool } from '../public/js/searchPlan.js'

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
            { concurrency: 2 },
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
            async (slice) => {
                throw Object.assign(new Error('Worker exceeded CPU time limit.'), {
                    status: 503,
                })
            },
            {
                concurrency: 1,
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
            onSettled: () => (settled += 1),
        })
        expect(settled).toBe(3)
        expect(results).toHaveLength(3)
    })

    it('空任务列表直接返回空结果', async () => {
        expect(await runPool([], async () => {})).toEqual([])
    })
})
