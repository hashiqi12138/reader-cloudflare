/*
 * Service Worker 路由规则的单元测试
 *
 * 事件接线在 `public/sw.js` 里（Node 跑不了 `self`），这里钉的是**判据**：
 * 哪条请求进哪张表、什么样的响应才配存、表太长了先删哪些。
 * 这三条错一条，表现都是「离线打不开」或「看到不该有的旧数据」，而且都不报错。
 *
 * 用 `.mjs` 的理由与 replace / search / merge / zoom / pagination 相同：
 * 被测代码在 `public/` 下，不参与打包、也不进 tsconfig。
 */

import { describe, expect, it } from 'vitest'

import {
    BOOK_CACHE,
    CACHE_LIMITS,
    CONTENT_CACHE,
    SHELL_CACHE,
    cacheNameFor,
    isStorable,
    keysToDrop,
    storageKey,
} from '../public/js/swPolicy.js'

const ORIGIN = 'https://reader.example.com'

/** 造一个「像 Request 的东西」：策略只读 method 与 url */
const req = (path, { method = 'GET', origin = ORIGIN } = {}) => ({
    method,
    url: new URL(path, origin).href,
})

const nameOf = (path, options) => cacheNameFor(req(path, options), ORIGIN)

describe('cacheNameFor：哪条请求进哪张表', () => {
    it('外壳：入口、样式、脚本、图标都进外壳表', () => {
        for (const path of [
            '/',
            '/app.js',
            '/style.css',
            '/manifest.json',
            '/icon-192.png',
            '/icon-512.png',
            '/icon-maskable-512.png',
            '/apple-touch-icon.png',
        ]) {
            expect(nameOf(path), path).toBe(SHELL_CACHE)
        }
    })

    it('`/js/**` 一律当外壳（加一个 js 文件时不必回来改白名单）', () => {
        expect(nameOf('/js/reader.js')).toBe(SHELL_CACHE)
        expect(nameOf('/js/swPolicy.js')).toBe(SHELL_CACHE)
        expect(nameOf('/js/新加的.js')).toBe(SHELL_CACHE)
    })

    it('详情与目录进书籍表、正文进正文表 —— 三条缺一条离线就读不成', () => {
        // 「打开一本书」是 book → toc → content 三步；只缓存正文的话，
        // 离线打开阅读链接会卡在目录那一步（实测踩过）
        expect(nameOf('/api/book?sourceId=x&url=y')).toBe(BOOK_CACHE)
        expect(nameOf('/api/toc?sourceId=x&url=y&book=%7B%7D')).toBe(BOOK_CACHE)
        expect(nameOf('/api/content?sourceId=x&url=y&chapter=1')).toBe(CONTENT_CACHE)
    })

    it('用户数据、会话、发现、媒体**一律不管**', () => {
        for (const path of [
            '/api/shelf',
            '/api/progress',
            '/api/bookmarks',
            '/api/notes',
            '/api/sources',
            '/api/replace',
            '/api/auth/me',
            '/api/auth/logout',
            '/api/search',
            '/api/home',
            '/api/explore',
            '/api/explore/books',
            '/api/media/abc.png',
            '/api/backup',
            '/api/export/bookmarks',
            '/api/probe',
            '/api/health',
        ]) {
            expect(nameOf(path), path).toBe(null)
        }
    })

    it('非 GET 一律不管（后端要写东西，缓存拦下来就是错的）', () => {
        expect(nameOf('/api/progress', { method: 'PUT' })).toBe(null)
        expect(nameOf('/api/search', { method: 'POST' })).toBe(null)
        expect(nameOf('/', { method: 'POST' })).toBe(null)
    })

    it('跨域与内置测试站点不管', () => {
        expect(cacheNameFor(req('/js/a.js', { origin: 'https://cdn.other.com' }), ORIGIN)).toBe(
            null,
        )
        expect(nameOf('/fixture/search?q=x')).toBe(null)
        expect(nameOf('/fixture/book/1')).toBe(null)
    })

    it('拿不到东西时回 null，而不是抛', () => {
        expect(cacheNameFor(null, ORIGIN)).toBe(null)
        expect(cacheNameFor({ method: 'GET', url: '不是地址' }, ORIGIN)).toBe(null)
    })
})

describe('isStorable：什么样的响应才配存', () => {
    const fake = (status, { type = 'basic' } = {}) => ({
        ok: status >= 200 && status < 300,
        status,
        type,
    })

    it('同源 200 才存', () => {
        expect(isStorable(fake(200))).toBe(true)
    })

    it('404 / 500 / 302 都不存（存下来会把「一次失败」变成长久的失败）', () => {
        expect(isStorable(fake(404))).toBe(false)
        expect(isStorable(fake(500))).toBe(false)
        expect(isStorable(fake(302))).toBe(false)
    })

    it('opaque（跨域）不存：状态读不到，判不了对错', () => {
        expect(isStorable(fake(200, { type: 'opaque' }))).toBe(false)
    })

    it('**不看 cache-control** —— 本地 wrangler dev 发的外壳带 no-store，照它办就全存不下', () => {
        // 这条是刻意钉住的判据（见 swPolicy.isStorable 的说明）：判断只看「同源 200」，
        // 用户数据那条边界在 cacheNameFor 里挡着
        const withHeaders = {
            ok: true,
            status: 200,
            type: 'basic',
            headers: { get: () => 'no-cache, no-store' },
        }
        expect(isStorable(withHeaders)).toBe(true)
    })

    it('空响应不崩', () => {
        expect(isStorable(null)).toBe(false)
        expect(isStorable(undefined)).toBe(false)
    })
})

