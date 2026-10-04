/*
 * 搜索结果按书合并的单元测试
 *
 * 与 replace.test.mjs / search.test.mjs 同样的理由用 `.mjs`：被测代码是浏览器侧的
 * `public/js/merge.js`（静态目录，不参与打包）。
 *
 * 合并这件事最怕的不是「没合并」，而是**合错了**：把两本不同的书并成一条，
 * 读者看到的是「一本书」，点进去却是另一本 —— 静默错数据，比多几条重复难查得多。
 * 所以下面的用例里有一条专门钉「同名不同作者不许合并」。
 */

import { describe, expect, it } from 'vitest'

import { mergeBooks, sourceBookKey } from '../public/js/merge.js'

const source = (id, name, books) => ({ sourceId: id, sourceName: name, books })

describe('mergeBooks：同一本书在多个源上', () => {
    it('书名与作者都相同 → 合成一条，并记住每个源各自的地址', () => {
        const merged = mergeBooks([
            source('a', '源甲', [{ name: '斗破苍穹', author: '天蚕土豆', bookUrl: '/a/1' }]),
            source('b', '源乙', [{ name: '斗破苍穹', author: '天蚕土豆', bookUrl: '/b/1' }]),
        ])
        expect(merged).toHaveLength(1)
        expect(merged[0].sources.map((s) => s.sourceId)).toEqual(['a', 'b'])
        expect(merged[0].sources.map((s) => s.book.bookUrl)).toEqual(['/a/1', '/b/1'])
    })

    it('书名里的空白与大小写不影响合并（写法很随意）', () => {
        const merged = mergeBooks([
            source('a', '源甲', [{ name: 'Coiling Dragon', author: 'IET' }]),
            source('b', '源乙', [{ name: 'coilingdragon', author: 'iet' }]),
        ])
        expect(merged).toHaveLength(1)
    })

    it('**同名不同作者不许合并**（两本书，合起来就是静默错数据）', () => {
        const merged = mergeBooks([
            source('a', '源甲', [{ name: '斗破苍穹', author: '天蚕土豆' }]),
            source('b', '源乙', [{ name: '斗破苍穹', author: '另一个人' }]),
        ])
        expect(merged).toHaveLength(2)
    })

    it('括号里的后缀不会被去掉，所以《X》与《X（续）》是两本', () => {
        const merged = mergeBooks([
            source('a', '源甲', [{ name: '斗破苍穹', author: '甲' }]),
            source('b', '源乙', [{ name: '斗破苍穹（续）', author: '甲' }]),
        ])
        expect(merged).toHaveLength(2)
    })

    it('一侧没写作者 → 并进同名条目，并把作者补上', () => {
        const merged = mergeBooks([
            source('a', '源甲', [{ name: '斗破苍穹', author: '' }]),
            source('b', '源乙', [{ name: '斗破苍穹', author: '天蚕土豆' }]),
        ])
        expect(merged).toHaveLength(1)
        expect(merged[0].author).toBe('天蚕土豆')
        expect(merged[0].sources).toHaveLength(2)
    })

    it('字段取第一个非空：合并之后比任何一个源都全', () => {
        const merged = mergeBooks([
            source('a', '源甲', [
                { name: '斗破', author: '甲', intro: '简介来自甲', coverUrl: '' },
            ]),
            source('b', '源乙', [
                { name: '斗破', author: '甲', intro: '', coverUrl: '/cover.jpg' },
            ]),
        ])
        expect(merged[0].intro).toBe('简介来自甲')
        expect(merged[0].coverUrl).toBe('/cover.jpg')
    })

    /**
     * 封面是**成对**的：`coverProxyUrl` 里的令牌指向 `coverUrl` 那个地址
     * （防盗链封面走 /api/media 代取，见 src/index.ts 的 withCoverProxy）。
     * 两个字段各自「取第一个非空」会拼出「A 源的图 + B 源的令牌」——
     * 令牌解出来的是另一本书的封面。
     */
    it('封面成对合并：地址来自源甲时，令牌不能跟着源乙走', () => {
        const merged = mergeBooks([
            source('a', '源甲', [{ name: '书', author: '人', coverUrl: 'https://a.com/c.jpg' }]),
            source('b', '源乙', [
                {
                    name: '书',
                    author: '人',
                    coverUrl: 'https://b.com/c.jpg',
                    coverProxyUrl: '/api/media/BBB',
                },
            ]),
        ])
        expect(merged[0].coverUrl).toBe('https://a.com/c.jpg')
        expect(merged[0].coverProxyUrl).toBe('')
    })

    it('地址为空时，同源的两个封面字段一起搬过来', () => {
        const merged = mergeBooks([
            source('a', '源甲', [{ name: '书', author: '人' }]),
            source('b', '源乙', [
                {
                    name: '书',
                    author: '人',
                    coverUrl: 'https://b.com/c.jpg',
                    coverProxyUrl: '/api/media/BBB',
                },
            ]),
        ])
        expect(merged[0].coverUrl).toBe('https://b.com/c.jpg')
        expect(merged[0].coverProxyUrl).toBe('/api/media/BBB')
    })
})

