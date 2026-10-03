/*
 * 搜索分片
 *
 * 为什么要有这个文件：Cloudflare 免费计划给每个 Worker 请求的 CPU 预算是
 * **10 毫秒**（硬上限 —— `limits.cpu_ms` 在免费计划下会被部署直接拒掉，
 * code 100328），而一次搜索原本要把**所有**书源的规则求值跑在同一个请求里。
 * 线上实测这个请求会被掐断：日志里是 `outcome: exceededCpu` /
 * `Worker exceeded CPU time limit.`，浏览器拿到 503。
 *
 * 本地 `wrangler dev` 不设 CPU 限制，所以这个故障**只在线上出现**；
 * 而线上也拿不到「一片放几个源才不会超」的准确数字（不同书源的规则复杂度
 * 差着数量级），所以这里做成自适应的：整片被掐掉就劈成两半重试，
 * 一路劈到单个源为止。
 */

/** 每片默认放几个书源。拿不准就取小一点：多劈一次比整片超时便宜 */
export const SEARCH_SLICE_SIZE = 4

/** 同时最多几个片在飞。线上实测并发高了会把 CPU 的弹性额度很快吃光 */
export const SEARCH_CONCURRENCY = 2

/**
 * 每片之间歇一下（毫秒）
 *
 * 线上实测的形态很清楚：连着发请求时，**前几片连 226 ms CPU 都能过**，
 * 之后连 10 ms 都被掐。也就是说 Cloudflare 对偶发超限是有弹性的，
 * 但「持续超」会被直接终止 —— 弹性额度会被连续请求吃光。
 * 所以宁可慢一点，也要把请求频率压下来。
 */
export const SEARCH_GAP_MS = 250

/** 把 id 列表切成片；空列表得到空数组 */
export function planSlices(ids, size = SEARCH_SLICE_SIZE) {
    if (!Array.isArray(ids) || ids.length === 0) return []
    const step = Math.max(1, Math.floor(size) || 1)
    const slices = []
    for (let i = 0; i < ids.length; i += step) slices.push(ids.slice(i, i + step))
    return slices
}

/**
 * 把一片劈成两半
 *
 * 一片只有一个源时返回 null —— 调用方据此知道「没得再劈了」，
 * 必须就此收手，否则会在同一个源上无限重试。
 */
export function halveSlice(slice) {
    if (!Array.isArray(slice) || slice.length <= 1) return null
    const mid = Math.ceil(slice.length / 2)
    return [slice.slice(0, mid), slice.slice(mid)]
}

/** 这个错误像不像是「CPU 被掐」——只有这一类才值得劈半重试 */
export function isCpuLimitError(err) {
    if (!err) return false
    if (err.status === 503) return true
    const text = String(err.message ?? err)
    return text.includes('exceeded') || text.includes('CPU')
}

/** 歇一下；0 就直接往下走，不留一个多余的微任务 */
function pause(ms) {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 并发池
 *
 * `onError` 返回数组时，那些片会被**重新入队**（劈半重试就是靠这个），
 * 返回 null 表示放弃、按失败记下来。
 * `onSettled` 每片有结论时调用一次（成功，或最终失败）。
 */
export async function runPool(tasks, worker, options = {}) {
    const queue = Array.isArray(tasks) ? [...tasks] : []
    const results = []
    if (queue.length === 0) return results

    const concurrency = Math.max(1, Math.floor(options.concurrency ?? SEARCH_CONCURRENCY) || 1)
    const gapMs = Math.max(0, Math.floor(options.gapMs ?? SEARCH_GAP_MS) || 0)

    const takeOne = async () => {
        for (;;) {
            const task = queue.shift()
            if (task === undefined) return
            let entry
            try {
                entry = { task, ok: true, value: await worker(task) }
            } catch (err) {
                const retry = options.onError ? options.onError(err, task) : null
                if (Array.isArray(retry) && retry.length > 0) {
                    queue.push(...retry)
                    await pause(gapMs)
                    continue
                }
                entry = { task, ok: false, error: err }
            }
            results.push(entry)
            if (options.onSettled) options.onSettled(entry, results)
            await pause(gapMs)
        }
    }

    const flying = []
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) flying.push(takeOne())
    await Promise.all(flying)
    return results
}
