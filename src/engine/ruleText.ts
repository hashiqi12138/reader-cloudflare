/**
 * 规则文本的结构扫描：哪些位置**不该被当作分隔符**
 *
 * 规则里有两类内容，混在一起切会把规则切碎；而切开之后每一块看起来都「合法」，
 * 只是结果全不对 —— 报错信息还会指向切开后的半截规则，把人引到错误的方向。
 *
 *   1. **JS**：`@js:代码` 与 `<js>代码</js>` 里的 `&&` / `||` / `%%` 是 JS 的运算符，
 *      不是规则的同级连接符。线上 816 条书源里有 **303 处**规则同时含 JS 与连接符，
 *      其中三种形态都会被切碎：整条是 `@js:`、连接符在 `<js>` 块内、`选择器@js:代码`。
 *   2. **方括号与引号**：`$.list[?(@.a&&@.b)]` 里的 `&&` 是 JSONPath 的与，
 *      `@js:"a||b"` 里的 `||` 是字符串内容。
 *
 * 单独成模块的原因和 `template.ts` 一样：它是纯函数，可以直接做单元测试；
 * 而用到它的 `analyze.ts` 会连带引入沙箱，Node 里跑不起来。
 */

// `<js>` 块与 `@js:` 标记的匹配放在 directives.ts，与其余四处共用一个源：
// 各写一遍就会出现「切连接符时当它是 JS、别处不认」这种自相矛盾
import { indexOfJsMarker, JS_BLOCK, JS_MARKER } from './directives'

/** 一段 JS 在规则里的位置（start 含、end 不含） */
export interface JsRegion {
    start: number
    end: number
    /** true 表示 `<js>...</js>` 块；false 表示 `@js:` 标记后面那一段 */
    block: boolean
}

/**
 * 找出 `@js:` 后面那段代码的结束位置
 *
 * 结束在**第一个不在引号里的 `##`**：书源里 `@js:代码##正则##替换` 是常见写法
 * （线上 291 条 `选择器@js:` 的规则里有 22 条带这种净化链），
 * 所以代码不能一路吃到规则末尾。
 *
 * 只看引号、不数括号层级：JS 里的括号在规则文本里未必配平（书源常写半截表达式），
 * 少认一个 `##` 的代价是「净化链失效」，而多认一个的代价是「把代码切碎」——
 * 后者更难查。
 */
function jsCodeEnd(rule: string, start: number): number {
    let quote = ''
    for (let i = start; i < rule.length; i += 1) {
        const ch = rule[i]!

        if (quote !== '') {
            if (ch === '\\') {
                i += 1
                continue
            }
            if (ch === quote) quote = ''
            continue
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch
            continue
        }
        if (rule.startsWith('##', i)) return i
    }
    return rule.length
}

/** 找出规则里所有的 JS 区域，按位置排序 */
export function findJsRegions(rule: string): JsRegion[] {
    const regions: JsRegion[] = []

    JS_BLOCK.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = JS_BLOCK.exec(rule)) !== null) {
        regions.push({ start: match.index, end: match.index + match[0].length, block: true })
        // 零宽匹配会死循环
        if (match[0].length === 0) JS_BLOCK.lastIndex += 1
    }

    const insideRegion = (at: number): boolean => regions.some((r) => at >= r.start && at < r.end)

    let from = 0
    for (;;) {
        const at = indexOfJsMarker(rule, from)
        if (at < 0) break
        if (insideRegion(at)) {
            from = at + JS_MARKER.length
            continue
        }
        const codeStart = at + JS_MARKER.length
        regions.push({ start: codeStart, end: jsCodeEnd(rule, codeStart), block: false })
        from = codeStart
    }

    return regions.sort((a, b) => a.start - b.start)
}

export interface SplitOptions {
    /**
     * 是否跳过 `<js>` 块。
     *
     * 切连接符要跳（块里是 JS 代码）；切 `##` **不能**跳 ——
     * `<js>##正则##</js>` 是书源里合法的净化写法（把净化链写在 js 段里），
     * 跳掉它那些规则就不生效了。
     */
    skipJsBlocks?: boolean
    /** 是否跳过方括号与引号里的内容（连接符要跳：`?(@.a&&@.b)`） */
    skipQuotes?: boolean
}

/**
 * 按分隔符切分规则，跳过 JS 区域、方括号与引号里的内容
 *
 * @returns 没有找到分隔符时返回 null（与「切出一块」区分开）
 */
export function splitRuleText(
    rule: string,
    delimiter: string,
    options: SplitOptions = {},
): string[] | null {
    const skipJsBlocks = options.skipJsBlocks ?? true
    const skipQuotes = options.skipQuotes ?? true

    // 位置查表：规则都不长，用一个布尔数组比每次比较区间更快也更好读
    const masked = new Uint8Array(rule.length)
    for (const region of findJsRegions(rule)) {
        if (region.block && !skipJsBlocks) continue
        for (let i = region.start; i < region.end && i < rule.length; i += 1) masked[i] = 1
    }

    const parts: string[] = []
    let quote = ''
    let depth = 0
    let last = 0
    let found = false

    for (let i = 0; i < rule.length; i += 1) {
        if (masked[i] === 1) continue

        const ch = rule[i]!

        if (quote !== '') {
            if (ch === '\\') {
                i += 1
                continue
            }
            if (ch === quote) quote = ''
            continue
        }

        if (skipQuotes) {
            if (ch === '"' || ch === "'" || ch === '`') {
                quote = ch
                continue
            }
            if (ch === '[') {
                depth += 1
                continue
            }
            if (ch === ']') {
                depth = Math.max(0, depth - 1)
                continue
            }
            if (depth > 0) continue
        }

        if (rule.startsWith(delimiter, i)) {
            parts.push(rule.slice(last, i))
            i += delimiter.length - 1
            last = i + 1
            found = true
        }
    }

    if (!found) return null
    parts.push(rule.slice(last))
    return parts
}
