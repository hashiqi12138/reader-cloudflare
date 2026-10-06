/*
 * 换源的两条判据（`public/js/switchSource.js`）
 *
 * 用 `.mjs` 的理由与 merge / replace / search / zoom 那一批相同：被测代码在 `public/` 下，
 * 不参与打包、也不进 tsconfig。
 *
 * 这里钉的都是**会静默出错**的地方：
 *
 *   - 候选里混进「当前这一源」→ 界面上会出现「换到这一源」，点了等于原地不动
 *   - 候选去重少做一层 → 同一个来源出现两行，用户以为有两个选择
 *   - 落点对不上却硬给一个下标 → 换完停在别的章节，而界面上说「成功」
 */

import { describe, expect, it } from 'vitest'

import { candidatesFor, matchChapter, progressPosition } from '../public/js/switchSource.js'

/** 一本书在某一源上的样子（只列切换用得到的字段） */
const book = (name, author, bookUrl, extra = {}) => ({
    name,
    author,
    bookUrl,
    ...extra,
})

const current = { sourceId: 'builtin:a', name: '斗破苍穹', author: '天蚕土豆' }

/** 一份「按源分组的搜索结果」，与 `/api/search` 的 `sources` 同形 */
const results = [
    {
        sourceId: 'builtin:b',
        sourceName: '乙站',
        ok: true,
        books: [book('斗破苍穹', '天蚕土豆', 'https://b/book/1', { lastChapter: '第 3 章' })],
    },
    {
        sourceId: 'builtin:a',
        sourceName: '甲站',
        ok: true,
        books: [book('斗破苍穹', '天蚕土豆', 'https://a/book/9')],
    },
    { sourceId: 'builtin:c', sourceName: '丙站', ok: false, error: '超时', books: [] },
]

describe('candidatesFor', () => {
    it('挑出同一本书，且**不含当前这一源**', () => {
        const out = candidatesFor(results, current)
        expect(out.map((one) => one.sourceId)).toEqual(['builtin:b'])
        expect(out[0].sourceName).toBe('乙站')
        expect(out[0].book.lastChapter).toBe('第 3 章')
    })

    it('搜索失败的那一源不进候选（它没给出任何书）', () => {
        const out = candidatesFor(
            [{ sourceId: 'x', ok: false, books: [book('斗破苍穹', '天蚕土豆', 'u')] }],
            current,
        )
        expect(out).toEqual([])
    })

    it('书名一样的别的书：作者不同就不算（见 merge.js 的 sameBook）', () => {
        const other = [
            {
                sourceId: 'y',
                sourceName: '丁',
                ok: true,
                books: [book('斗破苍穹', '另一个人', 'https://y/1')],
            },
        ]
        expect(candidatesFor(other, current)).toEqual([])
    })

    it('符号与空白不参与判断（`斗破 苍穹` 也算同一本）', () => {
        const other = [
            {
                sourceId: 'y',
                sourceName: '丁',
                ok: true,
                books: [book('斗破 苍穹', '天蚕土豆', 'https://y/1')],
            },
        ]
        expect(candidatesFor(other, current)).toHaveLength(1)
    })

    it('一侧没写作者也算同一本，但要标出「作者不同」供界面提示', () => {
        const silent = [
            {
                sourceId: 'y',
                sourceName: '丁',
                ok: true,
                books: [book('斗破苍穹', '', 'https://y/1')],
            },
        ]
        expect(candidatesFor(silent, current)[0].authorDiffers).toBe(false)

        const loud = [
            {
                sourceId: 'y',
                sourceName: '丁',
                ok: true,
                books: [book('斗破苍穹', '某某', 'https://y/1')],
            },
        ]
        expect(candidatesFor(loud, current)).toEqual([])
    })

    it('同一个来源重复给出同一本书只留一条', () => {
        const twice = [
            {
                sourceId: 'y',
                sourceName: '丁',
                ok: true,
                books: [
                    book('斗破苍穹', '天蚕土豆', 'https://y/1'),
                    book('斗破苍穹', '天蚕土豆', 'https://y/1'),
                ],
            },
        ]
        expect(candidatesFor(twice, current)).toHaveLength(1)
    })

    it('空输入不炸（没搜过就点换源）', () => {
        expect(candidatesFor([], current)).toEqual([])
        expect(candidatesFor(undefined, current)).toEqual([])
    })
})

