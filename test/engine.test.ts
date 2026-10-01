/**
 * 规则引擎的单元测试
 *
 * 只测**纯函数**部分（规则解析、位置选择、正则链、JSONPath）——
 * 它们不依赖 cheerio、不依赖 Workers 运行时，所以能在 Node 里毫秒级跑完。
 * 涉及 cheerio 与 QuickJS-WASM 的整条链路由 scripts/smoke.mjs 在真实运行时里验证，
 * 两者分工明确：这里保证语义正确性，那里保证运行时可跑。
 */

import { describe, expect, it } from 'vitest'

import { applyIndex, parseIndexExpr, parseJsoupRule } from '../src/engine/jsoup'
import { applyAllInOne, applyRegexOps, splitRegexChain } from '../src/engine/regex'
import { queryJsonPath } from '../src/engine/jsonpath'

describe('JSOUP 默认规则解析', () => {
    it('把 `class.odd.0@tag.a.0@text` 解析成两级选择加取值', () => {
        const plan = parseJsoupRule('class.odd.0@tag.a.0@text')
        expect(plan.reverse).toBe(false)
        expect(plan.extract).toBe('text')
        expect(plan.steps).toEqual([
            { by: 'class', name: 'odd', index: { picks: [0] } },
            { by: 'tag', name: 'a', index: { picks: [0] } },
        ])
    })

    it('末段的 text 是「取值」，而前段的 text.x 是「按文本找元素」', () => {
        // 末段取值
        expect(parseJsoupRule('tag.a@text').extract).toBe('text')
        expect(parseJsoupRule('tag.a@text').steps).toEqual([{ by: 'tag', name: 'a', index: null }])

        // 前段按文本找元素
        const plan = parseJsoupRule('text.下一页@href')
        expect(plan.extract).toBe('href')
        expect(plan.steps).toEqual([{ by: 'text', name: '下一页', index: null }])
    })

    it('识别任意属性名作为取值', () => {
        expect(parseJsoupRule('tag.img@src').extract).toBe('src')
        expect(parseJsoupRule('tag.a@data-id').extract).toBe('data-id')
    })

    it('方括号形式的位置与点号形式等价', () => {
        expect(parseJsoupRule('tag.div[0]').steps).toEqual([
            { by: 'tag', name: 'div', index: { picks: [0] } },
        ])
        expect(parseJsoupRule('class.item.1').steps).toEqual([
            { by: 'class', name: 'item', index: { picks: [1] } },
        ])
    })

    it('解析区间与排除位置', () => {
        expect(parseJsoupRule('tag.div[-1:0]').steps[0]!.index).toEqual({ picks: [[-1, 0, null]] })
        expect(parseJsoupRule('tag.li[!0,2]').steps[0]!.index).toEqual({ excludes: [0, 2] })
        expect(parseJsoupRule('tag.li[1:10:2]').steps[0]!.index).toEqual({ picks: [[1, 10, 2]] })
    })

    it('裸索引等价于 children 的下标', () => {
        expect(parseJsoupRule('head@.1@text').steps).toEqual([
            { by: 'tag', name: 'head', index: null },
            { by: 'children', name: '', index: { picks: [1] } },
        ])
    })

    it('开头的 `-` 表示列表倒置，但不能误吃掉负索引规则', () => {
        expect(parseJsoupRule('-class.odd.0@tag.a@text').reverse).toBe(true)
        // `-1` 开头是负索引，不是倒置标记
        expect(parseJsoupRule('-1@text').reverse).toBe(false)
    })

    it('children 是选择步骤而不是取值', () => {
        const plan = parseJsoupRule('tag.ul@children')
        expect(plan.extract).toBe('text')
        expect(plan.steps).toEqual([
            { by: 'tag', name: 'ul', index: null },
            { by: 'children', name: '', index: null },
        ])
    })
})

