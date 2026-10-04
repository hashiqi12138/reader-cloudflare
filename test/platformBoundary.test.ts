/*
 * 平台边界的看门测试
 *
 * 抽兼容层这件事最大的风险不是「抽得不好」，而是**慢慢漏回去**：某天有人在路由里
 * 顺手写个 `db: D1Database`，一切照常跑 —— 换平台那天才会发现「怎么还有一处」。
 * 类型层面的保证（Cloudflare 绑定满足 `PlatformDb`，见 `platform/cloudflare.ts`）
 * 拦不住这种回退，因为它恰恰是「能编过」的。
 *
 * 所以这里用最直接的办法盯着：直接读源码，断言那几样平台专属的东西只出现在
 * `src/platform/` 里。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** 项目里所有 `.ts`（含子目录），排除生成物 —— `RELEASE_ASYNC.wasm` 那类不是 .ts，自然跳过 */
function collect(dir: string): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = []
    for (const one of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, one.name)
        if (one.isDirectory()) {
            out.push(...collect(full))
            continue
        }
        if (!one.name.endsWith('.ts')) continue
        out.push({
            path: relative(SRC, full).replaceAll('\\', '/'),
            text: readFileSync(full, 'utf8'),
        })
    }
    return out
}

const FILES = collect(SRC)
const BUSINESS = FILES.filter((one) => !one.path.startsWith('platform/'))

describe('平台边界', () => {
    it('业务代码里不再出现 D1 的类型或包名', () => {
        const leaked = BUSINESS.filter((one) =>
            /D1Database|D1PreparedStatement|@cloudflare\/workers-types/.test(one.text),
        ).map((one) => one.path)

        expect(leaked).toEqual([])
    })

    it('`import … from "*.wasm"` 只有一处，就是 platform/wasm.ts', () => {
        const importing = FILES.filter((one) => /from '[^']*\.wasm'/.test(one.text)).map(
            (one) => one.path,
        )

        expect(importing).toEqual(['platform/wasm.ts'])
    })

    it('那五个接口只在一处定义 —— platform/types.ts', () => {
        const declared = [
            'PlatformDb',
            'PlatformStatement',
            'PlatformResult',
            'PlatformAssets',
            'AppEnv',
        ]

        for (const name of declared) {
            const where = FILES.filter((one) =>
                new RegExp(`export (interface|type) ${name}\\b`).test(one.text),
            ).map((one) => one.path)

            expect(where, name).toEqual(['platform/types.ts'])
        }
    })

    it('Worker 的原始绑定类型 `Env` 只出现在入口与适配层', () => {
        // `AppEnv` 不算：`\b` 在 `AppEnv` 里那个 `Env` 前面没有词边界
        const naming = FILES.filter((one) => /\bEnv\b/.test(one.text)).map((one) => one.path)

        expect(naming.sort()).toEqual(['index.ts', 'platform/cloudflare.ts'])
    })

    it('边缘缓存只从适配层拿 —— 业务代码里不出现 `caches`', () => {
        // 业务侧一律走 `c.env.CACHE`（`PlatformCache`），换平台时才只需要改一个适配器
        const leaked = BUSINESS.filter((one) => /\bcaches\b/.test(one.text)).map((one) => one.path)

        expect(leaked).toEqual([])
    })
})
