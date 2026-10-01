import { describe, expect, it } from 'vitest'
import { categoryFromLine, parseExploreCategories } from '../src/legado/exploreParse'

/**
 * 发现页的分类解析
 *
 * exploreUrl 有三种写法，线上三种都存在；解析错的后果不是报错，而是
 * **发现页整块空着**（分类标题/地址错位，点进去什么也没有）。
 * 所以这里把三种写法、嵌套、去重、注释逐条钉住。
 */
const source = { bookSourceName: '示例书源', bookSourceUrl: 'https://example.com' }

describe('categoryFromLine', () => {
    it('`标题::地址` 取前两段，第三段起（布局提示）忽略', () => {
        expect(categoryFromLine('玄幻::/list/1::4', source.bookSourceName)).toEqual({
            title: '玄幻',
            url: '/list/1',
        })
    })

    it('标题为空时用书源名兜底', () => {
        expect(categoryFromLine('::/list/1', source.bookSourceName)?.title).toBe('示例书源')
    })

    it('整行就是一个地址时，标题用书源名', () => {
        expect(categoryFromLine('https://example.com/hot', source.bookSourceName)).toEqual({
            title: '示例书源',
            url: 'https://example.com/hot',
        })
        expect(categoryFromLine('/hot', source.bookSourceName)?.title).toBe('示例书源')
    })

    it('地址为空的行丢掉（`标题::` 是写坏的行，不是分类）', () => {
        expect(categoryFromLine('玄幻::', source.bookSourceName)).toBeNull()
    })

    it('空行与 `#` 注释丢掉', () => {
        expect(categoryFromLine('   ', source.bookSourceName)).toBeNull()
        expect(categoryFromLine('# 这一行是注释', source.bookSourceName)).toBeNull()
    })
})

describe('parseExploreCategories', () => {
    it('文本形态：每行一个分类', () => {
        const raw = '玄幻::/list/1\n都市::/list/2\n\n#注释\n女频::/list/3'
        expect(parseExploreCategories(raw, source)).toEqual([
            { title: '玄幻', url: '/list/1' },
            { title: '都市', url: '/list/2' },
            { title: '女频', url: '/list/3' },
        ])
    })

    it('脚本形态：对象数组（title/url）', () => {
        const raw = [
            { title: '热门推荐', url: '/explore/hot?p={{page}}' },
            { name: '最新上架', url: '/explore/new' },
        ]
        expect(parseExploreCategories(raw, source)).toEqual([
            { title: '热门推荐', url: '/explore/hot?p={{page}}' },
            { title: '最新上架', url: '/explore/new' },
        ])
    })

    it('脚本形态：字符串数组（每项是一行）', () => {
        expect(parseExploreCategories(['玄幻::/1', '都市::/2'], source)).toHaveLength(2)
    })

    it('包一层的结果（{list:[…]} / {data:[…]}）也能解析', () => {
        expect(parseExploreCategories({ list: [{ title: 'a', url: '/a' }] }, source)).toEqual([
            { title: 'a', url: '/a' },
        ])
        expect(parseExploreCategories({ data: [{ title: 'b', url: '/b' }] }, source)).toEqual([
            { title: 'b', url: '/b' },
        ])
    })

    it('嵌套分类拍平成 `父 · 子`', () => {
        const raw = [
            {
                title: '男频',
                url: [
                    { title: '玄幻', url: '/m/x' },
                    { title: '都市', url: '/m/d' },
                ],
            },
            { title: '女频', url: [{ title: '言情', url: '/f/y' }] },
        ]
        expect(parseExploreCategories(raw, source)).toEqual([
            { title: '男频 · 玄幻', url: '/m/x' },
            { title: '男频 · 都市', url: '/m/d' },
            { title: '女频 · 言情', url: '/f/y' },
        ])
    })

    it('没有地址的条目丢掉，而不是变成点不动的空分类', () => {
        const raw = [
            { title: '空壳' },
            { title: '好的', url: '/ok' },
            { title: '空地址', url: '  ' },
        ]
        expect(parseExploreCategories(raw, source)).toEqual([{ title: '好的', url: '/ok' }])
    })

    it('去重时按「标题 + 地址」而不是只按标题', () => {
        const raw = '玄幻::/a\n玄幻::/a\n玄幻::/b'
        expect(parseExploreCategories(raw, source)).toEqual([
            { title: '玄幻', url: '/a' },
            { title: '玄幻', url: '/b' },
        ])
    })

    it('无法识别的输入回空数组，而不是抛错', () => {
        expect(parseExploreCategories(null, source)).toEqual([])
        expect(parseExploreCategories(42, source)).toEqual([])
        expect(parseExploreCategories({ nope: 1 }, source)).toEqual([])
    })

    it('分类数量有上限（挡住把界面撑爆的书源）', () => {
        const many = Array.from({ length: 500 }, (_, i) => ({ title: `c${i}`, url: `/c/${i}` }))
        expect(parseExploreCategories(many, source).length).toBeLessThanOrEqual(120)
    })
})