describe('keysToDrop：表太长了先删哪些', () => {
    it('没超就一个不删', () => {
        expect(keysToDrop(['a', 'b'], 5)).toEqual([])
        expect(keysToDrop(['a', 'b'], 2)).toEqual([])
    })

    it('超了就从**最早写入**的开始删（keys() 是按写入先后返回的）', () => {
        expect(keysToDrop(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b'])
    })

    it('默认不封顶（外壳那张表就该一个不删）', () => {
        const keys = Array.from({ length: 500 }, (_, i) => `k${i}`)
        expect(keysToDrop(keys)).toEqual([])
    })

    it('空表不崩', () => {
        expect(keysToDrop([], 10)).toEqual([])
        expect(keysToDrop(undefined, 10)).toEqual([])
    })
})

describe('CACHE_LIMITS：每张表的上限', () => {
    it('外壳不封顶（一组固定文件，数量不涨）', () => {
        expect(CACHE_LIMITS[SHELL_CACHE]).toBe(Infinity)
    })

    it('书籍表与正文表都有上限 —— 不封顶会吃光配额，届时连外壳都写不进去', () => {
        expect(Number.isFinite(CACHE_LIMITS[BOOK_CACHE])).toBe(true)
        expect(Number.isFinite(CACHE_LIMITS[CONTENT_CACHE])).toBe(true)
    })

    it('正文表比书籍表宽（一条一章，涨得快）', () => {
        expect(CACHE_LIMITS[CONTENT_CACHE]).toBeGreaterThan(CACHE_LIMITS[BOOK_CACHE])
    })
})

describe('storageKey：存/取时用的键', () => {
    it('外壳按**路径**存 —— 导航请求带查询串，照原样存就找不到自己', () => {
        // 踩过：离线导航直接 ERR_CONNECTION_REFUSED，因为缓存里的键是 `/?r=2`，
        // 而回落查的是 `/`
        expect(storageKey('https://a.test/?r=2', SHELL_CACHE)).toBe('https://a.test/')
        expect(storageKey('https://a.test/js/reader.js?v=3', SHELL_CACHE)).toBe(
            'https://a.test/js/reader.js',
        )
    })

    it('书按**身份**（sourceId + url）存，`book` / `chapter` 那两段上下文不进键', () => {
        const key = storageKey(
            'https://a.test/api/content?sourceId=x&url=y&book=%7B%22author%22%3A%22%E7%94%B2%22%7D&chapter=%7B%22index%22%3A0%7D',
            CONTENT_CACHE,
        )
        expect(key).toBe('https://a.test/api/content?sourceId=x&url=y')
    })

    it('同一章从不同入口进（带不带 author hint）算同一个键 —— 不然缓存里有也查不中', () => {
        // 实测踩过：那个源的 /api/book 不返回作者，于是 book.author 退回地址栏的 hint，
        // 同一章从详情页进与从搜索页进拼出的 URL 不同，离线时表现为「正文取不到」
        const withHint = storageKey(
            'https://a.test/api/content?sourceId=x&url=y&book=%7B%22name%22%3A%22n%22%2C%22author%22%3A%22a%22%7D',
            CONTENT_CACHE,
        )
        const noHint = storageKey(
            'https://a.test/api/content?sourceId=x&url=y&book=%7B%22name%22%3A%22n%22%7D',
            CONTENT_CACHE,
        )
        expect(withHint).toBe(noHint)
    })

    it('不同的章、不同的源仍然是不同的键', () => {
        const ch1 = storageKey('https://a.test/api/content?sourceId=x&url=1', CONTENT_CACHE)
        const ch2 = storageKey('https://a.test/api/content?sourceId=x&url=2', CONTENT_CACHE)
        const other = storageKey('https://a.test/api/content?sourceId=z&url=1', CONTENT_CACHE)
        expect(ch1).not.toBe(ch2)
        expect(ch1).not.toBe(other)
    })

    it('详情与目录也按身份存（同一本书的 book / toc 两条互不覆盖）', () => {
        expect(storageKey('https://a.test/api/book?sourceId=x&url=y&book=%7B%7D', BOOK_CACHE)).toBe(
            'https://a.test/api/book?sourceId=x&url=y',
        )
        expect(storageKey('https://a.test/api/toc?sourceId=x&url=y&book=%7B%7D', BOOK_CACHE)).toBe(
            'https://a.test/api/toc?sourceId=x&url=y',
        )
    })
})
