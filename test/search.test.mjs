/*
 * 章内搜索的单元测试
 *
 * 与 replace.test.mjs 同样的理由用 `.mjs`：被测代码是浏览器侧的
 * `public/js/search.js`（静态目录，不参与打包），而 tsconfig 只收 `src` 与 `test`
 * 下的 `.ts`。
 *
 * 这些函数看着简单，但边界不少：大小写、重叠、正则元字符、空关键词。
 * 每一条都对应一个真实的错法 —— 比如把关键词当正则编译，搜 `(` 就会抛异常。
 */

import { describe, expect, it } from 'vitest'

import { excerptAround, normalizeQuery, splitByQuery } from '../public/js/search.js'

describe('normalizeQuery', () => {
    it('去掉首尾空白', () => {
        expect(normalizeQuery('  斗破  ')).toBe('斗破')
    })

    it('空值与纯空白归一成空串（空串的含义是「不搜」，不是「匹配一切」）', () => {
        expect(normalizeQuery('')).toBe('')
        expect(normalizeQuery('   ')).toBe('')
        expect(normalizeQuery(null)).toBe('')
        expect(normalizeQuery(undefined)).toBe('')
        expect(normalizeQuery(123)).toBe('123')
    })
})

describe('splitByQuery', () => {
    it('空关键词原样返回一段', () => {
        expect(splitByQuery('一段文字', '')).toEqual([{ text: '一段文字', hit: false }])
    })

    it('切出命中与未命中，顺序拼回去等于原文', () => {
        const parts = splitByQuery('我觉得斗破写得不错，斗破是他的起点', '斗破')
        expect(parts.map((p) => p.text).join('')).toBe('我觉得斗破写得不错，斗破是他的起点')
        expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['斗破', '斗破'])
    })

    it('命中段保留原文的大小写，而不是关键词的大小写', () => {
        const parts = splitByQuery('Hello World', 'hello')
        expect(parts.find((p) => p.hit)?.text).toBe('Hello')
    })

    it('英文大小写不敏感', () => {
        expect(splitByQuery('Hello', 'HELLO').filter((p) => p.hit)).toHaveLength(1)
    })

    it('重叠时不重复计数：aaa 里搜 aa 只算一处（步进用关键词长度）', () => {
        const parts = splitByQuery('aaa', 'aa')
        expect(parts.filter((p) => p.hit)).toHaveLength(1)
    })

    it('正则元字符按纯文本处理，不抛错也不误匹配', () => {
        // `.` 当正则会匹配任意一个字符，那这句里的每个字都会亮起来
        const parts = splitByQuery('版本 1.2 发布', '.')
        expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['.'])
        // `(` 当正则会直接抛异常，把整个阅读界面带崩
        expect(() => splitByQuery('第(一)章', '(')).not.toThrow()
        expect(splitByQuery('第(一)章', '(').filter((p) => p.hit)).toHaveLength(1)
    })

    it('命中在开头与结尾时不产生空段', () => {
        const parts = splitByQuery('斗破苍穹斗破', '斗破')
        expect(parts.some((p) => p.text === '')).toBe(false)
        expect(parts[0]).toEqual({ text: '斗破', hit: true })
        expect(parts[parts.length - 1]).toEqual({ text: '斗破', hit: true })
    })

    it('没有命中时只有一段、且标 false', () => {
        expect(splitByQuery('一段文字', '找不到')).toEqual([{ text: '一段文字', hit: false }])
    })

    it('空关键词一处都不算命中（空关键词的含义是「不搜」）', () => {
        expect(splitByQuery('任意文字', '').filter((p) => p.hit)).toHaveLength(0)
        expect(splitByQuery('任意文字', '  ').filter((p) => p.hit)).toHaveLength(0)
    })

    it('同一行里多处命中会被逐段切出来（阅读界面按这个顺序编号）', () => {
        const parts = splitByQuery('斗破苍穹，斗破斗破', '斗破')
        expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['斗破', '斗破', '斗破'])
    })
})

describe('excerptAround', () => {
    it('以命中处为中心截一段，两端加省略号', () => {
        const text = `${'前'.repeat(60)}斗破${'后'.repeat(60)}`
        const excerpt = excerptAround(text, '斗破', 10)
        expect(excerpt.startsWith('…')).toBe(true)
        expect(excerpt.endsWith('…')).toBe(true)
        expect(excerpt).toContain('斗破')
    })

    it('命中在开头时不加前置省略号', () => {
        const excerpt = excerptAround(`斗破${'后'.repeat(60)}`, '斗破', 10)
        expect(excerpt.startsWith('…')).toBe(false)
        expect(excerpt.startsWith('斗破')).toBe(true)
    })

    it('把换行折成空格：摘录要在一行里显示', () => {
        expect(excerptAround('上\n下', '下', 10)).toBe('上 下')
    })

    it('没命中时退回开头一段（截到 radius*2 字），不返回空串', () => {
        expect(excerptAround('一段很长的文字', '找不到', 100)).toBe('一段很长的文字')
        // radius=3 → 只取前 6 个字，这样列表里每一行的高度是可预期的
        expect(excerptAround('一段很长的文字', '找不到', 3)).toBe('一段很长的文')
    })
})
