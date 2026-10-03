/*
 * 搜索分页策略
 *
 * 为什么会有这个文件：Cloudflare 免费计划给每个 Worker 请求的 CPU 预算是
 * **10 毫秒**（硬上限 —— `limits.cpu_ms` 在免费计划下会被部署直接拒掉，
 * code 100328）。一次搜索要把**所有**书源的规则求值跑在同一个请求里，
 * 线上必然被掐：日志里是 `outcome: exceededCpu` / `Worker exceeded CPU time limit.`。
 *
 * 所以改成**分页**：一次只搜一小批（默认 10 个源），搜完由用户点「继续加载」
 * 再要下一批 —— 额度按人的节奏花，而不是被一次搜索烧光。
 *
 * 还有一条线上实测的经验：被掐之后**紧接着再发请求照样被掐**（弹性额度恢复得慢，
 * 第二次搜索的 76 个分片几乎全灭）。所以一页失败不代表「换个时刻重试」，
 * 而代表「这一页要小一点」—— `nextPageSize` 就是把页大小折半，一路折到 1 个源。
 */

/** 一页默认搜几个书源 */
export const SEARCH_PAGE_SIZE = 10

/** 页大小折半的下限：再小就没意义了（连 1 个源都跑不动，那是这个源自己的问题） */
export const SEARCH_MIN_PAGE = 1

/** 页大小折半；到下限就停在 1，调用方据此知道「已经没得再缩了」 */
export function nextPageSize(size) {
    const half = Math.floor((Number(size) || 0) / 2)
    return Math.max(SEARCH_MIN_PAGE, half || SEARCH_MIN_PAGE)
}

/** 这个错误像不像是「CPU 被掐」——只有这一类才值得缩页重试 */
export function isCpuLimitError(err) {
    if (!err) return false
    if (err.status === 503) return true
    const text = String(err.message ?? err)
    return text.includes('exceeded') || text.includes('CPU')
}
