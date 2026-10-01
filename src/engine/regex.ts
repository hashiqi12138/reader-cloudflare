/**
 * Legado 的 `##正则##替换` 链
 *
 * 三种形态，语义不同，不能混为一谈：
 *
 * | 形态 | 名称 | 语义 |
 * |---|---|---|
 * | `##正则##替换` | 净化 | **循环**匹配并全部替换 |
 * | `##正则##替换###` | OnlyOne | 只取**第一个**匹配并替换 |
 * | 以 `:` 开头 | AllInOne | 整块用正则切分，只用于列表规则 |
 *
 * 转义：正则里如果本身要写 `#`，用 `@#` 代替。
 */

export interface RegexOp {
    pattern: string
    replacement: string
    /** true 表示 OnlyOne（只处理第一个匹配） */
    onlyOne: boolean
}

/** 把 `@#` / `@@` 换成占位符，避免切分时被误当成分隔符 */
function protectEscapes(raw: string): string {
    return raw.replace(/@#/g, '\u0000').replace(/@@/g, '\u0001')
}

/** 还原占位符 */
function restoreEscapes(raw: string): string {
    return raw.replace(/\u0000/g, '#').replace(/\u0001/g, '@')
}

/**
 * 从规则里剥出 `##正则##替换` 链
 *
 * 按 `##` 切分后**成对**读取，而不是用「贪婪匹配尾部」的方式：后者在
 * `##A##B##C##D` 这种多段链上会给出 `A → "B##C##D"` 这种明显错误的解析，
 * 而按对读取得到的是 (A→B)、(C→D)，这才是 `##` 作为分隔符的本意。
 *
 * 结尾的 `###` 表示该条规则是 OnlyOne（只替换第一个匹配）——
 * 按 `##` 切分后它会在末尾多出一个孤立的 `#`，据此识别。
 */
export function splitRegexChain(rule: string): { selector: string; ops: RegexOp[] } {
    const parts = protectEscapes(rule).split('##')
    const selector = restoreEscapes(parts[0] ?? '')

    const rest = parts.slice(1)
    let onlyOneForLast = false
    if (rest.length > 0 && rest[rest.length - 1] === '#') {
        onlyOneForLast = true
        rest.pop()
    }

    const ops: RegexOp[] = []
    for (let i = 0; i < rest.length; i += 2) {
        const isLast = i + 2 >= rest.length
        ops.push({
            pattern: restoreEscapes(rest[i] ?? ''),
            replacement: restoreEscapes(rest[i + 1] ?? ''),
            onlyOne: isLast && onlyOneForLast,
        })
    }

    return { selector, ops }
}

/** 对一段文本套用正则链 */
export function applyRegexOps(input: string, ops: RegexOp[]): string {
    let out = input
    for (const op of ops) {
        let re: RegExp
        try {
            re = new RegExp(op.pattern, op.onlyOne ? '' : 'g')
        } catch {
            // 单个书源里的正则写坏了，不该让整次搜索失败：跳过它并保留原文
            continue
        }
        out = op.onlyOne ? out.replace(re, op.replacement) : out.replace(re, op.replacement)
    }
    return out
}

/**
 * AllInOne 正则：以 `:` 开头，把整段内容按正则切成列表。
 *
 * 只用于列表规则（搜索列表、发现列表、目录列表）。切完后，
 * 结果列表里的每一项再各自套用后续的取值规则。
 */
export function applyAllInOne(source: string, rule: string): string[] {
    const body = rule.slice(1)
    const { selector: pattern, ops } = splitRegexChain(body)
    if (!pattern) return []
    let re: RegExp
    try {
        // 强制全局 + 多行：AllInOne 的用法就是「一刀切全部」
        re = new RegExp(pattern, 'gm')
    } catch {
        return []
    }
    const out: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
        let value = m.length > 1 ? (m[1] ?? '') : m[0]
        value = applyRegexOps(value, ops)
        out.push(value.trim())
        // 零宽匹配会死循环，必须手动推进
        if (m.index === re.lastIndex) re.lastIndex++
    }
    return out.filter((s) => s !== '')
}
