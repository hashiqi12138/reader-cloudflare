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
import type { SandboxLimits, SandboxSession } from './js'

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
    /**
     * `source.variable` / `source.getVariable()` = **书源自己的 variable 字符串**
     *
     * 它必须**总是**作为字符串出现（哪怕是空串）：`getVariable()` 无参时要回它，
     * 而这个字段在 816 条源里一条都没有 —— 靠 `SCALAR_FIELDS` 的「undefined 就不进
     * payload」规则会把它整个丢掉，沙箱那侧于是拿到 undefined。
     */
    out.variable = String(record.variable ?? '')
    return out
}

/** 沙箱里与书源有关的全局变量 */
export function sourceGlobals(ctx: RuleContext): Record<string, unknown> {
    const variables = { ...sessionVars(ctx), ...(ctx.vars ?? {}) }
    return {
        __source: sourcePayload(ctx.source),
        __sourceVars: JSON.stringify(variables),
        __infoMap: ctx.infoMap ?? {},
        /**
         * cookie 罐（主机名 → cookie 串）
         *
         * 只有书源开着 `enabledCookieJar` 时注册表才给它建罐子（见 `data/db.ts`），
         * 没建时注入空表 —— 沙箱里的 `cookie.*` 于是退回「只活本次求值」的老行为，
         * 与书源自己声明的取舍一致。求值结束后 `collectCookies` 把改动收回罐子并落库。
         */
        __cookieJar: JSON.stringify(ctx.source?.cookieJar?.hosts ?? {}),
    }
}

/**
 * 本次请求里已经写过的会话变量（`java.put` / `java.get(k)`）
 *
 * 写进会话（见 `SandboxSession.vars`），下一次求值再把它们注回沙箱 ——
 * 书源里「搜索脚本先存、字段规则后读」靠的就是这一步。
 * 会话不存在（比如单测里只调 sourceGlobals）时给空表，行为与以前一样。
 *
 * 注意**不含**书源变量（`source.getVariable()`）：那一条走 `sourcePayload`，
 * 因为它的值来自书源自己（会落库），不是这张按请求活的表。
 */
function sessionVars(ctx: RuleContext): Record<string, string> {
    const session = ctx.sandbox as { vars?: Record<string, string> } | undefined
    return session?.vars ?? {}
}

/**
 * 这本书的变量（`book.getVariable` / `book.putVariable`）
 *
 * 与书源变量（`source.getVariable()`，见 `sourcePayload`）分开放，因为它们是两份东西：
 *   - 书源变量：一段**自由字符串**，作用域是「这个源」，起点空串
 *   - 书的变量：**名字 → 值**的一张表，作用域是「这本书」，起点空表
 *
 * 会话里存过的那一份**优先**：同一次请求里正文规则刚 `book.putVariable("序", i)` 写过的，
 * 同一个源后面的规则要立刻读得到（📂掌阅书城 就是「先读 `序`，为空才探一次并写回」）。
 */
function bookVars(ctx: RuleContext): Record<string, string> {
    const session = ctx.sandbox as { bookVars?: Record<string, string> } | undefined
    return { ...(ctx.bookVars ?? {}), ...(session?.bookVars ?? {}) }
}

/**
 * **所有**沙箱求值共用的那一组全局变量
 *
 * 它以前在四个地方各写了一份（规则求值、`{{}}` 模板、URL 里的 `@js:`、发现页），
 * 于是每加一个字段就要在四处补齐 —— 而漏掉一处**不会报错**，只会让那一处的书源
 * 少看见一个全局。`book` 就是被这样漏掉的：`baseGlobals` 里写着 `ctx.book ?? {}`，
 * 但**没有任何调用方给 ctx.book 赋过值**，于是 `book.name` 54 处 / 39 源、
 * `chapter.title` 32 处 / 30 源一直是 `undefined` ——
 * `'【' + book.name + '】'` 拼出「【undefined】」，不报错，只是结果不对。
 */
export function baseGlobals(ctx: RuleContext): Record<string, unknown> {
    return {
        baseUrl: ctx.baseUrl,
        book: ctx.book ?? {},
        chapter: ctx.chapter ?? {},
        key: ctx.key ?? '',
        page: ctx.page ?? 1,
        // `source` / `sourceVars` / `infoMap` 在沙箱预置里由这几个变量组装
        ...sourceGlobals(ctx),
        // 书的变量单独走一路：它要落库（见 collectBookVars），而会话变量只活一次请求
        __bookVars: JSON.stringify(bookVars(ctx)),
    }
}

/**
 * 沙箱资源上限里与书源有关的部分
 *
 * 四样都要跟着上下文走，缺一样都会让整类书源表现异常：
 *   - `preludeJs`：书源自带的 JS 库（那些源里的 `GetUL()` / `host()` 全来自它）
 *   - `session`：本次请求的沙箱会话（模块实例、会话变量表、书的变量）
 *   - `persistSourceVariable`：`source.setVariable(整串)` 的落库路径（上层注入）
 *   - `persistBookVariable`：`book.putVariable(名字, 值)` 的落库路径（上层注入）
 *
 * 放这里而不是各自的调用点：analyze 的规则求值、`resolveTemplate` 的 `{{}}` 模板、
 * `buildPlan` 的 URL 脚本几条路都要它，各写一遍必然有一处漏掉 —— 而漏掉的表现是
 * 「书源里设置成功、下次进来又没了」，很难往这上面想。
 */
export function sourceLimits(ctx: RuleContext): SandboxLimits {
    const lib = ctx.source?.jsLib
    return {
        ...(lib && lib.trim() !== '' ? { preludeJs: lib } : {}),
        // `RuleContext` 里存的是结构化类型（避免 types.ts 依赖带 WASM 的模块），
        // 这里换回 SandboxSession 的具体类型，形状本就一致，只是 `module` 的泛型更精确
        ...(ctx.sandbox ? { session: ctx.sandbox as SandboxSession } : {}),
        ...(ctx.persistSourceVariable ? { persistSourceVariable: ctx.persistSourceVariable } : {}),
        ...(ctx.persistBookVariable ? { persistBookVariable: ctx.persistBookVariable } : {}),
        // cookie 罐：书源没开 enabledCookieJar 时它压根不存在，沙箱那侧就退回老行为
        ...(ctx.source?.cookieJar ? { cookieJar: ctx.source.cookieJar } : {}),
        ...(ctx.source?.persistCookies ? { persistCookies: ctx.source.persistCookies } : {}),
    }
}
