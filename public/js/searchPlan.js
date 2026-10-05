/*
 * 搜索分页策略
 *
 * 为什么会有这个文件：Cloudflare 免费计划给每个 Worker 请求的 CPU 预算是
 * **10 毫秒**（硬上限 —— `limits.cpu_ms` 在免费计划下会被部署直接拒掉，
 * code 100328）。一次搜索要把**所有**书源的规则求值跑在同一个请求里，
 * 线上必然被掐：日志里是 `outcome: exceededCpu` / `Worker exceeded CPU time limit.`。
 *
 * 所以改成**分页**：一次只搜一小批（默认 3 个源），搜完由用户点「继续加载」
 * 再要下一批 —— 额度按人的节奏花，而不是被一次搜索烧光。
 *
 * 页大小从 10 收到 3，是因为**一次搜索的成败取决于这一页里最慢的那个源**：
 * 免费计划的 10 ms 是**整个请求**的预算，页里多一个要跑脚本的源就多一分被掐的概率，
 * 而被掐的代价是整页白花。页小一点，单次更可能跑完，用户点两下也就到 3 个源了。
 *
 * 还有一条线上实测的经验：被掐之后**紧接着再发请求照样被掐**（弹性额度恢复得慢，
 * 第二次搜索的 76 个分片几乎全灭）。所以一页失败不代表「换个时刻重试」，
 * 而代表「这一页要小一点」—— `nextPageSize` 就是把页大小折半，一路折到 1 个源。
 *
 * **但折到 1 个源也不够（第六十七轮量死的）。** 逐源单发、从 `wrangler tail` 读
 * `cpuTime`：**一个源就要 60~220 ms**，是 10 ms 预算的 6~22 倍。也就是说
 * `SEARCH_MIN_PAGE = 1` 这个下限**本身就还在预算之上** —— 折半这条路的尽头也是失败。
 * 那次的实测长这样（同一个关键词，只改 `sourceIds` 的个数）：
 *
 *   1 个源 130 / 60 / 155 ms（有时成功）  2 个源 196 / 329 ms  3 个源 361 / 403 ms
 *   4 个源 376 ms → exceededCpu          之后逐源单发 14 次 → 全部被截在 10 ms
 *
 * 所以「拆成更多小请求」与「只搜用户选中的源」**都不是出路**：它们的下限仍是「一个源」。
 * 真出路只有两条 —— 换一个**没有 10 ms 上限**的宿主（付费计划是 30 s，
 * 自建部署没有这个限制，见 `src/platform/`），或者不再抓页面解析。
 * 这一段留着不删：免得下次又有人照着「再拆小一点」去试。
 *
 * 本轮改动：「按名字 / 分组筛」那个纯函数搬去了 `sourceFilter.js`（与「书源」页
 * 的分组筛选共用同一套判据），这里不再有 `matchSources`。
 */

/** 一页默认搜几个书源 */
export const SEARCH_PAGE_SIZE = 3

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

// ---------------------------------------------------------------- 搜索范围（指定书源）

/**
 * 能拿来搜的书源：启用的、且有搜索规则
 *
 * `hasSearch` 由服务端算好（`/api/sources` 的摘要，见 `src/data/db.ts`）——
 * 前端不重新判断「有没有 searchUrl」，那是把同一件事算两遍。
 * **保持服务端给的顺序**（按导入顺序 / 名字），与「书源」页看到的顺序一致。
 */
export function searchableSources(sources) {
    return (Array.isArray(sources) ? sources : []).filter(
        (one) => one && one.enabled !== false && one.hasSearch === true,
    )
}

/**
 * 把存下来的选择收敛到「现在还在、还能搜」的源
 *
 * 选择存在 localStorage 里，而书源会被删掉或停用。不收敛的话，界面会显示「已选 3 个」
 * 而实际只搜到 1 个 —— 而且**不会报错**。顺带去重，并保持原来的先后顺序。
 */
export function normalizeSelection(ids, sources) {
    const usable = new Set(searchableSources(sources).map((one) => String(one.id)))
    const out = []
    for (const id of Array.isArray(ids) ? ids : []) {
        const text = String(id)
        if (usable.has(text) && !out.includes(text)) out.push(text)
    }
    return out
}
