/*
 * 书源分组 / 筛选（`public/js/sourceFilter.js`）的单元测试
 *
 * 样本刻意照线上那份语料的形状来：**分组字段是多值的**（`通常书源 📂,快速书源 ⚡`），
 * 而且同一个源在两个大组里的标签顺序还不一样 —— 这是最容易写出 bug 的地方。
 *
 * 归组的规矩是「只认第一个标签」（`primaryGroup`），所以下面的分组条数按**第一个标签**
 * 算，而不是按标签出现次数算：`a` 挂着「通常 + 快速」，只算进「通常」那一组。
 */

import { describe, expect, it } from 'vitest'
import {
    ABILITY_ALL,
    ABILITY_EXPLORE,
    ABILITY_LOGIN,
    ABILITY_SEARCH,
    DEFAULT_FILTER,
    GROUP_ALL,
    GROUP_NONE,
    STATUS_ALL,
    STATUS_OFF,
    STATUS_ON,
    filterSources,
    groupLabel,
    groupOptions,
    groupSources,
    isFiltering,
    mutableIds,
    primaryGroup,
    splitGroups,
    tally,
} from '../public/js/sourceFilter.js'

/** 字段与 `/api/sources` 的摘要一致 */
const SOURCES = [
    {
        id: 'a',
        name: '甲书源',
        group: '通常书源 📂,快速书源 ⚡',
        enabled: true,
        hasSearch: true,
        hasExplore: true,
    },
    { id: 'b', name: '乙书源', group: '快速书源 ⚡,通常书源 📂', enabled: false, hasSearch: true },
    { id: 'c', name: '丙书源', group: '通常书源 📂', enabled: true, hasExplore: true },
    { id: 'd', name: '丁书源', group: '通常书源 📂', enabled: true, hasSearch: true },
    {
        id: 'e',
        name: '戊漫画',
        group: '漫画书源 🎨,通常书源 📂',
        enabled: false,
        hasSearch: true,
        hasExplore: true,
    },
    { id: 'f', name: '己漫画', group: '漫画书源 🎨', enabled: true, hasExplore: true },
    {
        id: 'g',
        name: '庚听书',
        group: '有声书源 🔊,快速书源 ⚡',
        enabled: true,
        hasSearch: true,
        hasLogin: true,
    },
    { id: 'h', name: '辛无组', group: '', enabled: true, hasSearch: true },
]

const ids = (list) => list.map((one) => one.id)

describe('splitGroups', () => {
    it('按逗号拆成标签', () => {
        expect(splitGroups('通常书源 📂,快速书源 ⚡')).toEqual(['通常书源 📂', '快速书源 ⚡'])
    })

    it('全角逗号与顿号也认（别处的合集里出现过）', () => {
        expect(splitGroups('甲，乙、丙')).toEqual(['甲', '乙', '丙'])
    })

    it('去空白、丢空档', () => {
        expect(splitGroups(' 甲 ,, 乙 , ')).toEqual(['甲', '乙'])
    })

    it('空 / null 给空数组，而不是一个空字符串档', () => {
        expect(splitGroups('')).toEqual([])
        expect(splitGroups(null)).toEqual([])
        expect(splitGroups(undefined)).toEqual([])
        expect(splitGroups(123)).toEqual(['123'])
    })
})

describe('primaryGroup', () => {
    it('取第一个标签 —— 列表要「一源一行」，按标签展开会让同一个源出现两次', () => {
        expect(primaryGroup({ group: '通常书源 📂,快速书源 ⚡' })).toBe('通常书源 📂')
        // 同样两个标签、顺序反过来，归的组也不同：它跟着语料走，不是按条数挑
        expect(primaryGroup({ group: '快速书源 ⚡,通常书源 📂' })).toBe('快速书源 ⚡')
    })

    it('没有标签就是未分组', () => {
        expect(primaryGroup({ group: '' })).toBe(GROUP_NONE)
        expect(primaryGroup({})).toBe(GROUP_NONE)
        expect(primaryGroup(null)).toBe(GROUP_NONE)
    })
})

describe('groupLabel', () => {
    it('空串那一档要有人话的名字', () => {
        expect(groupLabel(GROUP_NONE)).toBe('未分组')
        expect(groupLabel('漫画书源 🎨')).toBe('漫画书源 🎨')
    })
})

