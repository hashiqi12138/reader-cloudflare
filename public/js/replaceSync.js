/*
 * 替换净化规则的账号同步（浏览器这一半）
 *
 * 规则本身存在本机（`localStorage`，见 replace.js）—— 改一条立刻重排当前章节，
 * 这是它放在这一层的原因。代价是换设备就没了，于是补上这一环：
 * 把整份规则搬到账号上，新设备取回来。
 *
 * 四件值得说明的事：
 *
 * 1. **两个动作，用户按下才动**：上传 / 取回。**不自动同步** ——
 *    自动同步意味着某个时刻要决定「谁覆盖谁」，而那个时刻对用户是不可见的。
 * 2. **不「最后写入者胜」**。上传要带 `baseUpdatedAt`（本机上次看到服务端的哪个版本），
 *    服务端对不上就回 409 并把现在那份附在响应体里（见 `src/data/replaceRules.ts`），
 *    界面上把它摊开给用户看，由用户选「取回」还是「我就是要覆盖」。
 *    安静地覆盖另一次编辑，是这类功能里最贵的错。
 * 3. **基准时间戳存在本机**（`pref.replaceRules.syncedAt`），不跟着账号走 ——
 *    它说的是「这台机器上次看到服务端的哪个版本」，本来就是每台设备各一份。
 * 4. **接口失败时把响应体挂到 error 上**（`core.js` 的 `api()` 做的），
 *    409 里的服务端那份就靠它带出来。
 *
 * 纯逻辑（`describeRules` / `syncState`）单独拆出来，是因为这几行决定界面上说哪句话，
 * 而「说得对不对」不靠点开界面才发现。
 */

import { api } from './core.js'
import { makeRule } from './replace.js'

/** 本机上次看到的服务端版本。0 表示还没同步过 */
const BASE_KEY = 'pref.replaceRules.syncedAt'

export function loadSyncBase() {
    const value = Number(localStorage.getItem(BASE_KEY))
    return Number.isFinite(value) && value > 0 ? value : 0
}

export function saveSyncBase(updatedAt) {
    const value = Number(updatedAt)
    // 服务端从 0 开始递增，写回 0 等于「回到没同步过」，那不是个能取回的状态
    if (Number.isFinite(value) && value > 0) localStorage.setItem(BASE_KEY, String(value))
    else localStorage.removeItem(BASE_KEY)
}

/**
 * 「12 条（停用 3 条）」
 *
 * 停用条数要带上：本机和账号两份规则条数一样、但启用状态不同，
 * 只看条数会得出「一模一样」的错误结论。
 */
export function describeRules(rules) {
    const list = Array.isArray(rules) ? rules.filter(Boolean) : []
    if (list.length === 0) return '一条都没有'
    const off = list.filter((rule) => rule.enabled === false).length
    return off > 0 ? `${list.length} 条（停用 ${off} 条）` : `${list.length} 条`
}

/**
 * 本机与账号两份现在是什么关系
 *
 * - `remote-empty`：账号上还没有这份规则（从没上传过）—— 新设备上取不到东西，
 *   要提示「先在本机上传」，而不是让用户以为同步坏了
 * - `same-version`：账号自本机上次同步后没动过 —— 直接上传是安全的
 * - `moved`：账号动过（多半是另一台设备上传的）—— 上传前要让用户先看一眼
 *
 * 判断只靠时间戳，不比对规则内容：内容是用户的，改一个空格也是改，
 * 与其猜「这算不算变了」，不如让用户自己看。
 */
export function syncState(remote, base) {
    const server = remote ?? { rules: [], updatedAt: 0 }
    const updatedAt = Number(server.updatedAt ?? 0)
    if (updatedAt === 0) return 'remote-empty'
    return updatedAt === Number(base ?? 0) ? 'same-version' : 'moved'
}

/** 读账号上那一份。没同步过也会正常返回 `{rules: [], updatedAt: 0}` */
export async function fetchRemoteRules() {
    const data = await api('/api/replace')
    const rules = Array.isArray(data?.rules) ? data.rules.map(makeRule) : []
    return { rules, updatedAt: Number(data?.updatedAt ?? 0) }
}

/**
 * 上传本机这一份
 *
 * 抛出的错误里，`code === 'replace_rules_conflict'` 的那一种带 `body.server`，
 * 调用方应当把选择权交给用户，而不是自己决定覆盖。
 */
export async function pushRemoteRules(rules, baseUpdatedAt) {
    const list = (Array.isArray(rules) ? rules : []).map(makeRule)
    return api('/api/replace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: list, baseUpdatedAt: Number(baseUpdatedAt) || 0 }),
    })
}
