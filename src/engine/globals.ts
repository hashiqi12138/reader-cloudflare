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
 * `key` 是**书源自己的地址**（`bookSourceUrl`），不是当前搜索词 —— 这一条以前写错了，
 * 见下面 `out.key` 处的说明。本次搜索的词有**单独的 `key` 全局**（`{{key}}`、
 * `@js:key`），不需要也不应该从这里拿。
 */
export function sourcePayload(source: BookSource | undefined): Record<string, unknown> | null {
    if (!source) return null
    const record = source as unknown as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const field of SCALAR_FIELDS) {
        const value = record[field]
        if (value === undefined || value === null) continue
        out[field] = value
    }
    /**
     * `source.getKey()` / `source.key` = `bookSourceUrl`
     *
     * 以前这里放的是**本次搜索关键字**，于是全量 816 条源里 **122 个源、206 处**
     * `source.getKey()` / `source.key` 全部拿到一个搜索词，而书源把它们当**站点地址**用：
     *
     *   - `source.getKey() + "/search.html"`（📂天悦小说）→ 拼出 `斗破苍穹/search.html`
     *   - `java.connect(source.getKey())`（📂八一中文 / ⚡📂三五中文 / ⚡📂香书小说 … 9 处）
     *     → 去连一个叫「斗破苍穹」的主机
     *   - `cookie.removeCookie(source.getKey())`（📂一本阁 / 📂小书本网 / 🔞爱丽丝书屋 …）
     *     → 清的是另一个 key，等于没清
     *   - `java.ajax(source.key)`（⚡📂九九藏书 / 📂冰清阁小说 / ⚡📂全本小说 …）→ 请求一个搜索词
     *
     * 它们在 Legado 那边都对：`BaseSource.getKey()` 返回的就是 `bookSourceUrl`
     * （书源的身份、cookie 与缓存的 tag 都用它）。搜索词在 Legado 里是**单独的 `key`**。
     */
    out.key = String(record.bookSourceUrl ?? '')
    return out
}

/** 沙箱里与书源有关的全局变量 */
export function sourceGlobals(ctx: RuleContext): Record<string, unknown> {
    const variables = { ...sessionVars(ctx), ...(ctx.vars ?? {}) }
    return {
        __source: sourcePayload(ctx.source),
        __sourceVars: JSON.stringify(variables),
        __infoMap: ctx.infoMap ?? {},
    }
}

/**
 * 本次请求里已经写过的书源变量
 *
 * `java.put` / `source.setVariable` 写进会话（见 `SandboxSession.vars`），
 * 下一次求值再把它们注回沙箱 —— 书源里「搜索脚本先存、字段规则后读」靠的就是这一步。
 * 会话不存在（比如单测里只调 sourceGlobals）时给空表，行为与以前一样。
 */
function sessionVars(ctx: RuleContext): Record<string, string> {
    const session = ctx.sandbox as { vars?: Record<string, string> } | undefined
    return session?.vars ?? {}
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