describe('filterSources', () => {
    it('一个条件都不给就全给', () => {
        expect(filterSources(SOURCES)).toHaveLength(8)
        expect(filterSources(SOURCES, DEFAULT_FILTER)).toHaveLength(8)
    })

    it('关键词按名字匹配，去空白、不区分大小写', () => {
        expect(ids(filterSources(SOURCES, { keyword: ' 乙 ' }))).toEqual(['b'])
        expect(filterSources([{ id: 'x', name: 'ABC' }], { keyword: 'abc' })).toHaveLength(1)
    })

    it('关键词也匹配分组，而且**所有**标签都算', () => {
        expect(ids(filterSources(SOURCES, { keyword: '有声' }))).toEqual(['g'])
        expect(ids(filterSources(SOURCES, { keyword: '漫画' }))).toEqual(['e', 'f'])
        // g 的第一个标签是「有声书源」，第二个才是「快速书源」：按关键词找得到
        expect(ids(filterSources(SOURCES, { keyword: '快速' }))).toEqual(['a', 'b', 'g'])
    })

    it('按分组筛看的是**归到哪一组**（第一个标签）—— 与列表和下拉里的条数同一套口径', () => {
        // a 归在「通常」（第一个标签），所以按「快速书源」筛时它不该出现；
        // g 的第一个标签是「有声书源」，按「快速」同样筛不到。想按标签找用关键词。
        expect(ids(filterSources(SOURCES, { group: '快速书源 ⚡' }))).toEqual(['b'])
        expect(ids(filterSources(SOURCES, { group: '通常书源 📂' }))).toEqual(['a', 'c', 'd'])
        expect(ids(filterSources(SOURCES, { group: '漫画书源 🎨' }))).toEqual(['e', 'f'])
    })

    it('下拉里的条数就是选中之后的条数 —— 两处口径不一致过一次，是量出来才发现的', () => {
        for (const { name, count } of groupOptions(SOURCES)) {
            expect(filterSources(SOURCES, { group: name })).toHaveLength(count)
        }
    })

    it('未分组那一档只留没有标签的', () => {
        expect(ids(filterSources(SOURCES, { group: GROUP_NONE }))).toEqual(['h'])
    })

    it('全部分组就是不过滤', () => {
        expect(filterSources(SOURCES, { group: GROUP_ALL })).toHaveLength(8)
    })

    it('状态档', () => {
        expect(ids(filterSources(SOURCES, { status: STATUS_ON }))).toEqual([
            'a',
            'c',
            'd',
            'f',
            'g',
            'h',
        ])
        expect(ids(filterSources(SOURCES, { status: STATUS_OFF }))).toEqual(['b', 'e'])
        expect(filterSources(SOURCES, { status: STATUS_ALL })).toHaveLength(8)
    })

    it('能力档', () => {
        expect(ids(filterSources(SOURCES, { ability: ABILITY_SEARCH }))).toEqual([
            'a',
            'b',
            'd',
            'e',
            'g',
            'h',
        ])
        expect(ids(filterSources(SOURCES, { ability: ABILITY_EXPLORE }))).toEqual([
            'a',
            'c',
            'e',
            'f',
        ])
        expect(ids(filterSources(SOURCES, { ability: ABILITY_LOGIN }))).toEqual(['g'])
        expect(filterSources(SOURCES, { ability: ABILITY_ALL })).toHaveLength(8)
    })

    it('几个条件是一起生效的（与），不是取或', () => {
        expect(ids(filterSources(SOURCES, { group: '通常书源 📂', status: STATUS_ON }))).toEqual([
            'a',
            'c',
            'd',
        ])
        expect(
            ids(filterSources(SOURCES, { group: '漫画书源 🎨', ability: ABILITY_SEARCH })),
        ).toEqual(['e'])
        expect(
            filterSources(SOURCES, {
                group: '漫画书源 🎨',
                status: STATUS_OFF,
                ability: ABILITY_LOGIN,
            }),
        ).toEqual([])
    })

    it('保持调用方给的顺序（与「书源」页看到的顺序一致）', () => {
        const reversed = [...SOURCES].reverse()
        expect(ids(filterSources(reversed, { status: STATUS_ON }))).toEqual([
            'h',
            'g',
            'f',
            'd',
            'c',
            'a',
        ])
    })

    it('垃圾输入给空数组，而不是抛错', () => {
        expect(filterSources(null)).toEqual([])
        expect(filterSources(undefined)).toEqual([])
        expect(filterSources('不是数组')).toEqual([])
        expect(filterSources([null, undefined])).toEqual([])
    })

    it('给出来的是原来那个对象（渲染不要复制一份走）', () => {
        expect(filterSources(SOURCES, { keyword: '甲' })[0]).toBe(SOURCES[0])
    })
})

