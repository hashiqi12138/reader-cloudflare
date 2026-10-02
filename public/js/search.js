/*
 * 章内搜索
 *
 * 只搜**当前这一章**，与「搜书」是两回事：搜书是拿关键词去各书源找书，
 * 这里是在已经打开的正文里找一处字，用来回答「刚才那句在哪儿」。
 *
 * 纯函数放在这个文件里、DOM 操作留在 reader.js：切分与摘录的规则值得单独钉住
 * （大小写怎么算、重叠怎么算、正则元字符要不要转义），而它们全都不需要 DOM 就能测。
 * 这一点和 replace.js 的理由一样 —— 这是「看起来简单、边界很多」的那类代码。
 *
 * 匹配规则刻意做成**纯文本、不区分大小写**：
 *   - 不区分大小写是为了「斗破」也能搜到「斗破」，中文没大小写，但英文人名很常见；
 *   - 不当正则是因为用户输入的关键词里 `(`、`[`、`.` 都太常见，
 *     按正则解释要么报错、要么把不相关的东西也匹配上。想要正则的人有「替换净化」。
 */

/** 关键词归一化：去首尾空白。空白关键词不匹配任何东西（不是匹配所有东西） */
export function normalizeQuery(value) {
    return String(value ?? '').trim()
}

/**
 * 把一行文字按关键词切成若干段，命中处标 hit
 *
 * 用 `indexOf` 逐段推进而不是 `split`：`split` 会把大小写信息丢掉，
 * 而命中段必须保留**原文的大小写** —— 正文显示的是原文，不是关键词。
 * 步进用关键词长度而不是 +1，因此 `aaa` 里搜 `aa` 只算一处（从左到右不重叠）。
 */
export function splitByQuery(line, query) {
    const text = String(line ?? '')
    const needle = normalizeQuery(query)
    if (needle === '') return [{ text, hit: false }]

    const haystack = text.toLowerCase()
    const lowerNeedle = needle.toLowerCase()
    const parts = []
    let from = 0
    let at = haystack.indexOf(lowerNeedle, from)

    while (at !== -1) {
        if (at > from) parts.push({ text: text.slice(from, at), hit: false })
        parts.push({ text: text.slice(at, at + needle.length), hit: true })
        from = at + needle.length
        at = haystack.indexOf(lowerNeedle, from)
    }
    if (from < text.length) parts.push({ text: text.slice(from), hit: false })
    return parts
}

/**
 * 取一段以命中处为中心的摘录
 *
 * 加书签时用它把「这一处记住了什么」写进列表：只写「第 37 章」看不出内容，
 * 而回跳必须打开章节才看得到。摘录按字符数截，不做按词截 —— 中文没有词边界。
 */
export function excerptAround(text, query, radius = 40) {
    const plain = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    const needle = normalizeQuery(query)
    if (needle === '') return plain.slice(0, radius * 2)

    const at = plain.toLowerCase().indexOf(needle.toLowerCase())
    if (at === -1) return plain.slice(0, radius * 2)

    const start = Math.max(0, at - radius)
    const end = Math.min(plain.length, at + needle.length + radius)
    return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`
}
