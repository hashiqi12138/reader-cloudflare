/*
 * Cloudflare 侧的绑定：把 Worker 的 `env` 变成 `AppEnv`
 *
 * 就四个赋值 —— D1 与静态资源绑定**天生满足** `platform/types.ts` 里那两个接口
 * （接口的形状就是照着它们的 API 定的），所以这里没有包装层、也没有 `as` 强转。
 * 真要哪一处对不上，`tsc` 会**在这里**直接报出来，而不是等换平台时才发现。
 *
 * 这是唯一一处出现 `Env`（Worker 的原始绑定类型，由 `wrangler types` 生成）的地方 ——
 * 业务代码只认 `AppEnv`。换平台时新写一个同样返回 `AppEnv` 的函数即可，
 * 其余一概不动。
 */

import type { AppEnv } from './types'

/**
 * Workers 的 Cache API 挂在 `caches.default` 上，但 `wrangler types` 生成的那份声明里没有它
 * ——那里生成的是 `declare abstract class CacheStorage`（类，没法用接口合并补成员），
 * 所以只能在这里就地收窄一次。收窄只发生在这一个文件里：业务侧拿到的仍然是 `PlatformCache`。
 *
 * **取用放在函数里、不在模块顶层**：这个模块会被 Node 那份产物一起打进去
 * （`index.ts` 既 `handleRequest` 也 `cloudflareEnv`），而 Node 上没有 `caches` 这个全局 ——
 * 顶层求值的话，自建那份**在 import 阶段就崩**，连入口都跑不到。
 */
function defaultCache(): Cache {
    return (caches as unknown as { default: Cache }).default
}

export function cloudflareEnv(env: Env): AppEnv {
    return {
        DB: env.DB,
        ASSETS: env.ASSETS,
        // 边缘缓存按机房生效，不是全局的 —— 全局那份要 R2（见 TODO.md）
        CACHE: defaultCache(),
        ENGINE_VERSION: env.ENGINE_VERSION,
        ENABLE_FIXTURE: env.ENABLE_FIXTURE,
        // 线上固定 `false`：免费计划每请求 10 ms CPU 跑不动一次全量搜索（见 wrangler.jsonc）
        SEARCH_ALL_SOURCES: env.SEARCH_ALL_SOURCES,
    }
}