describe('groupOptions', () => {
    it('条数多的在前，未分组永远在最后', () => {
        expect(groupOptions(SOURCES)).toEqual([
            { name: '通常书源 📂', count: 3 },
            { name: '漫画书源 🎨', count: 2 },
            { name: '快速书源 ⚡', count: 1 },
            { name: '有声书源 🔊', count: 1 },
            { name: GROUP_NONE, count: 1 },
        ])
    })

    it('条数之和等于总数 —— 因为归组只认第一个标签（按标签展开就会重复计数）', () => {
        const sum = groupOptions(SOURCES).reduce((n, one) => n + one.count, 0)
        expect(sum).toBe(SOURCES.length)
    })

    it('空清单给空数组', () => {
        expect(groupOptions([])).toEqual([])
        expect(groupOptions(null)).toEqual([])
    })
})

describe('groupSources', () => {
    it('按分组归拢，未分组在最后', () => {
        const groups = groupSources(SOURCES)
        expect(groups.map((one) => one.name)).toEqual([
            '通常书源 📂',
            '漫画书源 🎨',
            '快速书源 ⚡',
            '有声书源 🔊',
            GROUP_NONE,
        ])
        expect(ids(groups[0].items)).toEqual(['a', 'c', 'd'])
        expect(ids(groups[1].items)).toEqual(['e', 'f'])
        expect(ids(groups[4].items)).toEqual(['h'])
    })

    it('同一个源只出现在一组里（不会因为挂了两个标签被列两遍）', () => {
        const flat = groupSources(SOURCES).flatMap((one) => ids(one.items))
        expect(flat).toEqual(['a', 'c', 'd', 'e', 'f', 'b', 'g', 'h'])
        expect(new Set(flat).size).toBe(flat.length)
    })

    it('筛选与归组叠加：筛出来的才归组', () => {
        const groups = groupSources(SOURCES, { status: STATUS_ON })
        expect(groups.map((one) => one.name)).toEqual([
            '通常书源 📂',
            '漫画书源 🎨',
            '有声书源 🔊',
            GROUP_NONE,
        ])
        expect(ids(groups[0].items)).toEqual(['a', 'c', 'd'])
    })

    it('指定了某一组就只出一个分组头，内容就是那一组', () => {
        const groups = groupSources(SOURCES, { group: '快速书源 ⚡' })
        expect(groups).toHaveLength(1)
        expect(groups[0].name).toBe('快速书源 ⚡')
        expect(ids(groups[0].items)).toEqual(['b'])
    })

    it('筛空了给空数组（调用方据此显示空状态）', () => {
        expect(groupSources(SOURCES, { keyword: '不存在的名字' })).toEqual([])
    })
})

describe('tally', () => {
    it('各档条数', () => {
        expect(tally(SOURCES)).toEqual({ total: 8, on: 6, off: 2, search: 6, explore: 4, login: 1 })
    })

    it('空清单给全零', () => {
        expect(tally([])).toEqual({ total: 0, on: 0, off: 0, search: 0, explore: 0, login: 0 })
        expect(tally(null)).toEqual({ total: 0, on: 0, off: 0, search: 0, explore: 0, login: 0 })
    })
})

describe('isFiltering', () => {
    it('一个都没设就不算在筛', () => {
        expect(isFiltering()).toBe(false)
        expect(isFiltering(DEFAULT_FILTER)).toBe(false)
        expect(isFiltering({ keyword: '   ' })).toBe(false)
        expect(isFiltering({ group: GROUP_ALL })).toBe(false)
    })

    it('设了任意一项就算', () => {
        expect(isFiltering({ keyword: '甲' })).toBe(true)
        expect(isFiltering({ group: '漫画书源 🎨' })).toBe(true)
        expect(isFiltering({ status: STATUS_ON })).toBe(true)
        expect(isFiltering({ ability: ABILITY_SEARCH })).toBe(true)
    })
})

describe('mutableIds', () => {
    it('内置测试源不算在内 —— 它是只读的，混进去会让整批回一个 400', () => {
        expect(mutableIds(SOURCES)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
        expect(
            mutableIds([{ id: 'builtin:fixture-css', builtin: true }, { id: 'user:https://a#b' }]),
        ).toEqual(['user:https://a#b'])
    })

    it('id 转成字符串（localStorage / 服务端可能给数字）', () => {
        expect(mutableIds([{ id: 7 }])).toEqual(['7'])
        expect(mutableIds(null)).toEqual([])
    })
})
