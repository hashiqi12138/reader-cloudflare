/**
 * ETag 比对的单元测试
 *
 * 这里钉住的是 `/api/sources` 的 304 判定。判错**不会报错** —— 只会让浏览器
 * 拿着过期的书源列表，或者白白少发一次请求，两种都是「看不出来」的故障，
 * 所以边界要逐个写下来。
 */

import { describe, expect, it } from 'vitest'

import { matchesEtag } from '../src/lib/etag'

const TAG = '"src-7-f"'

describe('If-None-Match 比对', () => {
    it('没有这个头就当作没命中', () => {
        expect(matchesEtag(undefined, TAG)).toBe(false)
        expect(matchesEtag('', TAG)).toBe(false)
    })

    it('原样带回我们发出去的标签算命中', () => {
        expect(matchesEtag(TAG, TAG)).toBe(true)
    })

    it('版本号变了就不命中 —— 这正是导入书源之后要发生的事', () => {
        expect(matchesEtag('"src-6-f"', TAG)).toBe(false)
    })

    it('弱校验前缀 W/ 也认得出是同一个标签', () => {
        expect(matchesEtag(`W/${TAG}`, TAG)).toBe(true)
    })

    it('逗号分隔的一串里只要有一个命中就算命中', () => {
        expect(matchesEtag('"src-1-n", "src-7-f"', TAG)).toBe(true)
        expect(matchesEtag('"src-1-n","src-2-f"', TAG)).toBe(false)
    })

    it('* 表示「资源还在就算命中」', () => {
        expect(matchesEtag('*', TAG)).toBe(true)
        expect(matchesEtag('"src-1-n", *', TAG)).toBe(true)
    })

    it('前后空白不影响判定', () => {
        expect(matchesEtag(`  ${TAG}  `, TAG)).toBe(true)
    })

    it('标签本体大小写敏感 —— 它按不透明字节比', () => {
        expect(matchesEtag('"SRC-7-F"', TAG)).toBe(false)
    })
})
