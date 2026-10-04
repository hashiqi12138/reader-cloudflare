/**
 * Service Worker：**装到桌面 + 离线还能开**
 *
 * 这是给浏览器的那一半（另一半是 `manifest.json` 与 `index.html` 里的几个 link）。
 * 它只做两件事：把「应用外壳」和「读过的章节正文」留在本地，网络断的时候拿它们顶上。
 * 具体哪条请求进哪张表、什么响应才配存 —— 全在 `js/swPolicy.js` 里（那边能单测）。
 *
 * 注册在 `app.js`（`type: 'module'`）。**注册失败不影响任何功能**：在线时它可有可无。
 */

import {
    BOOK_CACHE,
    CACHE_LIMITS,
    CONTENT_CACHE,
    SHELL_CACHE,
    cacheNameFor,
    isStorable,
    keysToDrop,
    storageKey,
} from './js/swPolicy.js'

/** 这三张是我们自己的表，其余一律当垃圾清掉 */
const OURS = [SHELL_CACHE, BOOK_CACHE, CONTENT_CACHE]

/** 装上就接管，不等用户把所有标签页关掉 —— 版本切换由「网络优先」兜住，不会新旧混用 */
self.addEventListener('install', () => {
    self.skipWaiting()
})

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            // 清掉不认识的缓存（改过表名、或以后降级回来时的垃圾）
            const names = await caches.keys()
            await Promise.all(
                names.filter((name) => !OURS.includes(name)).map((name) => caches.delete(name)),
            )
            // 再清掉「键不是按现在的算法存的」那些条目：键的算法改过（外壳从带查询串的
            // 整条 URL 改成按路径、书从整条 URL 改成按 sourceId+url），旧键按新算法
            // 取不到了 —— 留着只是占表里的格子，还得等 FIFO 慢慢轮到才走
            for (const name of OURS) {
                const cache = await caches.open(name)
                for (const request of await cache.keys()) {
                    if (storageKey(request.url, name) !== request.url) await cache.delete(request)
                }
            }
            // 立刻接管已经开着的页面：不然第一次访问要再刷新一次才受保护
            await self.clients.claim()
        })(),
    )
})

self.addEventListener('fetch', (event) => {
    const cacheName = cacheNameFor(event.request, self.location.origin)
    if (cacheName === null) return // 不管这条，让它照常走网络
    event.respondWith(respond(event, cacheName))
})

/**
 * 网络优先：先要新的，拿到就顺手更新缓存；拿不到（离线 / 超时）再用缓存顶上
 *
 * 导航（`mode === 'navigate'`）离线时回落到缓存的 `/` —— 这个应用是 hash 路由，
 * 任何页面路径的入口都是同一个外壳。首页那条缓存是上一次访问时留下的。
 */
async function respond(event, cacheName) {
    const cache = await caches.open(cacheName)
    const key = storageKey(event.request.url, cacheName)
    try {
        const fresh = await fetch(event.request)
        if (isStorable(fresh)) {
            const copy = fresh.clone()
            // 用 waitUntil：响应先给页面，写缓存不必挡在路上
            event.waitUntil(store(cache, cacheName, key, copy))
        }
        await note(`net-ok  ${key}`)
        return fresh
    } catch (err) {
        const hit = await cache.match(key)
        await note(`${hit ? 'HIT    ' : 'MISS   '}${key}  err=${err?.name}`)
        if (hit) return hit
        if (event.request.mode === 'navigate') {
            const shell = await cache.match('/')
            if (shell) return shell
        }
        throw err
    }
}

/** TEMP 诊断：把日志写进一个调试缓存 */
async function note(text) {
    try {
        const c = await caches.open('reader-debug')
        await c.put(new Request('/note-' + Date.now() + '-' + Math.random()), new Response(text))
    } catch {
        /* 诊断本身不该影响任何事 */
    }
}

/** 写进缓存；表太长就删掉最早的几条 */
async function store(cache, cacheName, request, response) {
    try {
        await cache.put(request, response)
        const max = CACHE_LIMITS[cacheName]
        if (!Number.isFinite(max)) return
        const keys = await cache.keys()
        for (const key of keysToDrop(keys, max)) await cache.delete(key)
    } catch {
        // 存不下就算了：缓存是锦上添花，不能因为它影响这条请求本身
    }
}
