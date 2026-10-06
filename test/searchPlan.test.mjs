import { describe, expect, it } from 'vitest'
import {
    SEARCH_MIN_PAGE,
    SEARCH_PAGE_SIZE,
    isCpuLimitError,
    nextPageSize,
    normalizeSelection,
    searchAllAtOnce,
    searchableSources,
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
 * 免费计划的 10 ms 是**整个请求**的预算，一页里多一个要跑脚本的源就多一分被掐的
 * 概率，而被掐的代价是整页白花 —— 所以默认页大小一路从 10 收到 3。
 * 调大它之前先回看 EXPERIENCE.md「第二十六轮」与「第二十九轮」。
 */
describe('默认值', () => {
    it('一页默认在保守区间里', () => {
        expect(SEARCH_PAGE_SIZE).toBeGreaterThan(0)
        expect(SEARCH_PAGE_SIZE).toBeLessThanOrEqual(5)
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

/**
 * 「一次搜完全部书源」这条开关只认服务端说的
 *
 * 值得单独钉住的是**默认方向**：读不到（老服务端、离线、还没加载）时必须按
 * **关**处理 —— 反过来会在不能一次搜完的部署上把分页与折半那套兜底一起关掉，
 * 而那种部署（线上免费计划）恰恰最需要它们。
 */
describe('searchAllAtOnce', () => {
    it('服务端说开才是开', () => {
        expect(searchAllAtOnce({ searchAllSources: true })).toBe(true)
    })

    it('读不到 / 字段缺席 / 值不是 true → 一律按关处理（保守的那条）', () => {
        expect(searchAllAtOnce(undefined)).toBe(false)
        expect(searchAllAtOnce(null)).toBe(false)
        expect(searchAllAtOnce({})).toBe(false)
        expect(searchAllAtOnce({ searchAllSources: false })).toBe(false)
        // 字符串 'true' 不算：这个字段是 JSON 的布尔，不是环境变量那种字符串
        expect(searchAllAtOnce({ searchAllSources: 'true' })).toBe(false)
        expect(searchAllAtOnce(true)).toBe(false)
    })
})

/** 一页书源摘要的样本（字段与 `/api/sources` 一致） */
const SOURCES = [
    { id: 'a', name: '甲书源', group: '玄幻', enabled: true, hasSearch: true },
    { id: 'b', name: '乙书源', group: '', enabled: false, hasSearch: true },
    { id: 'c', name: '丙书源', group: '玄幻', enabled: true, hasSearch: false },
    { id: 'd', name: '丁听书', group: '有声', enabled: true, hasSearch: true },
]

describe('searchableSources', () => {
    it('只留「启用的 + 有搜索规则的」', () => {
        expect(searchableSources(SOURCES).map((one) => one.id)).toEqual(['a', 'd'])
    })

    it('保持服务端给的顺序（与「书源」页看到的顺序一致）', () => {
        const reversed = [...SOURCES].reverse()
        expect(searchableSources(reversed).map((one) => one.id)).toEqual(['d', 'a'])
    })

    it('垃圾输入给空数组，而不是抛错', () => {
        expect(searchableSources(null)).toEqual([])
        expect(searchableSources(undefined)).toEqual([])
        expect(searchableSources('不是数组')).toEqual([])
        expect(searchableSources([null, undefined])).toEqual([])
    })
})

/**
 * 「按名字 / 分组筛」那个纯函数搬去了 `sourceFilter.js`
 *
 * 这一轮把「按分组筛」也加了进来，而它与「按关键词筛」必须共用同一套判据，
 * 否则同一个源在「书源」页搜得到、在搜索范围面板里搜不到。它的用例整体迁到了
 * `sourceFilter.test.mjs` 的 `filterSources` 那一组，这里不再有 `matchSources`。
 */

describe('normalizeSelection', () => {
    it('丢掉已经不在清单里的 id —— 书源被删 / 停用 / 没了搜索规则', () => {
        expect(normalizeSelection(['a', 'b', 'c', 'z'], SOURCES)).toEqual(['a'])
    })

    it('去重，并保持原来的先后顺序', () => {
        expect(normalizeSelection(['d', 'a', 'd'], SOURCES)).toEqual(['d', 'a'])
    })

    it('空输入给空数组（也就是「不限定范围」）', () => {
        expect(normalizeSelection([], SOURCES)).toEqual([])
        expect(normalizeSelection(null, SOURCES)).toEqual([])
    })

    it('id 不是字符串也能对上（localStorage 里可能是数字）', () => {
        expect(
            normalizeSelection([1], [{ id: 1, name: '一号', enabled: true, hasSearch: true }]),
        ).toEqual(['1'])
    })
})
