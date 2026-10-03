/**
 * 替换净化规则的账号同步
 *
 * 规则本来是**浏览器本地**的（`localStorage`，与主题、字号一致）：改一条立刻重排当前章节，
 * 不必「存库 → 重新拉正文 → 重新分页」。代价是换设备就没了 —— 写了几十条正则的人
 * 换台机器要从头再来一遍。这个模块补的就是这一环。
 *
 * 三件事值得说明：
 *
 * 1. **一行存整份规则**（表 `replace_rules`，见迁移 `0009`）。这份规则永远整份读写，
 *    拆成一条一行只会多一个排序列与一轮删旧插新。
 * 2. **不自动同步，也不「最后写入者胜」。** 两个按钮，用户按下才动：
 *    上传 / 取回。理由见 `writeReplaceRules` 的冲突规则 ——
 *    自动同步把「什么时候覆盖」变成用户看不见的决策。
 * 3. **校验在服务端做，且报错要说得清是第几条**。规则是用户手写的正则，
 *    一份几百条、单条几 KB 的规则能把 D1 的一行撑爆；坏在第 37 条时只说
 *    「格式不对」等于没说。
 */

import type { D1Database } from '@cloudflare/workers-types'

import type { AccountUser } from './accounts'
import { ownerForUser } from './accounts'
import { DataError } from './types'

/** 规则条数上限。够用（线下写几十条算多的），又不至于让一行 JSON 无限长 */
export const MAX_REPLACE_RULES = 200
/** 单个字段（名字/正则/替换串）的长度上限 */
export const MAX_REPLACE_FIELD = 2000

/** 一条替换净化规则，形状对齐 Legado */
export interface ReplaceRule {
    name: string
    group: string
    pattern: string
    replacement: string
    enabled: boolean
}

/** 服务端这一份规则 */
export interface StoredReplaceRules {
    rules: ReplaceRule[]
    /** 0 表示「还没有同步过」。客户端把它当基准带回来做冲突检测 */
    updatedAt: number
}

/** 空的一份：没同步过的账号也回这个，而不是 404 —— 「没有」是一个正常状态 */
export const EMPTY_REPLACE_RULES: StoredReplaceRules = { rules: [], updatedAt: 0 }

function str(value: unknown, limit = MAX_REPLACE_FIELD): string {
    return String(value ?? '').slice(0, limit)
}

/**
 * 校验并归一一份规则（纯函数，可直接单测）
 *
 * **不做「静默丢弃」**：坏在第几条就报到第几条。两种坏法分开说 ——
 * 整份不是数组（多半是前端拼错了）、某一条不是对象。
 * 字段层面则一律**归一**而不是拒绝：数字、缺字段、超长都收敛成能用的字符串，
 * 因为这些是「用户没写全」，不是「数据坏了」。
 */
export function parseReplaceRules(raw: unknown): ReplaceRule[] {
    if (!Array.isArray(raw)) {
        throw new DataError('替换规则必须是一个数组', 400, 'invalid_replace_rules')
    }
    if (raw.length > MAX_REPLACE_RULES) {
        throw new DataError(
            `替换规则最多 ${MAX_REPLACE_RULES} 条，收到 ${raw.length} 条`,
            400,
            'too_many_replace_rules',
        )
    }
    return raw.map((item, index) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            throw new DataError(
                `第 ${index + 1} 条替换规则不是一个对象`,
                400,
                'invalid_replace_rules',
            )
        }
        const rule = item as Record<string, unknown>
        return {
            name: str(rule.name, 200),
            group: str(rule.group, 200) || '默认',
            pattern: str(rule.pattern),
            replacement: str(rule.replacement),
            // 只有显式写 false 才算停用（与前端 `makeRule` 的默认一致）
            enabled: rule.enabled !== false,
        }
    })
}

/** 读一份规则。从未同步过的账号得到空的一份，而不是报错 */
export async function readReplaceRules(
    db: D1Database,
    user: Pick<AccountUser, 'id'>,
): Promise<StoredReplaceRules> {
    const row = await db
        .prepare('SELECT rules, updated_at FROM replace_rules WHERE owner = ?')
        .bind(ownerForUser(user))
        .first<Record<string, unknown>>()
    if (!row) return EMPTY_REPLACE_RULES

    let parsed: unknown = []
    try {
        parsed = JSON.parse(String(row.rules ?? '[]'))
    } catch {
        // 库里那一行坏了：**说清楚**，而不是当成空规则 —— 当成空的话，
        // 用户一上传就把自己仅有的那份覆盖掉了
        throw new DataError('服务端保存的替换规则不是合法 JSON', 500, 'replace_rules_corrupt')
    }
    return {
        rules: parseReplaceRules(parsed),
        updatedAt: Number(row.updated_at ?? 0),
    }
}

/** 写入的结果：成功给出新的时间戳，冲突时把服务端那份一并回给客户端 */
export type WriteOutcome =
    { kind: 'saved'; updatedAt: number } | { kind: 'conflict'; server: StoredReplaceRules }

/**
 * 写一份规则，带**冲突检测**
 *
 * 客户端要带 `baseUpdatedAt`：它这份规则是基于服务端哪个版本改的。
 * 与服务端当前时间对不上，就说明**另一台设备在这之间动过**，这时不写，
 * 而是把服务端现在那份交给客户端，由用户决定「取回」还是「我就是要覆盖」。
 *
 * 为什么不做「最后写入者胜」：那等于**安静地丢掉另一台设备上的编辑**。
 * 规则是手写的正则，几十条一条条补回来很贵，而「同步成功」的提示会让用户
 * 以为两边一致了 —— 这类错一旦发生，用户甚至不知道丢了什么。
 *
 * 覆盖的口子留着：用户看过服务端那份之后，拿它的 `updatedAt` 当基准再传一次即可，
 * 不需要什么「强制」标志位（见前端那个卡片的两步提示）。
 */
export async function writeReplaceRules(
    db: D1Database,
    user: Pick<AccountUser, 'id'>,
    rules: ReplaceRule[],
    baseUpdatedAt: number,
): Promise<WriteOutcome> {
    const owner = ownerForUser(user)
    const current = await readReplaceRules(db, user)
    if (current.updatedAt !== Number(baseUpdatedAt ?? 0)) {
        return { kind: 'conflict', server: current }
    }

    // 时间戳取「当前毫秒」，与基准撞车时 +1：撞了就还是「没变」，
    // 下一次冲突检测会误判成同一版本
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1)
    await db
        .prepare(
            `INSERT INTO replace_rules (owner, rules, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(owner) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`,
        )
        .bind(owner, JSON.stringify(rules), updatedAt)
        .run()
    return { kind: 'saved', updatedAt }
}
