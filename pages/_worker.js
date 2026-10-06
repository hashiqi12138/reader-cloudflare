/*
 * Cloudflare Pages 高级模式的 Worker —— 「页面」和「接口」分开部署时，这一层把接口接回来
 *
 * 为什么需要它（这几条决定了架构，不是随手加的转发）
 * --------------------------------------------------
 * 页面部署到 Pages 之后，浏览器看到的源是 `<项目>.pages.dev`，而接口在另一个源上
 * （Worker 的 `*.workers.dev`）。而前端里：
 *
 *   - 所有请求都是**相对地址**（`/api/...`）；
 *   - 会话是 **HttpOnly + SameSite=Lax** 的 cookie；
 *   - 封面 / 音频用的是 `/api/media/<签名>` 这种相对地址（服务端下发的）。
 *
 * 直接跨源调接口的话这三样全得动：CORS、`SameSite=None`（等于把会话降级成
 * 第三方 cookie，浏览器正在淘汰它）、以及把每一条媒体地址都拼成绝对地址。
 * 所以这里选「**同源反代**」：页面里的路径一个字都不用改，cookie 仍是第一方。
 *
 * 转发是整份转发：方法 / 请求头 / 请求体原样交给接口那一份；回来时状态码与
 * **全部响应头**原样交回 —— `Set-Cookie` 必须逐字过，会话就是它。
 * 任何「挑几个头拼一拼」的写法都会在某个不起眼的地方丢东西。
 *
 * 配套的 `_routes.json` 只有 `/api/*` 与 `/fixture/*` 会进到这里，其余请求直接由
 * Pages 的静态资源层发出去（静态请求在 Pages 上**不计费也不限量**；一旦所有请求
 * 都进 Function，那点免费额度会被页面自己吃光）。
 */

/** 默认的接口源。换账号或改 Worker 名字时改这里，或在 Pages 项目里设 `API_ORIGIN` 覆盖 */
const DEFAULT_API_ORIGIN = 'https://reader-api.liujieahu.workers.dev'

/**
 * 哪些路径交给接口那一份
 *
 * 与 `_routes.json` 的 `include` 是**同一组**（`test/pages.test.ts` 钉着这一条）：
 * 那边漏了一条，那条路径就会被当静态资源找、拿到 404，而这边写错则相反。
 */
const PROXY_PREFIXES = ['/api', '/fixture']

export default {
    async fetch(request, env) {
        const url = new URL(request.url)
        const proxied = PROXY_PREFIXES.some(
            (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
        )
        // 不是接口的（或者是 `_routes.json` 多放进来的）一律按静态资源发
        if (!proxied) return env.ASSETS.fetch(request)

        const origin = String(env?.API_ORIGIN || DEFAULT_API_ORIGIN).replace(/\/+$/, '')
        const upstream = await fetch(
            new Request(new URL(url.pathname + url.search, origin), request),
        )

        /**
         * 204 / 304 与 HEAD **不能带响应体** —— 照抄 body 会让 Response 构造直接抛错
         * （`Response with null body status cannot have body`），表现为「接口好好的，
         * 一经过 Pages 就 500」。
         */
        const body =
            request.method === 'HEAD' || upstream.status === 204 || upstream.status === 304
                ? null
                : upstream.body

        return new Response(body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
        })
    },
}
