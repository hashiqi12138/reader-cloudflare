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
export const URL_FIELDS = ['searchUrl', 'exploreUrl', 'header', 'jsLib', 'loginUrl']

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

/** 一条书源里所有「可能是规则」的字符串 */
export function rulesOf(source: Record<string, unknown>): string[] {
    const out: string[] = []
    for (const group of RULE_GROUPS) {
        const fields = source[group]
        if (fields && typeof fields === 'object') {
            for (const value of Object.values(fields)) {
                if (typeof value === 'string') out.push(value)
            }
        }
    }
    for (const key of URL_FIELDS) {
        const value = source[key]
        if (typeof value === 'string' && value !== '') out.push(value)
    }
    return out
}

/** 规则与 URL 字段里的连接符 */
export const JOINERS = ['&&', '||', '%%'] as const
