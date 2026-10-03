import { describe, expect, it } from 'vitest'
import {
    SEARCH_MIN_PAGE,
    SEARCH_PAGE_SIZE,
    isCpuLimitError,
    nextPageSize,
} from '../public/js/searchPlan.js'

describe('nextPageSize', () => {
    it('折半', () => {
        expect(nextPageSize(10)).toBe(5)
        expect(nextPageSize(5)).toBe(2)
        expect(nextPageSize(4)).toBe(2)
    })

    it('一路折到下限就停住 —— 不能让调用方以为还能更小', () => {
        expect(nextPageSize(2)).toBe(1)
        expect(nextPageSize(1)).toBe(1)
        expect(nextPageSize(0)).toBe(1)
    })

    it('非数字也给出下限，而不是 NaN', () => {
        expect(nextPageSize(NaN)).toBe(SEARCH_MIN_PAGE)
        expect(nextPageSize(undefined)).toBe(SEARCH_MIN_PAGE)
        expect(nextPageSize('abc')).toBe(SEARCH_MIN_PAGE)
    })
})

/**
 * 默认值本身也钉住
 *
 * 线上实测：第二次搜索的 76 个分片几乎全灭（第一次把弹性额度用光了）。
 * 所以默认页大小是「一页一个请求、额度按人点一次花一批」的取向，
 * 调大它之前先回看 README「第二十六轮」。
 */
describe('默认值', () => {
    it('一页默认在保守区间里', () => {
        expect(SEARCH_PAGE_SIZE).toBeGreaterThan(0)
        expect(SEARCH_PAGE_SIZE).toBeLessThanOrEqual(20)
    })

    it('下限是 1', () => {
        expect(SEARCH_MIN_PAGE).toBe(1)
    })
})

describe('isCpuLimitError', () => {
    it('503 算', () => {
        expect(isCpuLimitError({ status: 503 })).toBe(true)
    })

    it('带 exceeded / CPU 字样的算', () => {
        expect(isCpuLimitError(new Error('Worker exceeded CPU time limit.'))).toBe(true)
    })

    it('业务错误不算 —— 缩页重试救不了它，白花额度', () => {
        expect(isCpuLimitError(new Error('请求体必须是 JSON'))).toBe(false)
        expect(isCpuLimitError({ status: 400 })).toBe(false)
        expect(isCpuLimitError(null)).toBe(false)
        expect(isCpuLimitError(undefined)).toBe(false)
    })
})
