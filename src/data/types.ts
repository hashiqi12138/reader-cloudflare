/**
 * 数据层的公共类型
 *
 * 单独成一个文件，是为了让 `sources.ts`（内置书源定义 + 注册表）和 `db.ts`（D1 读写）
 * 各自只依赖它，而不是互相 import —— 后者在打包后容易出现难以定位的初始化顺序问题。
 */

import type { BookSource } from '../engine/types'

/** 一条已注册的书源：书源本体 + 由存储层赋予的身份 */
export interface RegisteredSource extends BookSource {
    /** 稳定标识。内置源用 `builtin:` 前缀，用户导入的用 `user:` 前缀 */
    id: string
    /** 内置源不可删除、不可停用，也不进用户的书源管理列表 */
    builtin: boolean
    /** 展示顺序，内置源恒在最前 */
    sortOrder?: number
}

/**
 * 用户导入书源的 id 前缀。
 *
 * 用户在书源管理里看到的永远是这一串（而不是站点地址）——
 * 站点地址会变、可能带查询串，直接拿来当主键会在导入第二次时变成两条。
 */
export const USER_ID_PREFIX = 'user:'

/** 内置书源 id 前缀 */
export const BUILTIN_ID_PREFIX = 'builtin:'

/** 用户书源的 id 由站点地址派生，因此同一个站点重复导入是「更新」而不是「新增」 */
export function userIdForUrl(url: string): string {
    return USER_ID_PREFIX + url
}
