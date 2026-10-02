/**
 * 注入沙箱的「书源相关全局」
 *
 * `source` 是书源脚本里用得最多的未实现能力（`source.getKey()` 413 次、
 * `source.bookSourceUrl` 133 次、`source.getVariable()` 79 次），
 * `jsLib` 则是**大部分「脚本缺少 XXX」的真正出处**。
 * 两者都在这里统一组装，让 `analyze.ts` 与 `legado/source.ts` 两条求值路径
 * 拿到完全相同的形状 —— 分开写迟早会出现「规则里 source 有值、URL 模板里没有」这种分歧。
 *
 * 只挑标量字段透传：整份 BookSource 里带着所有规则文本（几 KB 到几十 KB），
 * 而它每次求值都要 `JSON.stringify` 一次进沙箱，透传全量纯属浪费。
 */

import type { BookSource, RuleContext } from './types'
// 只取类型：`import type` 会被完全擦除，不会把 QuickJS 的 WASM 带进来
import type { SandboxSession } from './js'

/** 书源里会出现在脚本中的标量字段 */
const SCALAR_FIELDS = [
    'bookSourceName',
    'bookSourceUrl',
    'bookSourceGroup',
    'bookSourceComment',
    'bookSourceType',
    'bookUrlPattern',
    'header',
    'loginUrl',
    'loginUi',
    'searchUrl',
    'exploreUrl',
    'exploreScreen',
    'variableComment',
    'customOrder',
    'weight',
    'concurrentRate',
    'enabled',
    'enabledCookieJar',
    'enabledExplore',
    'lastUpdateTime',
    'respondTime',
] as const

/**
 * 组装给沙箱 `source` 用的数据
 *
 * `key` 是**当前搜索关键字**：Legado 把 `source.key` 当作本次搜索的词，
 * 大量规则靠 `source.getKey()` 拼地址（`Search_()` 那类函数都这么写）。
 */
export function sourcePayload(
    source: BookSource | undefined,
    key = '',
): Record<string, unknown> | null {
    if (!source) return null
    const record = source as unknown as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const field of SCALAR_FIELDS) {
        const value = record[field]
        if (value === undefined || value === null) continue
        out[field] = value
    }
    out.key = key
    return out
}

/** 沙箱里与书源有关的全局变量 */
export function sourceGlobals(ctx: RuleContext): Record<string, unknown> {
    const variables = ctx.vars ?? {}
    return {
        __source: sourcePayload(ctx.source, ctx.key ?? ''),
        __sourceVars: JSON.stringify(variables),
        __infoMap: ctx.infoMap ?? {},
    }
}

/**
 * 沙箱资源上限里与书源有关的部分
 *
 * `preludeJs` 是书源自带的 JS 库；`session` 是本次请求的沙箱会话 ——
 * 两者都要跟着上下文走，缺一个都会让整类书源表现异常。
 */
export function sourceLimits(ctx: RuleContext): {
    preludeJs?: string
    session?: SandboxSession
} {
    const lib = ctx.source?.jsLib
    return {
        ...(lib && lib.trim() !== '' ? { preludeJs: lib } : {}),
        // `RuleContext` 里存的是结构化类型（避免 types.ts 依赖带 WASM 的模块），
        // 这里换回 SandboxSession 的具体类型，形状本就一致，只是 `module` 的泛型更精确
        ...(ctx.sandbox ? { session: ctx.sandbox as SandboxSession } : {}),
    }
}