describe('matchChapter：换过去落在哪一章', () => {
    const chapters = [
        { name: '第一章 陨落的天才', url: 'https://b/1' },
        { name: '第二章 斗之气', url: 'https://b/2' },
        { name: '第三章 客人', url: 'https://b/3' },
    ]

    it('按章名对上（空白差异不影响）', () => {
        expect(matchChapter(chapters, { name: '第二章斗之气', index: 0 })).toEqual({
            index: 1,
            how: 'name',
        })
        expect(matchChapter(chapters, { name: ' 第三章 客人 ', index: 2 })).toEqual({
            index: 2,
            how: 'name',
        })
    })

    it('章名对不上就退到同一下标，并如实说这是按序号落的', () => {
        expect(matchChapter(chapters, { name: '第二章 改名了', index: 1 })).toEqual({
            index: 1,
            how: 'index',
        })
    })

    it('下标越界、章名也对不上 → 没对上（界面据此说「从第一章开始」）', () => {
        expect(matchChapter(chapters, { name: '另一本书的章', index: 900 })).toEqual({
            index: -1,
            how: 'none',
        })
    })

    it('新目录是空的 → 没对上', () => {
        expect(matchChapter([], { name: '第二章 斗之气', index: 1 })).toEqual({
            index: -1,
            how: 'none',
        })
        expect(matchChapter(undefined, { name: '第二章 斗之气', index: 1 })).toEqual({
            index: -1,
            how: 'none',
        })
    })

    it('没给章名（只读过没记名字的老数据）时按序号', () => {
        expect(matchChapter(chapters, { name: '', index: 2 })).toEqual({ index: 2, how: 'index' })
    })
})

/*
 * 落点从哪来（`progressPosition`）
 *
 * 这个函数是补一个**静默事故**时抽出来的：详情页原先只从书架缓存里取落点，
 * 而那份缓存不跟着阅读进度刷新 —— 「刚读完第二章、回去换源」于是拿着
 * `chapterName: null` 去换源，换源照做，阅读位置却被降级成「从头开始」。
 * 抽成纯函数之后，这里把「什么算读过、什么算没读过」钉住。
 */
describe('progressPosition：书架行 / 进度行 → 落点', () => {
    it('读过的书架行（LEFT JOIN 出来的进度）→ 落点', () => {
        expect(progressPosition({ chapterName: '第二章 雨落下来', chapterIndex: 1 })).toEqual({
            name: '第二章 雨落下来',
            index: 1,
        })
    })

    it('`/api/progress` 的进度行同形，同样能吃', () => {
        expect(progressPosition({ chapterName: '第三章', chapterIndex: 2 })).toEqual({
            name: '第三章',
            index: 2,
        })
    })

    it('没读过（两个字段都是 null）→ null，界面据此说「从第一章开始」', () => {
        expect(progressPosition({ chapterName: null, chapterIndex: null })).toBeNull()
        // `/api/progress` 对没读过的书就是回 `progress: null`
        expect(progressPosition(null)).toBeNull()
        expect(progressPosition(undefined)).toBeNull()
    })

    it('只有一半的数据（老记录 / 只记了位置）也算读过，缺的那半给个安全值', () => {
        expect(progressPosition({ chapterName: '第九章', chapterIndex: null })).toEqual({
            name: '第九章',
            index: -1,
        })
        expect(progressPosition({ chapterName: null, chapterIndex: 4 })).toEqual({
            name: '',
            index: 4,
        })
    })
})
