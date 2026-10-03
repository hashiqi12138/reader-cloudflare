/**
 * 字段规则里的 `{{...}}` 模板
 *
 * 与 `searchUrl` 的模板（见 `legado/source.ts` 的 `resolveTemplate`）不是一回事：
 * URL 模板里只可能是 JS 变量（`{{key}}`、`{{page}}`），而**字段规则模板里两种都可能是**：
 *
 *   {{$.id}}                        规则（JSONPath）
 *   {{@@h1@text}}                   规则（带冗余 `@` 标记）
 *   /fixture/book/{{$.id}}          规则 + 字面文本
 *   {{baseUrl}}##/book/##/toc/      规则 + 正则链
 *   {{java.timeFormat(...)}}        JS 表达式
 *   {{'字面量'}} / {{key}}           JS 表达式
 *
 * 分类判错的后果一样：拿 JS 去当规则求值、或反过来，都只会得到空串，
 * **不报任何错**。所以这里把判断单独成模块，好逐条钉住（它旁边的 analyze.ts
 * 会连带引入沙箱，Node 里跑不起来）。
 *
 * 下面的形态全部取自线上 816 条书源里 **939 处真实字段模板**，不是凭空想的例子。
 */

/** `@css:` / `@json:` / `@js:` / `@xpath:` 这类显式指令（大小写不敏感，见 directives.ts） */
import { RULE_DIRECTIVE } from './directives'

/**
 * 去掉模板里多余的 `@` 前缀
 *
 * `{{@@h1@text}}`、`{{@@@css:.title@text}}` 这类写法在真实书源里有 214 处，
 * 多出来的 `@` 只是「这里面是个规则」的标记。
 *
 * **但不能把 `@css:` 这类指令自己的前缀剥掉** —— 那会把一条 CSS 规则变成 `css:...`，
 * 直接失效，而失效的表现又是一个空字段。
 */
export function stripRuleMarker(text: string): string {
    let out = text.trim()
    if (RULE_DIRECTIVE.test(out)) return out
    while (out.startsWith('@')) {
        out = out.slice(1)
        if (RULE_DIRECTIVE.test(out)) return out
    }
    return out
}

/**
 * 模板里装的是「规则」还是「JS 表达式」
 *
 * 只认明确特征，其余一律当 JS —— JS 那侧求值失败只会影响这一小段，
 * 而当规则的表达式被拿去当 JS 会直接抛错。
 */
export function classifyTemplate(text: string): 'rule' | 'js' {
    // 只看 `##` 之前的选择器部分：`##` 后面是正则，里面的 `?`、`()` 都不是 JS 特征
    // （`$.desc##(^|[。！？]+[”」）】]?)##$1<br>` 就带问号）
    const head = (text.split('##')[0] ?? '').trim()

    if (RULE_DIRECTIVE.test(head)) return 'rule'
    if (head.startsWith('//') || head.startsWith('(/')) return 'rule'
    if (head.startsWith('$')) {
        // `$.a`、`$.a||$.b` 是 JSONPath；`$.a > 0 ? 'x' : 'y'` 是三元素
        return /[?"'`]|==/.test(head) ? 'js' : 'rule'
    }
    if (/^(?:class|id|tag|text|children)[.\-]/.test(head)) return 'rule'
    if (/^[.#]/.test(head)) return 'rule'
    if (head.includes('@')) return 'rule'
    // 其余：`java.xxx()`、`'字面量'`、`baseUrl` / `title` / `host` 这类裸标识符
    return 'js'
}

/**
 * 骨架里还有没有规则语法
 *
 * 传入的是**骨架**（每个 `{{...}}` 换成空串之后的规则），不是展开结果 ——
 * 展开出来的值里可能正好含 `@`（简介里有个邮箱就够了），拿它判断会把纯文本误当成规则。
 *
 * 没有规则语法时，这条规则展开之后就是一段**字面文本**，直接当结果用，
 * 不能再拿去当选择器。真实书源里 `"第{{$.chapterNum}}章"`、`"/api/tracks/{{$.id}}"`、
 * `"https://…/intro?id={{$.id}}"` 都是这种，当选择器处理的后果是一个空串。
 */
export function hasRuleSyntax(skeleton: string): boolean {
    const t = skeleton.trim()
    if (t === '') return false
    if (t.includes('@')) return true // @css: / @js: / h1@text / @json:
    if (t.includes('##')) return true // 正则链（正常已在上一层拆掉，这里是兜底）
    if (t.startsWith('//') || t.startsWith('(/')) return true
    if (t.startsWith(':')) return true // AllInOne
    return false
}

/** 匹配一段模板。**每次新建**：带 `lastIndex` 的全局正则在并发请求之间会互相踩 */
export function templatePattern(): RegExp {
    return /\{\{([\s\S]*?)\}\}/g
}

/**
 * 把 `{{...}}` 整段去掉，得到骨架
 *
 * 与 `expandTemplates` 里那份骨架是同一个变换（那边顺手把展开值也拼了出来）。
 * 单独留一个函数，是因为**判一段前缀**时会用到：规则里 `@js:` 尾巴把 `{{}}`
 * 切成两半之后，要判的是前缀那一半的骨架（见 `analyze.ts` 的 `evalRule`）。
 */
export function skeletonOf(text: string): string {
    return text.replace(templatePattern(), '')
}
