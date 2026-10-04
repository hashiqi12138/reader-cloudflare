/*
 * 媒体缓存判据的单元测试
 *
 * 这些判据每一条都对应一种「存了会出错」：把登录后才给看的图存进共享缓存会**串号**；
 * 把 Range 回来的一段存成整份会把播放切坏；把几十 MB 的音频存进去会吃光配额。
 * 判错不会有任何报错 —— 只会静默地发生上面那些事，所以逐条钉住。
 */

import { describe, expect, it } from 'vitest'

import {
    MEDIA_CACHE_MAX_BYTES,
    canCacheMediaRequest,
    canCacheMediaResponse,
    mediaCacheKey,
} from '../src/lib/mediaCache'

describe('媒体请求：能不能用共享缓存', () => {
    const clean = { loggedIn: false, fileSource: false, ranged: false }

    it('干干净净的一趟就缓存', () => {
        expect(canCacheMediaRequest(clean)).toBe(true)
    })

    it('书源带登录态就不缓存 —— 这张图可能只有登录后才给，存了会发给没登录的人', () => {
        expect(canCacheMediaRequest({ ...clean, loggedIn: true })).toBe(false)
    })

    it('文件源不缓存（响应头本来就是 private，而且是给人下载的）', () => {
        expect(canCacheMediaRequest({ ...clean, fileSource: true })).toBe(false)
    })

    it('带 Range 的请求不缓存 —— 回来的是一段，不是整份', () => {
        expect(canCacheMediaRequest({ ...clean, ranged: true })).toBe(false)
    })
})

describe('媒体响应：配不配存', () => {
    const ok = { status: 200, contentType: 'image/png', contentLength: '4096' }

    it('200 的小图片就存', () => {
        expect(canCacheMediaResponse(ok)).toBe(true)
    })

    it('非 200 不存（206 是部分内容，存下来就是半张图）', () => {
        expect(canCacheMediaResponse({ ...ok, status: 206 })).toBe(false)
        expect(canCacheMediaResponse({ ...ok, status: 502 })).toBe(false)
    })

    it('不是图片就不存 —— 音频动辄几十 MB，收益低还占配额', () => {
        expect(canCacheMediaResponse({ ...ok, contentType: 'audio/mpeg' })).toBe(false)
        expect(canCacheMediaResponse({ ...ok, contentType: null })).toBe(false)
    })

    it('大小写与参数不影响判断（`Image/PNG; charset=binary` 也是图片）', () => {
        expect(canCacheMediaResponse({ ...ok, contentType: 'Image/PNG; charset=binary' })).toBe(
            true,
        )
    })

    it('体积未知就不存 —— Cache API 要把响应体收完才写得进去，不拿内存去赌', () => {
        expect(canCacheMediaResponse({ ...ok, contentLength: null })).toBe(false)
        expect(canCacheMediaResponse({ ...ok, contentLength: 'abc' })).toBe(false)
        expect(canCacheMediaResponse({ ...ok, contentLength: '0' })).toBe(false)
    })

    it('超过上限就不存', () => {
        expect(canCacheMediaResponse({ ...ok, contentLength: String(MEDIA_CACHE_MAX_BYTES) })).toBe(
            true,
        )
        expect(
            canCacheMediaResponse({ ...ok, contentLength: String(MEDIA_CACHE_MAX_BYTES + 1) }),
        ).toBe(false)
    })
})

describe('缓存键', () => {
    const payload = { sourceId: 'user:https://a.test', url: 'https://cdn.test/1.png' }

    it('同一份媒体算出来同一个键 —— 这是「同一张图不同令牌也能命中」的前提', async () => {
        const first = await mediaCacheKey('https://reader.test/api/media/tok1', payload)
        const second = await mediaCacheKey('https://reader.test/api/media/tok2', payload)

        expect(first.url).toBe(second.url)
    })

    it('键是同源的，且把上游地址隐掉了（只有哈希，看不出原地址）', async () => {
        const key = await mediaCacheKey('https://reader.test/api/media/tok1', payload)

        expect(new URL(key.url).origin).toBe('https://reader.test')
        expect(key.url).not.toContain('cdn.test')
        expect(key.url).not.toContain('1.png')
    })

    it('书源、地址、封面标记任一不同就是不同的键', async () => {
        const base = await mediaCacheKey('https://reader.test/x', payload)
        const otherSource = await mediaCacheKey('https://reader.test/x', {
            ...payload,
            sourceId: 'user:https://b.test',
        })
        const otherUrl = await mediaCacheKey('https://reader.test/x', {
            ...payload,
            url: 'https://cdn.test/2.png',
        })
        const asCover = await mediaCacheKey('https://reader.test/x', { ...payload, cover: true })

        const all = new Set([base.url, otherSource.url, otherUrl.url, asCover.url])
        expect(all.size).toBe(4)
    })

    it('两段的边界不会撞键（`a` + `bc` 与 `ab` + `c` 要算成不同）', async () => {
        const one = await mediaCacheKey('https://reader.test/x', {
            sourceId: 'user:a',
            url: 'bc',
        })
        const two = await mediaCacheKey('https://reader.test/x', {
            sourceId: 'user:ab',
            url: 'c',
        })

        expect(one.url).not.toBe(two.url)
    })
})
