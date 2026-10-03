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

import { splitRuleText } from './ruleText'

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
    // 切 `##` 时跳过 `@js:` 后面那段代码（`@js:代码##正则##替换` 里的第一个 `##`
    // 才是净化链的起点，代码里引号内的 `##` 不算），但**不跳 `<js>` 块**：
    // `<js>##正则##</js>` 是书源里合法的净化写法。
    const protectedRule = protectEscapes(rule)
    const parts = splitRuleText(protectedRule, '##', {
        skipJsBlocks: false,
        skipQuotes: false,
    }) ?? [protectedRule]
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

/**
 * 对一段文本套用正则链
 *
 * 两种语义（对应 `##正则##替换` 与 `##正则##替换###`）：
 *
 *   - **净化**（无 `###`）：循环匹配、**全部替换**，结果还是整段文本。
 *     用途是把正文里的广告、字数统计、翻页提示洗掉（线上 392 处），
 *     值本身不变，只是其中若干段被换掉。
 *   - **取值**（`###`，OnlyOne）：**只取第一个匹配**，结果就是那一段，
 *     替换只作用在它自己身上。
 *
 * 第二种以前实现成了「整段文本里替换第一个匹配」—— 结果仍是**整段文本**，
 * 于是取值类规则全都拿到一段没用的长文本：
 *
 *   `a.0@href` 的值是 `/book/12345.html`，规则是
 *   `##.+\D((\d+)\d{3})\D##/files/article/image/$2/$1/$1s.jpg###`，
 *   想要的是 `/files/article/image/12/12345/12345s.jpg`；
 *   按「整段替换」会得到 `/book//files/article/image/12/12345/12345s.jpg.html`。
 *   这个封面写法线上有十几个源在用（黄易、若雨中文、万象书城、棉花糖 …），
 *   另外 `##isvip##🔒###`（isVip 字段）按整段替换会等于**整页**。
 *
 * 没匹配到就取不到东西 → 空串。与 AllInOne（匹配不到就不产出）一致；
 * 不返回原文，是因为「取第一个匹配」这件事本身没成功，返回原文等于给一个假值。
 */
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
        if (!op.onlyOne) {
            out = out.replace(re, op.replacement)
            continue
        }
        const match = re.exec(out)
        out = match === null ? '' : match[0].replace(re, op.replacement)
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
