/*
 * 替换净化规则
 *
 * 对应开源阅读（Legado）的「替换净化」：用户自己写一批正则，把正文里不想要的东西
 * 去掉 —— 站点广告、推广行、网址、分隔符、作者的话。书源里的 `replaceRegex` 是
 * **书源作者**写死的；这一层是**读者**自己加的，两者互不干扰。
 *
 * 为什么放在浏览器端而不是服务端
 * ----------------------------
 * 规则是读者的私人格式偏好，改一条就该立刻看到效果。放服务端意味着
 * 「改规则 → 存库 → 重新拉正文 → 重新分页」，而这里改完只需重排一次当前章节。
 * 代价是不跨设备同步 —— 与主题、字号这些阅读偏好一致，可以接受。
 *
 * 规则的形状对齐 Legado：`{ name, group, pattern, replacement, enabled }`，
 * `pattern` 是正则源码。为了对普通用户友好，**填的不是合法正则时按纯文本替换**，
 * 而不是报错 —— 「把『广告』这两个字删掉」是最常见的用法，不该逼人写转义。
 */

const STORAGE_KEY = 'pref.replaceRules'

/** 一条替换规则 */
export function makeRule(partial = {}) {
    return {
        name: String(partial.name ?? ''),
        group: String(partial.group ?? '默认'),
        pattern: String(partial.pattern ?? ''),
        replacement: String(partial.replacement ?? ''),
        enabled: partial.enabled !== false,
    }
}

/** 内置的几条常用规则，用户一键添加，省得从零写正则 */
export const PRESET_RULES = [
    {
        name: '去掉「本站网址」类推广',
        group: '通用',
        pattern: '(?:本书首发|首发于|更多精彩|请记住本站|最新章节请?访问)[^\\n]{0,40}',
        replacement: '',
    },
    { name: '去掉网址', group: '通用', pattern: 'https?://[^\\s，。、）)】]+', replacement: '' },
    {
        name: '去掉「手机阅读」提示',
        group: '通用',
        pattern: '(?:手机|移动端)(?:用户)?(?:请)?(?:访问|阅读|打开)[^\\n]{0,30}',
        replacement: '',
    },
    { name: '去掉广告分隔符行', group: '通用', pattern: '^[=\\-*~_—]{4,}$', replacement: '' },
    {
        name: '去掉方括号广告',
        group: '通用',
        pattern: '【[^】]{0,20}(?:广告|推广|订阅|微信|公众号)[^】]{0,20}】',
        replacement: '',
    },
    { name: '去掉全角空白', group: '排版', pattern: '[\\u3000]+', replacement: ' ' },
    // 注意这里要是**真的换行**，不是 `\n` 两个字符：`String.replace` 的字符串替换
    // 不解析转义，写成 '\\n' 会往正文里插入一个反斜杠加 n
    { name: '去掉空行', group: '排版', pattern: '\\n{2,}', replacement: '\n' },
    { name: '去掉行首缩进空格', group: '排版', pattern: '^[ \\t]+', replacement: '' },
]

export function loadRules() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.map(makeRule).filter((rule) => rule.pattern !== '')
    } catch {
        return []
    }
}

export function saveRules(rules) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules.map(makeRule)))
}

/**
 * 编译一条规则
 *
 * 正则可以带 `##flags` 后缀（对齐 Legado 的写法，方便用户写 `\d+##g`）。
 * 不给 flags 时默认 `g`（要替换所有出现），并额外加 `m` 让 `^`/`$` 按行生效 ——
 * 「去掉空行」「去掉行首缩进」这类规则没有 `m` 就完全不工作，
 * 而用户不会想到要自己加。
 */
export function compile(rule) {
    const source = rule.pattern
    if (source === '') return null

    const at = source.lastIndexOf('##')
    const hasFlags = at > 0 && /^[gimsuy]*$/.test(source.slice(at + 2))
    const body = hasFlags ? source.slice(0, at) : source

    let flags = hasFlags ? source.slice(at + 2) : 'g'
    if (!flags.includes('g')) flags += 'g'
    if (!flags.includes('m')) flags += 'm'

    try {
        return new RegExp(body, flags)
    } catch {
        // 不是合法正则：按纯文本替换。用户写「广告」两个字是常规用法，
        // 为此报错只会让人以为功能坏了。
        return { literal: body, replacement: rule.replacement }
    }
}

/**
 * 应用全部启用的规则
 *
 * 顺序执行而不是合并成一条大正则：规则之间是有意排序的
 * （先删广告行、再压缩空行，反过来会剩下一条空行），合并就丢掉了这个顺序。
 */
export function applyRules(text, rules) {
    let out = String(text ?? '')
    for (const rule of rules) {
        if (!rule.enabled) continue
        const compiled = compile(rule)
        if (!compiled) continue
        if (compiled instanceof RegExp) out = out.replace(compiled, rule.replacement)
        else out = out.split(compiled.literal).join(rule.replacement)
    }
    return out
}

/** 统计每条规则各改动了多少处，用于设置界面里的「测试」 */
export function testRules(text, rules) {
    return rules.map((rule) => {
        const compiled = rule.enabled ? compile(rule) : null
        let hits = 0
        if (compiled instanceof RegExp) {
            const matches = String(text ?? '').match(compiled)
            hits = matches ? matches.length : 0
        } else if (compiled) {
            hits = String(text ?? '').split(compiled.literal).length - 1
        }
        return { rule, hits }
    })
}
