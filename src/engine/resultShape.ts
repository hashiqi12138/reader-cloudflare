/**
 * `选择器@js:` 里 `result` 该绑成**数组**还是**换行拼成的字符串**
 *
 * 引擎原先按「命中几个值」决定：命中 1 个给字符串，命中多个给数组。**类型随命中数量浮动**
 * —— 而书源是照固定类型写的，于是同一条规则在单页/多页两种页面上表现不同：
 *
 *   - 按字符串写的遇到多命中：`TypeError: result.split is not a function`。
 *     线上 🎨🔞鸟鸟韩漫 的正文（`class.view-imgBox@tag.img@data-src` 后接
 *     `@js: … result.split('\n') …`）就是这样整章图都读不出来。
 *   - 按数组写的遇到单命中：`result[0]` 悄悄变成**第一个字符**。这比报错更糟 ——
 *     不报错、只是值不对，翻页地址会变成半个字符拼出来的怪地址。
 *
 * 所以改成按**脚本自己的写法**决定，与 `analyze.ts` 里 `__resultAsJsoup`
 * （只有脚本真的写了 `result.select(...)` 才把 result 包成 jsoup 对象）是同一个思路。
 *
 * 判定规则（按顺序）：
 *
 *   1. 出现**下标访问 / 数组专有方法 / 显式转数组** → 数组。这三样字符串上都做不到，
 *      出现了就说明脚本一定按数组写的，绑字符串必然报错。**这一条最硬，优先于第 3 条。**
 *   2. 出现**字符串专有方法 / 字符串语境**（`split`、`replace`、`JSON.parse(result)`、
 *      `+ result` …）→ 字符串。数组上没有这些方法。
 *   3. 最后一条语句**就是** `result` → 数组。原样返回时条目数不能被 join 吃掉：
 *      `📂第一小说` 的翻页规则是 `if(…) { …; next } else result`，`else` 分支返回的就是
 *      `result`；绑字符串的话 N 个下一页地址会塌成 1 条。
 *   4. 其余 → 字符串（多数派）。
 *
 * 为什么默认是字符串：全量 594 条书源里 260 处 `选择器@js:`，按字符串写的 234 处、
 * 按数组写的 26 处。而且按数组用的几乎全部集中在 `nextTocUrl` / `nextContentUrl` /
 * `chapterList` 这类结果是「一列东西」的字段上 —— 这三个字段占了 22 处，
 * 剩下 4 处是脚本自己写了下标或原样返回（见 `test/resultShape.scan.test.ts` 的账本）。
 *
 * 单独成模块的原因与 `ruleText.ts` 一样：纯函数，可以直接做单元测试；
 * 而用到它的 `analyze.ts` 会连带引入沙箱，Node 里跑不起来。
 */

/**
 * 去掉字符串/模板字面量，只留下代码
 *
 * 不这么做的话，`'<img src="' + x` 这类**字面量里**恰好写了 `result[0]` 的文本
 * 会被当成真代码，把一条字符串写法的规则误判成数组写法 —— 那会真的把它跑坏。
 */
function stripJsLiterals(code: string): string {
    let out = ''
    let quote = ''
    let quoteAt = -1
    for (let i = 0; i < code.length; i += 1) {
        const ch = code[i]!
        if (quote !== '') {
            if (ch === '\\') {
                i += 1
                continue
            }
            if (ch === quote) {
                quote = ''
                quoteAt = -1
            }
            continue
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch
            quoteAt = i
            continue
        }
        out += ch
    }
    // 引号没配平：多半是**正则字面量里的引号**（`/(\w+-\w+)(?==")/g`），
    // 把它当字符串开头会一路吞到代码结尾，把后面的 `result[i]` 一起吞掉
    // （🔞紫云宫 的 chapterList 正是如此）。这一段之后的原文整个留着 ——
    // 宁可多认几个字符，也不能把真代码当字符串扔掉。
    if (quote !== '') out += code.slice(quoteAt)
    return out
}

/** 下标访问：`result[0]`、`result[i]`、`result["key"]` */
const INDEX_ACCESS = /\bresult\s*\[/

/**
 * 数组专有方法（字符串与字符串包装上都没有）
 *
 * 刻意**不含** `indexOf` / `slice` / `includes` / `length` / `at` / `filter` / `find`：
 * 它们两边都有（字符串包装上还挂着 jsoup 的 `filter`），拿来做判据会把两侧写法判反。
 */
const ARRAY_METHOD =
    /\bresult\s*\.\s*(map|join|forEach|reduce|reduceRight|concat|push|pop|shift|unshift|sort|reverse|splice|flat|flatMap|findIndex|findLast|some|every|entries|fill|copyWithin)\s*\(/

/** 显式转成数组：`Array.from(result)`、`[...result]` */
const TO_ARRAY = /Array\.from\s*\(\s*result\b|\[\s*\.\.\.\s*result\b/

/** 字符串专有方法（数组调不到） */
const STRING_METHOD =
    /\bresult\s*\.\s*(split|substring|substr|charAt|charCodeAt|codePointAt|replace|replaceAll|match|matchAll|toUpperCase|toLowerCase|trim|trimStart|trimEnd|startsWith|endsWith|padStart|padEnd|search|localeCompare|normalize|repeat)\s*\(/

/** 只在字符串语境里说得通的写法 */
const STRING_CONTEXT =
    /JSON\.parse\s*\(\s*result\b|String\s*\(\s*result\s*\)|\+\s*result\b|\bresult\s*\+|`[^`]*\$\{\s*result\b/

/**
 * 最后一条语句**就是** `result`（含 `return result`）
 *
 * 只判「结尾是 `result` 这个词」会把 `GetUL() + result`、`?a:result` 全判成原样返回，
 * 所以要求 `result` 前面是代码开头或语句分隔符。
 */
function returnsResultBare(code: string): boolean {
    const trimmed = code.trim().replace(/[\s;]+$/, '')
    return /(^|[;}\n])\s*(?:return\s+)?result$/.test(trimmed)
}

/**
 * 脚本是不是**按字符串**在用 `result`
 *
 * `resultWantsArray` 用它来给「数组 / 字符串」定序；`analyze.ts` 的 `resultGlobals`
 * 另有一处要用：脚本同时写了 jsoup 方法与字符串方法时**字符串优先** ——
 * `__boxHtml` 给的那份「字符串 + jsoup 方法」两种都能用，而数组给不起 `split`。
 */
export function resultWantsString(code: string): boolean {
    const text = stripJsLiterals(code)
    return STRING_METHOD.test(text) || STRING_CONTEXT.test(text)
}

/** `result` 是不是要绑成数组（否则绑「换行拼成的字符串」） */
export function resultWantsArray(code: string): boolean {
    const text = stripJsLiterals(code)
    if (INDEX_ACCESS.test(text) || ARRAY_METHOD.test(text) || TO_ARRAY.test(text)) return true
    if (resultWantsString(code)) return false
    return returnsResultBare(code)
}
