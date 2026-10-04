/*
 * 书源列表的复用
 *
 * 为什么要单独一层
 * ---------------
 * `/api/sources` 回的是**全部**书源的摘要（线上 816 条、约 130 KB），而「发现」页与
 * 「书源」页各要读一遍 —— 来回切一下就是反复拉同一份东西。服务端那侧已经加了 ETag：
 * 重复请求只花一次 304（不再读那 816 行、也不再序列化），但**那一趟往返省不掉**，
 * 130 KB 也只是换成「浏览器从自己的 HTTP 缓存里取」。书源列表在一次会话里几乎不变，
 * 所以这里再挡一层。
 *
 * 与 Service Worker 那层缓存的分工：那层管「断网还能不能打开」，这层管「同一次会话里
 * 别重复拉」—— 后者联网时也要生效。
 *
 * 写成一个带失效开关的小对象，而不是散在每个视图里各存一份：漏一次失效**不会报错**，
 * 只会让用户看到过期的列表（「刚导入的书源没出现」），是最难查的那类问题。
 *
 * 这个文件不碰 DOM、不碰 localStorage，取数由调用方注入 —— 所以能直接单元测试。
 */

/**
 * 兜底的时限
 *
 * 会话内的改动（导入 / 启停 / 删除 / 登录）都会**显式**失效，这个只挡「别处改了」：
 * 另一个标签页动了书源，或者阅读时书源自己跑了 `putLoginHeader`（登录态那列变了，
 * 而这次变化不经过任何视图）。把它设短一点，代价只是一次 304。
 */
const DEFAULT_TTL_MS = 30_000

/**
 * @param fetchList 取书源列表的函数（`() => Promise<data>`），失败要抛
 * @param options.ttlMs 兜底时限，默认 30 秒
 * @param options.now 取当前时间的函数，测试用
 */
export function createSourcesCache(fetchList, options = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    const now = options.now ?? (() => Date.now())

    let cached = null
    let inflight = null
    /** 失效计数：用来判断「这趟请求发出之后有没有被失效过」 */
    let epoch = 0

    function start() {
        const mine = epoch
        const request = Promise.resolve()
            .then(fetchList)
            .then((data) => {
                // 已经失效过就别写回：否则会把**改动前**的那份记成最新的，
                // 之后 ttlMs 内再读到的都是它（正好是「导入完看不见」那个故障）
                if (mine === epoch) cached = { at: now(), data }
                return data
            })
        inflight = request
        const done = () => {
            // 认准自己这一趟：失效之后可能已经起了新的一趟，别把它的标记清掉
            if (inflight === request) inflight = null
        }
        request.then(done, done)
        return request
    }

    return {
        /**
         * 读列表
         *
         * 并发调用共用同一趟请求（几个视图同时要列表时只发一次）；
         * **失败不入缓存** —— 一次网络抖动不该让接下来 ttlMs 都读到同一个错误。
         */
        async load() {
            if (cached && now() - cached.at < ttlMs) return cached.data
            if (inflight) return inflight
            return start()
        },

        /** 改过书源（导入 / 启停 / 删除 / 登录）之后必须调一次 */
        invalidate() {
            epoch += 1
            cached = null
            // 在飞的那趟也作废：它带回来的是改动前的数据，留着只会被下一次 `load` 当成最新的
            inflight = null
        },
    }
}
