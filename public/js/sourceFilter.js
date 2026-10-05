/*
 * 书源清单的**分组与筛选**（纯函数）
 *
 * 为什么单独一个文件：线上那份语料 816 条书源，而「书源」页原本是一个**平铺的长列表** ——
 * 找一条要么一直滚，要么肉眼扫。选书源的地方（发现页那个下拉、搜索页的「搜索范围」）
 * 也是平铺的。三处要的是同一套判据，所以收在这里，三处共用、也能在 Node 里单测。
 *
 * 一个关键事实：**分组字段是多值的**。线上按 `json_extract` 数出来长这样：
 *
 *     通常书源 📂,快速书源 ⚡  242 条     快速书源 ⚡,通常书源 📂  227 条
 *     特殊书源 🔞               128 条     漫画书源 🎨,特殊书源 🔞   23 条
 *     ……                        还有 26 条一个标签都没有
 *
 * 也就是说 `bookSourceGroup` 是**标签串**而不是目录名，一个源能挂好几个（逗号分隔）。
 * 由此定下两条规矩，缺哪条都会出问题：
 *
 * 1. **归组（以及按分组筛）只认第一个标签**（`primaryGroup`）—— 列表要的是「一源一行」。
 *    若按标签展开，那两个 200+ 的大组会让**同一个源出现两次**，每份还各带一个启用开关，
 *    界面看着像重了一份。
 * 2. **关键词匹配名字与全部标签** —— 想找「挂了快速书源这个标的源，不管它归在哪儿」，
 *    在搜索框里输「快速书源」就行。其余标签也作为徽章显示在每一行上（见 `sourceRowNode`），
 *    信息一点没丢。
 *
 * 「只认第一个标签」这条是**量出来之后改的**：一开始按标签筛、按第一个标签归组，
 * 于是分组下拉里写着「通常书源 📂 227」，选中它却出来 363 条（另外 136 条的
 * 第一个标签是「快速书源」）。同一个名字两处两个数，比少一种筛法糟得多 ——
 * 所以改成「下拉里的条数就是选中之后的条数」。
 *
 * 判据（名字 / 分组、去空白、不区分大小写）与 `searchPlan.js` 曾经那份是同一套 ——
 * 现在那个函数已经删掉，只剩这里一份实现。
 */

/** 分组分隔符：语料里是半角逗号；全角逗号与顿号一并认了（别处的合集里出现过） */
const GROUP_SEP = /[,，、]/

/** 「全部分组」这一档的取值。用 `*` 是因为它不可能和真实的分组名撞上 */
export const GROUP_ALL = '*'

/** 「未分组」这一档的取值：空串。`group` 为空串的源归在这里 */
export const GROUP_NONE = ''

/** 状态档：全部 / 只留启用 / 只留停用 */
export const STATUS_ALL = 'all'
export const STATUS_ON = 'on'
export const STATUS_OFF = 'off'

/** 能力档：全部 / 能搜 / 能发现 / 能登录 */
export const ABILITY_ALL = 'all'
export const ABILITY_SEARCH = 'search'
export const ABILITY_EXPLORE = 'explore'
export const ABILITY_LOGIN = 'login'

/** 一个筛选项都没设的原样 */
export const DEFAULT_FILTER = {
    keyword: '',
    group: GROUP_ALL,
    status: STATUS_ALL,
    ability: ABILITY_ALL,
}

/** 把 `bookSourceGroup` 拆成标签数组（去空白、丢掉空档） */
export function splitGroups(value) {
    return String(value ?? '')
        .split(GROUP_SEP)
        .map((one) => one.trim())
        .filter((one) => one !== '')
}

/** 这个源归到哪一组：第一个标签；一个标签都没有就是「未分组」 */
export function primaryGroup(source) {
    return splitGroups(source?.group)[0] ?? GROUP_NONE
}

/** 分组在界面上显示成什么（`''` 得有个人话的名字） */
export const groupLabel = (name) => (name === GROUP_NONE ? '未分组' : String(name))

/**
 * 按条件筛
 *
 * 返回的是一个**新数组**，顺序保持调用方给的顺序（`/api/sources` 是按导入顺序/名字排好的，
 * 重排会让「上次看到哪儿」失效）。
 */