describe('位置选择', () => {
    const items = ['a', 'b', 'c', 'd']

    it('单点取第 n 个', () => {
        expect(applyIndex(items, parseIndexExpr('1'))).toEqual(['b'])
    })

    it('负数从末尾数', () => {
        expect(applyIndex(items, parseIndexExpr('-1'))).toEqual(['d'])
        expect(applyIndex(items, parseIndexExpr('-2'))).toEqual(['c'])
    })

    it('区间两端都是闭区间', () => {
        expect(applyIndex(items, parseIndexExpr('1:2'))).toEqual(['b', 'c'])
        expect(applyIndex(items, parseIndexExpr('1:5:2'))).toEqual(['b', 'd'])
    })

    it('start 大于 end 时自动倒序（[-1:0] 就靠这个）', () => {
        expect(applyIndex(items, parseIndexExpr('-1:0'))).toEqual(['d', 'c', 'b', 'a'])
    })

    it('排除指定序号', () => {
        expect(applyIndex(items, parseIndexExpr('!0,2'))).toEqual(['b', 'd'])
    })

    it('越界不抛错，只是取不到', () => {
        expect(applyIndex(items, parseIndexExpr('99'))).toEqual([])
    })

    it('null 表示不做限制', () => {
        expect(applyIndex(items, null)).toEqual(items)
    })
})

describe('正则链', () => {
    it('从尾部剥出净化正则，返回剩下的选择器', () => {
        const { selector, ops } = splitRegexChain('class.item.0@text##\\s+## ')
        expect(selector).toBe('class.item.0@text')
        expect(ops).toEqual([{ pattern: '\\s+', replacement: ' ', onlyOne: false }])
    })

    it('能剥出多条链，并按出现顺序执行', () => {
        const { ops } = splitRegexChain('tag.a@text##A##B##C##D')
        expect(ops).toHaveLength(2)
        expect(ops[0]).toEqual({ pattern: 'A', replacement: 'B', onlyOne: false })
        expect(ops[1]).toEqual({ pattern: 'C', replacement: 'D', onlyOne: false })
    })

    it('### 结尾表示只替换第一个匹配', () => {
        const { ops } = splitRegexChain('tag.a@text##第(.+?)章##章节###')
        expect(ops).toEqual([{ pattern: '第(.+?)章', replacement: '章节', onlyOne: true }])
    })

    it('@# 转义成 #', () => {
        const { ops } = splitRegexChain('tag.a@text##a@#b##c')
        expect(ops[0]!.pattern).toBe('a#b')
    })

    it('替换内容里可以含 #', () => {
        const { ops } = splitRegexChain('tag.a@text##x##a#b')
        expect(ops[0]!.replacement).toBe('a#b')
    })

    it('净化是循环替换，OnlyOne 只替换第一处', () => {
        const text = 'A1A2A3'
        expect(applyRegexOps(text, [{ pattern: 'A', replacement: '-', onlyOne: false }])).toBe(
            '-1-2-3',
        )
        expect(applyRegexOps(text, [{ pattern: 'A', replacement: '-', onlyOne: true }])).toBe(
            '-1A2A3',
        )
    })

    it('正则写坏时跳过而不是崩掉整次求值', () => {
        expect(applyRegexOps('abc', [{ pattern: '(', replacement: 'x', onlyOne: false }])).toBe(
            'abc',
        )
    })
})

describe('AllInOne 正则', () => {
    it('按正则把整段切成列表', () => {
        expect(applyAllInOne('一|二|三', ':([^|]+)')).toEqual(['一', '二', '三'])
    })

    it('切出来的每一项还能再套一层净化正则', () => {
        expect(applyAllInOne('第1章|第2章', ':第(\\d+)章##章##')).toEqual(['1', '2'])
    })

    it('没有匹配时返回空列表', () => {
        expect(applyAllInOne('abc', ':不存在')).toEqual([])
    })

    it('零宽匹配不会死循环', () => {
        expect(applyAllInOne('abc', ':(?=b)')).toEqual([])
    })
})

