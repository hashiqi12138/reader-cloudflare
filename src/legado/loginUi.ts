/**
 * `loginUi` 的解析与归一（纯函数）
 *
 * `loginUi` 是书源自己写的一段 **JSON / JS**，描述「登录界面上有哪些控件」。
 * 官方文档「认证与登录」只写明了三种 `type`（`text` / `password` / `button`），
 * 但语料 35 条里实际出现的 `type` 有六种：
 *
 *   button 159 / text 40 / password 20 / **toggle 8** / **select 7** / input 1
 *
 * `select` 与 `toggle` 都带 `chars`（候选值）与 `default`（默认选中），
 * 例：`{ name:"线路", type:"select", chars:["https://a","https://b"], default:"https://a" }`、
 * `{ name:"段评开关", type:"toggle", chars:["🔳","✅"], default:"🔳" }`。
 * 所以这里**按「有没有 chars」判断要不要渲染成下拉**，而不是按 type 硬编码 ——
 * `toggle` 的语义文档里没写，但 8 处全是「两个图标二选一」，当下拉处理是如实的。
 *
 * 形态上，语料里只有 18/35 是**严格 JSON**，另外 17 条得进沙箱求值：
 *
 *   裸 JSON 数组         18   [{"name":"账号","type":"text"}, …]
 *   前缀 @js:             8   @js: var all=[]; all.push({…}); result=JSON.stringify(all)
 *   以 [ 开头但不是 JSON   8   [ { name:"账号", type:"text" }, … ]（键没加引号）
 *   包在 <js> 里          1   <js>JSON.stringify([{name:'…',type:'button',action:'…'}])</js>
 *
 * 所以调用方（`src/index.ts`）的策略是**先试 JSON.parse，失败再进沙箱**，
 * 而沙箱那条路要处理「值挂在 `result` 上而不是完成值」的情况 —— 这里只负责
 * 把**已经求值出来的东西**归一成表单定义，不碰沙箱。
 */

/** 控件类型：`select` 是「有 chars 的任意 type」（含 toggle）归出来的结果 */
export type LoginFieldType = 'text' | 'password' | 'select'

export interface LoginField {
    name: string
    type: LoginFieldType
    /** 有候选值就是下拉（`select` / `toggle` 都走这里） */
    chars?: string[]
    /** 默认选中项（语料里 `default` 与 `chars` 成对出现） */
    default?: string
    /** 原样保留 type，未知的那些（`toggle` / `input`）前端可以照实显示 */
    rawType: string
}

export interface LoginButton {
    name: string
    /**
     * 点了要执行的动作。语料里 163 处是**函数名**（`jmDoLogin()` / `checkSite()` /
     * `saveCommentSetting(`），4 处是 http 地址，4 处是空串（纯说明牌）
     */
    action: string
    /** action 是 http 地址时给出，前端直接新开标签页 */
    url?: string
}

export interface LoginForm {
    fields: LoginField[]
    buttons: LoginButton[]
    /** 解析不出任何控件时留一句原样文本，至少让人看得到书源写了什么 */
    note?: string
}

/** 空表单（也算「解析得出，只是一条也没有」） */
export const EMPTY_LOGIN_FORM: LoginForm = { fields: [], buttons: [] }

const asString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined

/** 把 `chars` 归一成字符串数组（语料里都是字符串，防一手数字） */
function asChars(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const out = value.map((one) => asString(one)).filter((one): one is string => one !== undefined)
    return out.length > 0 ? out : undefined
}

/**
 * 把 `loginUi` 求值出来的**原始值**归一成表单定义
 *
 * 入参可以是：数组（裸 JSON / 沙箱完成值）、JSON 字符串（`JSON.stringify(...)` 那条路）、
 * 或者任何别的东西（那就只留下 `note`）。
 */
export function normalizeLoginForm(value: unknown): LoginForm {
    let list: unknown = value

    // 沙箱那条路常见「把 JSON 字符串挂在 result 上」，先剥一层
    if (typeof list === 'string') {
        const text = list.trim()
        if (text === '') return { ...EMPTY_LOGIN_FORM }
        try {
            list = JSON.parse(text)
        } catch {
            return { ...EMPTY_LOGIN_FORM, note: text.slice(0, 400) }
        }
    }

    if (!Array.isArray(list)) {
        if (list === undefined || list === null) return { ...EMPTY_LOGIN_FORM }
        return { ...EMPTY_LOGIN_FORM, note: JSON.stringify(list)?.slice(0, 400) ?? '' }
    }

    const fields: LoginField[] = []
    const buttons: LoginButton[] = []

    for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const box = item as Record<string, unknown>
        const name = asString(box.name)
        // 语料里每条都有 name；没有的既渲染不出标签、也读不到值，直接跳过
        if (name === undefined || name.trim() === '') continue

        const rawType = (asString(box.type) ?? '').trim().toLowerCase() || 'text'
        const action = asString(box.action) ?? ''

        if (rawType === 'button') {
            const button: LoginButton = { name, action }
            // http 地址的按钮在 App 里是「打开浏览器」，给前端一个明确的 url
            if (/^https?:\/\//i.test(action)) button.url = action
            buttons.push(button)
            continue
        }

        const chars = asChars(box.chars)
        const def = asString(box.default)
        const field: LoginField = {
            name,
            // 有候选值 → 下拉（`select` / `toggle` 都在这里汇合）；否则按密码/文本
            type: chars ? 'select' : rawType === 'password' ? 'password' : 'text',
            rawType,
        }
        if (chars) {
            field.chars = chars
            // 默认项必须真的在候选里，否则前端会选中一个不存在的值
            if (def !== undefined && chars.includes(def)) field.default = def
        }
        fields.push(field)
    }

    return { fields, buttons }
}

/**
 * 先按 JSON 解 `loginUi` 的原文（18/35 条命中），解不出来返回 `undefined` 交给沙箱
 *
 * 走这条快路的意义不只是省一次沙箱求值：严格 JSON 的那些源**不需要**沙箱，
 * 所以「只是看一眼登录表单」不会因为源里有奇怪的脚本而失败。
 */
export function parseLoginUiJson(text: string | undefined | null): LoginForm | undefined {
    const raw = String(text ?? '').trim()
    if (raw === '') return undefined
    try {
        return normalizeLoginForm(JSON.parse(raw))
    } catch {
        return undefined
    }
}