export function filterSources(sources, options = {}) {
    const list = Array.isArray(sources) ? sources : []
    const needle = String(options.keyword ?? '')
        .trim()
        .toLowerCase()
    const wanted = String(options.group ?? GROUP_ALL)
    const status = String(options.status ?? STATUS_ALL)
    const ability = String(options.ability ?? ABILITY_ALL)

    return list.filter((one) => {
        if (!one) return false

        if (status === STATUS_ON && one.enabled !== true) return false
        if (status === STATUS_OFF && one.enabled === true) return false

        if (ability === ABILITY_SEARCH && one.hasSearch !== true) return false
        if (ability === ABILITY_EXPLORE && one.hasExplore !== true) return false
        if (ability === ABILITY_LOGIN && one.hasLogin !== true) return false

        // 按分组筛看的是**归到哪一组**（第一个标签），与列表和下拉里的条数同一套口径。
        // 「未分组」正好是 `primaryGroup` 返回空串的那一档，所以这里不必分开判。
        if (wanted !== GROUP_ALL && primaryGroup(one) !== wanted) return false

        if (needle !== '') {
            // 关键词这一侧反过来：**所有**标签都参与（想找「挂了某标签的源」靠它）
            const name = String(one.name ?? '').toLowerCase()
            const group = String(one.group ?? '').toLowerCase()
            if (!name.includes(needle) && !group.includes(needle)) return false
        }

        return true
    })
}

/** 按 `primaryGroup` 归拢成 `[{ name, items }]`；条数多的在前，「未分组」永远在最后 */
function bucketize(list) {
    const buckets = new Map()
    for (const one of list) {
        const key = primaryGroup(one)
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key).push(one)
    }
    return [...buckets.entries()]
        .map(([name, items]) => ({ name, items }))
        .sort((a, b) => {
            if (a.name === GROUP_NONE) return 1
            if (b.name === GROUP_NONE) return -1
            if (b.items.length !== a.items.length) return b.items.length - a.items.length
            return a.name.localeCompare(b.name, 'zh')
        })
}

/**
 * `<select>` 用的分组清单
 *
 * 必须拿**未筛选**的那一份来算：跟着关键词算的话，每敲一个字下拉里的条数就变一次，
 * 用户刚记住的那个「快速书源 136」下一秒成了 3。
 *
 * 条数就是「选中它之后会出来多少条」—— 与列表里每一个分组头的条数也对得上
 * （两者都是按 `primaryGroup` 算的）。
 */
export function groupOptions(sources) {
    return bucketize((Array.isArray(sources) ? sources : []).filter(Boolean)).map(
        ({ name, items }) => ({
            name,
            count: items.length,
        }),
    )
}

/**
 * 筛 + 归组：列表渲染要的就是这个
 *
 * 指定了某一组时只出一个分组头，头名就是它 —— 内容与下拉里的条数一致。
 */
export function groupSources(sources, options = {}) {
    const matched = filterSources(sources, options)
    const wanted = String(options.group ?? GROUP_ALL)
    if (wanted !== GROUP_ALL) return [{ name: wanted, items: matched }]
    return bucketize(matched)
}

/** 各档的条数（页头那句话、以及档位按钮上的数字） */
export function tally(sources) {
    const out = { total: 0, on: 0, off: 0, search: 0, explore: 0, login: 0 }
    for (const one of Array.isArray(sources) ? sources : []) {
        if (!one) continue
        out.total += 1
        if (one.enabled === true) out.on += 1
        else out.off += 1
        if (one.hasSearch === true) out.search += 1
        if (one.hasExplore === true) out.explore += 1
        if (one.hasLogin === true) out.login += 1
    }
    return out
}

/** 现在有没有真的在筛 —— 决定页头说「筛出 N 条」还是「共 N 条」 */
export function isFiltering(options = {}) {
    return (
        String(options.keyword ?? '').trim() !== '' ||
        String(options.group ?? GROUP_ALL) !== GROUP_ALL ||
        String(options.status ?? STATUS_ALL) !== STATUS_ALL ||
        String(options.ability ?? ABILITY_ALL) !== ABILITY_ALL
    )
}

/**
 * 能改「启用 / 停用」的那一份 id
 *
 * 内置测试源是**只读**的（它们是代码的一部分，库里没有对应行，服务端 `assertUserSource`
 * 也会拒），一并送去只会让整批回一个 400 —— 一条坏 id 拖垮一次批量操作。
 */
export function mutableIds(sources) {
    return (Array.isArray(sources) ? sources : [])
        .filter((one) => one && one.builtin !== true)
        .map((one) => String(one.id))
}
