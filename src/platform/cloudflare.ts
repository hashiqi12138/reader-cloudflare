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

export function cloudflareEnv(env: Env): AppEnv {
    return {
        DB: env.DB,
        ASSETS: env.ASSETS,
        ENGINE_VERSION: env.ENGINE_VERSION,
        ENABLE_FIXTURE: env.ENABLE_FIXTURE,
    }
}
