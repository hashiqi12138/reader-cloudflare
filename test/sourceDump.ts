/**
 * 全量扫描测试的共用部分：读一份书源 dump、把里面的规则取出来
 *
 * 两个扫描测试（连接符切分、规则前缀）都要这两步，所以抽出来。
 * 书源**不进仓库**（见 README「关于书源」），dump 的路径由环境变量给，
 * 因此这些测试默认整组跳过。
 *
 * 兼容三种 dump 形状，因为它们来自不同命令、都有人用：
 *   1. `wrangler d1 execute --json` 的输出 —— 平铺的行、`payload` 里是书源 JSON
 *   2. `scripts/probe-sources.mjs` 的探索结果 —— 按分组包着，`group.results[].payload`
 *   3. 书源对象数组本身（有些人会先把 payload 拆出来存一份）
 */

import { readFileSync } from 'node:fs'

export const RULE_GROUPS = ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleExplore']

/**
 * 书源顶层里「引擎会当规则去求值」的字段
 *
 * 只有这两个。其余都不是规则：
 *   - `jsLib` 是一整段 JS 脚本库
 *   - `header` 是 JSON 请求头
 *   - `loginUrl` 是登录流程的脚本（本引擎只是把它当**值**暴露给脚本里的 `source.loginUrl`，
 *     从不拿去求值）
 *
 * 把它们当规则收进来，扫描就会冒出一整批假阳性：`jsLib` / `loginUrl` 里以 `//` 开头的
 * 注释行会被当成 XPath 表达式。实测先是报出 11 处「解析失败」，把这些字段排掉之后
 * 只剩 1 处真问题 —— `contains (` 里那个空格（见 `xpath.ts` 的 `normalizeXPathFunctions`），
 * 也已经修掉。
 */
export const URL_FIELDS = ['searchUrl', 'exploreUrl']

/**
 * 规则组里**不是规则**的字段
 *
 * 它们装的是配置或 JS，引擎从不拿它们去求值：
 *   - `replaceRegex` 是正文净化正则（`applyReplaceRegex` 直接当正则用），形如
 *     `##正则##替换` —— 线上 151 处里 **132 处以 `##` 开头**、10 处含 `@js:`。
 *     当成规则收进来会一次报出上百条「选择器为空」的假阳性（实测就是这个数）
 *   - `imageDecode` 是图片重排的 JS 片段（要靠 Android 的 BitmapFactory，本引擎不实现）
 */
const NON_RULE_FIELDS = new Set(['replaceRegex', 'imageDecode'])

function parsePayload(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'string') return null
    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
        return null
    }
}

/** 从任意一种 dump 形状里取出书源对象数组 */
export function loadSourceDump(path: string): Record<string, unknown>[] {
    const raw = readFileSync(path, 'utf8')
    // 从第一个 `[` 开始切：`wrangler --json` 会先在 stdout 上打一行提示
    const json = JSON.parse(raw.slice(raw.indexOf('[')))
    if (!Array.isArray(json)) return []

    const sources: Record<string, unknown>[] = []
    for (const row of json) {
        if (!row || typeof row !== 'object') continue

        // 形状 1：平铺的行，书源在 payload 里
        const direct = parsePayload((row as { payload?: unknown }).payload)
        if (direct) {
            sources.push(direct)
            continue
        }

        // 形状 2：分组结果
        const results = (row as { results?: unknown }).results
        if (Array.isArray(results)) {
            for (const hit of results) {
                const nested = parsePayload((hit as { payload?: unknown })?.payload)
                if (nested) sources.push(nested)
            }
            continue
        }

        // 形状 3：行本身就是书源
        sources.push(row as Record<string, unknown>)
    }
    return sources
}

/** 一条规则字段：`path` 形如 `ruleToc.chapterList`，用来在扫描输出里定位 */
export interface RuleField {
    path: string
    value: string
}

/**
 * 一条书源里所有「引擎会当规则求值」的字段
 *
 * 返回路径而不只是字符串：扫描输出里必须能指出**是哪个字段**出的问题，
 * 否则「某条源的某条规则解析失败」这句话没法照着去修。
 */
export function ruleFieldsOf(source: Record<string, unknown>): RuleField[] {
    const out: RuleField[] = []
    for (const group of RULE_GROUPS) {
        const fields = source[group]
        if (fields && typeof fields === 'object') {
            for (const [field, value] of Object.entries(fields)) {
                if (typeof value !== 'string') continue
                // 名字以 `Js` 结尾的字段**本身就是 JS**（`callBackJs` / `webJs` / `formatJs`），
                // 里面不带 `@js:` 标记。收进来的话，JS 里以 `//` 开头的注释行会被当成 XPath 表达式
                if (/Js$/.test(field)) continue
                if (NON_RULE_FIELDS.has(field)) continue
                out.push({ path: `${group}.${field}`, value })
            }
        }
    }
    for (const key of URL_FIELDS) {
        const value = source[key]
        if (typeof value === 'string' && value !== '') out.push({ path: key, value })
    }
    return out
}

/** 只要值（大多数扫描不关心字段名） */
export function rulesOf(source: Record<string, unknown>): string[] {
    return ruleFieldsOf(source).map((field) => field.value)
}

/** 规则与 URL 字段里的连接符 */
export const JOINERS = ['&&', '||', '%%'] as const
