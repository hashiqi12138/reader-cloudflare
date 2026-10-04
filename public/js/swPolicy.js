/**
 * Service Worker 的**路由规则**
 *
 * 单独一个模块是为了能测：`sw.js` 里除了事件接线就是「网络优先 + 缓存兜底」那一小段，
 * 而「哪条请求进哪张表、什么样的响应才配存下来、表太长了先删哪些」全是纯函数 ——
 * 前端那套 `.mjs` 测试正好只测这一半（见 `test/swPolicy.test.mjs`）。
 *
 * 缓存的东西只有两样，一句话说得清：**界面**，和**正在读的那本书**。
 *
 *   - **外壳**（`/`、`/app.js`、`/style.css`、`/js/**`、图标）：网络优先 + 缓存兜底。
 *     为什么不缓存优先：这些文件名**不带指纹**（没有 hash），缓存优先会让「线上已经
 *     发新版、用户还在跑旧版」一直持续到缓存被清 —— 而外壳文件是**成套**的，
 *     一半新一半旧（新 app.js 配旧 reader.js）比慢一点糟得多。边缘本来就快，
 *     网络优先只多一个 RTT。
 *   - **书**（`/api/book` + `/api/toc` + `/api/content`）：同样网络优先，但缓存**有**用。
 *     这三条是「打开一本书、读下去」的整条链，缺一条离线就读不成：
 *     只缓存正文的话，离线打开阅读链接会卡在目录那一步（实测就是这个现象 ——
 *     外壳从缓存起来了，正文却报「连不上服务」）。
 *   - **其余一律放过去**：书架 / 进度 / 收藏 / 笔记 / 书源是**用户数据**，
 *     会话（`/api/auth/*`）必须是活的；发现与搜索是「找新书」，离线本来也读不了；
 *     媒体可能是流（带 Range），缓存会出事；导出与备份是下载；跨域的不碰。
 */

export const SHELL_CACHE = 'reader-shell-v1'
/** `/api/book` + `/api/toc`：一本书的两条元数据，成对写入、成对淘汰 */
export const BOOK_CACHE = 'reader-book-v1'
export const CONTENT_CACHE = 'reader-content-v1'

/**
 * 应用外壳里要管的那几个文件
 *
 * 加上 `/js/` 前缀匹配（`js/*.js` 都是外壳的一部分，加文件时不必回来改这里）。
 * 这里的 `/` 就是 `index.html` —— hash 路由的入口，离线时任何页面路径都回落到它。
 */
export const SHELL_PATHS = new Set([
    '/',
    '/app.js',
    '/style.css',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-maskable-512.png',
    '/apple-touch-icon.png',
])

/**
 * 每张表最多留几条，超了从**最早写入**的开始删
 *
 * 外壳是一组固定的文件，数量不涨，不必淘汰。另外两张得设上限：
 * 浏览器给一个源的存储有配额，而正文是**按章**涨的 —— 不封顶的话，
 * 长期使用会把配额吃光，届时**连外壳都写不进去**，离线支持整体失效。
 *
 * 为什么两张表要分开数：正文一条一章，一本书几百章很常见；若和书目录共用一张表，
 * 读完一本书就会把「这本书的详情与目录」挤掉 —— 而它们恰恰是离线**打开**这本书的前提。
 */
export const CACHE_LIMITS = {
    [SHELL_CACHE]: Infinity,
    [BOOK_CACHE]: 120,
    [CONTENT_CACHE]: 300,
}

/**
 * 这条请求该交给哪张表（返回缓存名），或者干脆别管（返回 `null`）
 *
 * `origin` 显式传进来而不是读 `self.location`：这样单测里能直接喂参数。
 */