describe('mergeBooks：主源与排序', () => {
    it('默认取第一个源当主源', () => {
        const merged = mergeBooks([
            source('a', '源甲', [{ name: '书', author: '人' }]),
            source('b', '源乙', [{ name: '书', author: '人' }]),
        ])
        expect(merged[0].preferred.sourceId).toBe('a')
    })

    it('`prefer` 可以把「已在书架」的那一源选成主源', () => {
        const merged = mergeBooks(
            [
                source('a', '源甲', [{ name: '书', author: '人', bookUrl: '/a' }]),
                source('b', '源乙', [{ name: '书', author: '人', bookUrl: '/b' }]),
            ],
            { prefer: (sourceId) => sourceId === 'b' },
        )
        expect(merged[0].preferred.sourceId).toBe('b')
    })

    it('有这本书的源越多排越前（合并的价值就在这些条目上）', () => {
        const merged = mergeBooks([
            source('a', '源甲', [
                { name: '冷门书', author: '甲' },
                { name: '热书', author: '乙' },
            ]),
            source('b', '源乙', [{ name: '热书', author: '乙' }]),
        ])
        expect(merged.map((item) => item.name)).toEqual(['热书', '冷门书'])
    })
})

describe('mergeBooks：边界', () => {
    it('空输入、没有书的源、失败了的源都不产出条目', () => {
        expect(mergeBooks([])).toEqual([])
        expect(mergeBooks(null)).toEqual([])
        expect(mergeBooks([source('a', '源甲', [])])).toEqual([])
        expect(
            mergeBooks([
                {
                    sourceId: 'a',
                    sourceName: '源甲',
                    ok: false,
                    error: '超时',
                    books: [{ name: '书' }],
                },
            ]),
        ).toEqual([])
    })

    it('没有书名的条目被丢掉（拿不到书名就没法合并，也没法显示）', () => {
        const merged = mergeBooks([
            source('a', '源甲', [
                { name: '', author: '甲' },
                { name: '   ', author: '甲' },
                { name: '有名字', author: '甲' },
            ]),
        ])
        expect(merged).toHaveLength(1)
        expect(merged[0].name).toBe('有名字')
    })

    it('缺 author / coverUrl 等字段时是空串，不是 undefined（渲染时不必再判）', () => {
        const merged = mergeBooks([source('a', '源甲', [{ name: '只有书名' }])])
        expect(merged[0].author).toBe('')
        expect(merged[0].intro).toBe('')
        expect(merged[0].coverUrl).toBe('')
    })
})

describe('sourceBookKey', () => {
    it('书源与地址都要参与：不同源上的同一条地址是两条记录', () => {
        expect(sourceBookKey('a', '/x')).not.toBe(sourceBookKey('b', '/x'))
        expect(sourceBookKey('a', '/x')).toBe(sourceBookKey('a', '/x'))
    })
})
