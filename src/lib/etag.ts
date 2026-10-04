/**
 * HTTP 缓存校验器（ETag）的比对
 *
 * 只做「服务端算一个标签、浏览器下次带回来比一比」这一件事，没有依赖，
 * 所以能直接单元测试 —— 而它恰好是最容易写错、又最难在浏览器里复现的地方：
 * 发出去的是带引号的强标签，回来的却可能是弱校验前缀 `W/`、可能是一串、也可能是 `*`。
 */

/**
 * `If-None-Match` 里是否命中给定的标签
 *
 * 三种形态都要认：
 * - 精确相等 —— 浏览器把我们发的那串原样带回来，这是常态
 * - 弱校验前缀 `W/` —— 代理或浏览器可能把它降级后回传
 * - `*` —— 规范里表示「只要资源存在就算命中」
 *
 * 标签本体按不透明字节比，不做大小写折叠；`W/` 的 `W` 是大写（规范如此），
 * 这里只剥前缀、不改动其余字符。
 */
export function matchesEtag(header: string | undefined, etag: string): boolean {
    if (!header) return false
    return header.split(',').some((part) => {
        const value = part.trim().replace(/^W\//, '')
        return value === '*' || value === etag
    })
}
