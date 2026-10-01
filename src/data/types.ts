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

/**
 * 书架条目与阅读进度共用的主键：书源 id + 换行 + 书籍地址。
 *
 * 用换行分隔而不是 `|` 或 `:`：书籍地址里这两种字符都常见，
 * 而 URL 与书源 id 里都不可能带裸换行，所以这个分隔符是安全的。
 * 键是字符串而不是自增数字，是为了让「同一个源里的同一本书」天然幂等 ——
 * 重复加入书架等于更新，不需要先去查一遍有没有。
 */
export function bookKey(sourceId: string, bookUrl: string): string {
    return `${sourceId}\n${bookUrl}`
}

/**
 * 数据层错误。带上 HTTP 状态与机器可读的 code，
 * 路由层不必再猜「这算 400 还是 500」，前端也能按 code 分支处理。
 */
export class DataError extends Error {
    readonly status: number
    readonly code: string

    constructor(message: string, status = 400, code = 'invalid_input') {
        super(message)
        this.name = 'DataError'
        this.status = status
        this.code = code
    }
}
