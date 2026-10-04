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

/**
 * 脚本是不是把 `result` 当 jsoup 对象用
 *
 *   `result.select('h3').text()`   集合级方法
 *   `result.toArray()`             集合级方法（jsoup 的 `Elements.toArray()`）
 *
 * Legado 里 `result` 同时可能是字符串也可能是 jsoup 对象，两种写法在**同一条书源里**
 * 都会出现。这里只按「真的调了只有节点才有的方法」来判断，而不是一律包装 ——
 * 一律包装会把 `typeof result` 从 `'string'` 变成 `'object'`，
 * 而线上有 18 处脚本在判断这个类型。
 *
 * `toArray` 必须算在内：它是**元素级**的方法，字符串上没有。线上 20 个源 28 处在用
 * （📂文学小说 的 `list = result.toArray()` 是最典型的一条）—— 漏掉它，
 * 那条规则会把节点集当成一串文本，然后在 `result.toArray` 上 `TypeError: not a function`。
 */
export const RESULT_AS_JSOUP =
    /\bresult\s*\.\s*(select|attr|first|last|get|eq|size|isEmpty|textNodes|eachText|html|outerHtml|hasClass|children|not|filter|matches|matchesOwn|tagName|ownText|toArray)\s*\(/

/**
 * 脚本在**迭代 `result` 的回调**里对条目调 jsoup 方法
 *
 *   `result.forEach(e => e.attr('href'))`   ← 🔞西瓜书屋 的目录规则就长这样
 *   `result.map(x => x.text())`
 *
 * 这类写法要的同样是**元素**：`attr` / `text` / `select` 只有节点才给得出来，
 * 给纯文本的话 `e.attr(...)` 恒为空串 —— 而且**不报错**。
 *
 * 认的是「回调参数上出现了一个**只有元素才有**的方法名」，方法名表刻意不含
 * `split` / `replace` / `trim` / `slice` 这些字符串方法，所以
 * 「迭代一串文本做字符串处理」的写法不会被误判。
 */
export const ITEM_AS_JSOUP =
    /\bresult\s*\.\s*(?:map|forEach|filter|find|findIndex|some|every|flatMap|reduce)\s*\(\s*(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*(?:=>)?[\s\S]{0,300}?\b\1\s*\.\s*(?:attr|select|text|html|outerHtml|ownText|tagName|hasClass|hasAttr|val|className|textNodes|eachText|matches|matchesOwn|children|first|last|get|eq|size|index|id)\s*\(/

/**
 * 脚本里出现了「只有节点才有的方法」（**不看**是不是同时按字符串用）
 *
 * 与 `wantsJsoupResult` 的差别就是那一条「字符串优先」：两个函数服务两件事 ——
 * `wantsJsoupResult` 决定 `result` **绑成数组还是字符串**（两种都按字符串算时字符串能
 * 同时满足两种写法）；而这个决定**交给脚本的内容是 HTML 还是文本**：
 * 脚本既然调了 `attr` / `select` / `toArray`，那 `result` 里就必须有标记，
 * 只给文本的话这些方法拿不到任何东西（`toArray()` 会得到一个空数组，**不报错**）。
 */
export function usesJsoupOnResult(code: string): boolean {
    return RESULT_AS_JSOUP.test(code) || ITEM_AS_JSOUP.test(code)
}

/**
 * 脚本是不是「**按节点用** `result`」
 *
 * 两种写法都算：直接调集合级方法（`result.size()` / `result.select(…)`），
 * 以及迭代回调里对条目调元素级方法（`result.forEach(e => e.attr('href'))`）。
 * 后者在字符串与字符串数组上同样不存在。
 *
 * 与上面的优先级保持一致：**按字符串用优先** —— 两种写法写在同一条规则里时，
 * 只有 `__boxHtml` 给的「字符串 + jsoup 方法」那一份形态两种都能满足，
 * 所以这时候按字符串算，`result` 也不去换绑节点数组。
 *
 * 抽成函数是为了让 `evalRule`（决定**交给脚本什么内容**）与 `resultGlobals`
 * （决定**绑成数组还是字符串**）用的是同一个判据 —— 两处各写一遍必然跑偏。
 */
export function wantsJsoupResult(code: string): boolean {
    if (resultWantsString(code)) return false
    return usesJsoupOnResult(code)
}
