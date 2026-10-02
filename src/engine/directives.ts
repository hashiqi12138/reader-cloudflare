/**
 * 规则里的显式指令：`@css:` / `@json:` / `@js:` / `@xpath:` 与 `<js>` 块
 *
 * 单独成一个文件，是因为这几个前缀的匹配散在**五个地方**（分派、连接符切分、
 * 「这条规则里有没有 JS」的判断、URL 字段、模板），而**大小写必须处处一致**。
 * 之前就是各写一遍，于是出现了自相矛盾：`template.ts` 用了 `/i` 而 `analyze.ts` 没加，
 * 结果是 `{{@JSon:$.a}}` 能用、而字段规则 `@JSon:$.a` 静默返回空。
 *
 * 大小写不敏感不是洁癖，是这几条源能不能跑的前提。线上 594 条源里，规则**开头**的写法分布是：
 *
 *   @CSS:   32 处（🎭🎬露西弗俱乐部 的每个字段都是，包含 ruleContent.content）
 *   @JSon:  25 处（露西弗同人站、新人漫画、晋江文学【…】）
 *   @Json:   4 处（🎨再漫画，含 ruleSearch.bookList —— 这一条让整个搜索失败）
 *   @XPath:  3 处（这个早先已经认了两种写法）
 *
 * 把它们的实参摊开看过：`@CSS:` 后面是真 CSS 选择器（`#js_chapter_list li`、`.chapter@text`、
 * `div.luf_news_contents@html##<font…`），`@JSon:` 后面是 JSONPath（`$.attributes.author`）。
 * 也就是说只要前缀认出来，后面走的就是各自本来该走的路。
 *
 * 为什么可以安全地不区分大小写：这四个前缀是**封闭集合**，而 CSS 与 XPath 的合法开头
 * 里没有 `@css:` / `@json:` / `@js:` / `@xpath:` 这几种形态（CSS 的 at-rule 是 `@media`
 * 这类，不在这个集合里；`@` 开头的选择器本身也不是合法 CSS）。所以放开大小写只会把
 * 「静默返回空」变成「按本意求值」，不会把某条本来正确的规则带偏。
 */

/** 规则开头的显式指令。**匹配前缀时不区分大小写，前缀之后的内容原样保留** */
export const RULE_DIRECTIVE = /^@(css|json|js|xpath):/i

export type RuleDirectiveName = 'css' | 'json' | 'js' | 'xpath'

export interface MatchedDirective {
    name: RuleDirectiveName
    /** 前缀之后的原文（**不改大小写** —— CSS 选择器与 JS 都是区分大小写的） */
    body: string
}

/** 拆出规则开头的指令；没有指令返回 null */
export function matchDirective(rule: string): MatchedDirective | null {
    const match = RULE_DIRECTIVE.exec(rule)
    if (!match) return null
    return {
        name: match[1]!.toLowerCase() as RuleDirectiveName,
        // 用匹配到的长度而不是写死的数字：`@xpath:` 是 7、`@json:` 是 6、`@js:` 是 4，
        // 写死一个值迟早会在新增指令时漏改
        body: rule.slice(match[0].length),
    }
}

/** `@js:` 标记的规范写法。实际匹配不区分大小写，长度都是 4 */
export const JS_MARKER = '@js:'

/**
 * 找 `@js:` 标记的下标（不区分大小写），找不到返回 -1
 *
 * 用 slice + `search` 而不是带 `g` 的正则：带 `g` 的正则把状态（`lastIndex`）挂在
 * 正则对象上，两个地方交叉调用就会互相打乱。`toLowerCase()` 也不行 ——
 * 个别 Unicode 字符转小写会变长（`'İ'.toLowerCase()` 是两个字符），下标就对不上了。
 */
export function indexOfJsMarker(rule: string, from = 0): number {
    const at = rule.slice(from).search(/@js:/i)
    return at === -1 ? -1 : at + from
}

/**
 * 这条规则里有没有 JS
 *
 * 三种形态：`@js:` 尾巴、`<js>` 块、`{{}}` 模板。用来判断求值要不要进沙箱 ——
 * 漏判的后果不是报错，而是「脚本没跑，返回了一段规则原文」。
 */
export function ruleHasJs(rule: string): boolean {
    return indexOfJsMarker(rule) !== -1 || /<js[\s>]/i.test(rule) || rule.includes('{{')
}

/** `<js>…</js>` 块（含未闭合到结尾的情况）。`i` 不能少：`<JS>` 在真实书源里也出现过 */
export const JS_BLOCK = /<js(?:\s[^>]*)?>[\s\S]*?(?:<\/js>|$)/gi