export function cacheNameFor(request, origin) {
    if (!request || request.method !== 'GET') return null
    let url
    try {
        url = new URL(request.url)
    } catch {
        return null
    }
    if (url.origin !== origin) return null
    const path = url.pathname
    if (path === '/api/content') return CONTENT_CACHE
    if (path === '/api/book' || path === '/api/toc') return BOOK_CACHE
    // 其余接口与内置测试站点原样放过去（理由见文件头）
    if (path.startsWith('/api/') || path.startsWith('/fixture/')) return null
    if (SHELL_PATHS.has(path) || path.startsWith('/js/')) return SHELL_CACHE
    return null
}

/**
 * 这个响应值不值得存
 *
 * 只存**同源、200**的：`type !== 'basic'` 的是 opaque（跨域，读不到状态，存了也判不了对错），
 * 3xx/4xx/5xx 存下来会把「一次失败」变成长久的失败。
 *
 * **不看 `cache-control`**，这条是量出来的：本地 `wrangler dev` 发出来的静态资源带
 * `no-cache, no-store`（浏览器开了「禁用缓存」时更明显），照字面尊重它的话，
 * 外壳一条都存不进去 —— 离线支持**静默失效**，而这正是这个模块存在的理由。
 * 判据想清楚了：`cache-control` 是给**中间缓存**（代理、浏览器 HTTP 缓存）看的指令，
 * 而 Service Worker 这一层是**作者自己管**的另一套存储，装的全是我们自己的东西
 * （外壳 + 公开的书籍数据，见 `cacheNameFor`）—— 用户数据那条边界在那里挡着，
 * 不靠这个头。线上实测发的是 `public, max-age=0, must-revalidate`。
 */
export function isStorable(response) {
    if (!response) return false
    return Boolean(response.ok) && response.status === 200 && response.type === 'basic'
}

/** 表太长时该删哪几条：`keys` 是 `cache.keys()` 的顺序（按写入先后） */
export function keysToDrop(keys, max = Infinity) {
    const extra = (keys?.length ?? 0) - max
    return extra > 0 ? keys.slice(0, extra) : []
}

/**
 * 存/取时用的键
 *
 * **外壳按路径存**：导航请求带着各种查询串（`?t=` 之类），照原样存就会一条路径占好几格，
 * 而且离线时「按 `/` 找外壳」那一步会找不到自己（踩过：离线导航直接
 * `ERR_CONNECTION_REFUSED`，因为缓存里的键是 `/?r=2`，而回落查的是 `/`）。
 *
 * **书按「书的身份」存，而不是整条 URL**：`/api/book`、`/api/toc`、`/api/content` 的
 * 查询串里除了 `sourceId` 与 `url`（这两个才是「哪本书、哪一章」），还夹着 `book` /
 * `chapter` 两个 JSON —— 它们是给规则求值用的**上下文**，由客户端现算。
 * 而它们并不稳定：`/api/book` 有的源不返回作者（实测那个源 `author` 是空串），
 * 于是 `book.author` 退回到**地址栏 hash 里的 hint**；同一章从详情页进（带 author）
 * 和从搜索页进（不带）拼出来的 URL 就不一样 —— 缓存里明明有这一章，却查不中。
 *
 * 所以键只留 `sourceId` 与 `url`：**一章的身份就是「哪个源、哪个地址」**，
 * 上下文差几个字不该算成另一章。代价是离线时可能用「当初那份上下文」取回的正文
 * 顶上 —— 但那时本来也发不出请求，有比没有强，而且只在离线（网络优先）时才走到这里。
 */
export function storageKey(url, cacheName) {
    if (cacheName !== SHELL_CACHE && cacheName !== BOOK_CACHE && cacheName !== CONTENT_CACHE) {
        return url
    }
    const parsed = new URL(url)
    if (cacheName === SHELL_CACHE) {
        parsed.search = ''
        return parsed.href
    }
    const keep = new URLSearchParams()
    for (const key of ['sourceId', 'url']) {
        const value = parsed.searchParams.get(key)
        if (value !== null) keep.set(key, value)
    }
    parsed.search = keep.toString()
    return parsed.href
}