describe('JSONPath', () => {
    const data = {
        code: 200,
        data: {
            list: [
                { name: '甲', tags: ['x', 'y'] },
                { name: '乙', tags: [] },
            ],
        },
    }

    it('逐层取键', () => {
        expect(queryJsonPath(data, '$.code')).toEqual([200])
    })

    it('数组下标与通配', () => {
        expect(queryJsonPath(data, '$.data.list[0].name')).toEqual(['甲'])
        expect(queryJsonPath(data, '$.data.list[*].name')).toEqual(['甲', '乙'])
    })

    it('负数下标从末尾取', () => {
        expect(queryJsonPath(data, '$.data.list[-1].name')).toEqual(['乙'])
    })

    it('引号键名', () => {
        expect(queryJsonPath(data, "$['data']['list'][0]['name']")).toEqual(['甲'])
    })

    it('递归下降', () => {
        expect(queryJsonPath(data, '$..name')).toEqual(['甲', '乙'])
    })

    it('不支持的方括号内容要明确报错，而不是静默返回空', () => {
        expect(() => queryJsonPath(data, '$.data.list[?]')).toThrow(/过滤器缺少收尾/)
        expect(() => queryJsonPath(data, '$.data[abc]')).toThrow(/方括号/)
    })

    // 过滤器只实现两种形态：线上 816 条书源里一共 8 处，全都是这两种
    describe('过滤器', () => {
        const tracks = {
            tracks: {
                list: [
                    { title: '音频一', type: 'audio', volume: false, size: 30 },
                    { title: '图片一', type: 'image', volume: false, size: 5 },
                    { title: '音频二', type: 'audio', volume: true, size: 40 },
                ],
            },
        }

        it('等值比较（书源里的 `?(@.type=="audio")`）', () => {
            expect(queryJsonPath(tracks, '$.tracks.list[?(@.type=="audio")]')).toEqual([
                tracks.tracks.list[0],
                tracks.tracks.list[2],
            ])
        })

        it('递归下降 + 过滤器（书源里的 `$..[?(@.type=="audio")]`）', () => {
            // asmr 那类接口站点的章节列表就是这么写的。
            // `$..` 会把数组和它的元素都收成候选，同一个对象因此可能被选中两次，
            // 必须去重 —— 不然章节列表会出现重复项
            const hits = queryJsonPath(tracks, '$..[?(@.type=="audio")]')
            expect(hits).toEqual([tracks.tracks.list[0], tracks.tracks.list[2]])
            expect(new Set(hits).size).toBe(hits.length)
        })

        it('存在性判断（`?(@.bookName)`）', () => {
            expect(queryJsonPath(tracks, '$.tracks.list[?(@.title)]')).toHaveLength(3)
            expect(queryJsonPath(tracks, '$.tracks.list[?(@.mediaStreamUrl)]')).toEqual([])
        })

        it('布尔字面量（书源里的 `?(@.volume==false)`）', () => {
            expect(queryJsonPath(tracks, '$.tracks.list[?(@.volume==false)]')).toEqual([
                tracks.tracks.list[0],
                tracks.tracks.list[1],
            ])
        })

        it('不等与数值比较', () => {
            expect(queryJsonPath(tracks, '$.tracks.list[?(@.type!="audio")]')).toEqual([
                tracks.tracks.list[1],
            ])
            expect(queryJsonPath(tracks, '$.tracks.list[?(@.size>10)]')).toEqual([
                tracks.tracks.list[0],
                tracks.tracks.list[2],
            ])
            expect(queryJsonPath(tracks, '$.tracks.list[?(@.size<=30)]')).toEqual([
                tracks.tracks.list[0],
                tracks.tracks.list[1],
            ])
        })

        it('字段不存在时不匹配（而不是报错）', () => {
            expect(queryJsonPath(tracks, '$.tracks.list[?(@.nope=="x")]')).toEqual([])
        })

        it('复合过滤器明确报错，不当成「没匹配到」', () => {
            // 当成没匹配到的后果是整条源「搜不到书」，且不报任何错，最难查
            expect(() => queryJsonPath(tracks, '$.tracks.list[?(@.type=="a"&&@.size>1)]')).toThrow(
                /复合过滤器/,
            )
            expect(() => queryJsonPath(tracks, '$.tracks.list[?(@.type=="a"||@.size>1)]')).toThrow(
                /复合过滤器/,
            )
        })

        it('比较运算用在非数值上要明确报错', () => {
            expect(() => queryJsonPath(tracks, '$.tracks.list[?(@.type>"a")]')).toThrow(/数值/)
        })
    })
})
