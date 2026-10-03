/*
 * 把「每个书源各自一份搜索结果」按**同一本书**合并
 *
 * 一个关键词打下去，十几个源常常各返回同一本书 —— 真实的 800 多条书源里搜一个热词，
 * 整页都是同一本书的重复卡片。开源阅读的做法是合并成一条、在详情页里换源，这里照做。
 *
 * 三处刻意的取舍：
 *
 * 1. **合并键是「书名 + 作者」**，不是书名。同名不同作者是两本书，只按书名合并会把它们
 *    悄悄合成一条 —— 那是静默错数据，比多一条重复更难发现。
 * 2. **作者缺失时按「能补就补」处理**：一批源里总有几个没写作者。这种条目并进已有的同名
 *    条目（判据是「一侧作者为空」），并把非空的那个作者填上；两侧都有作者且不同则不并。
 * 3. **字段取第一个非空**：同一本书在不同源上各缺一块（A 有简介、B 有封面），
 *    合并之后取到的比任何单一源都全 —— 合并只会让信息更多，不会更少。
 *
 * 纯函数，不碰 DOM 也不发请求（`test/merge.test.mjs` 逐个钉住）。
 */

/** 参与合并的普通字段：第一个非空的胜出 */
const FIELDS = ['coverUrl', 'kind', 'lastChapter', 'intro']

/**
 * 归一化：去掉所有空白（含全角空格）再转小写
 *
 * 书名写法很随意（`书名（全本）`、`书名 (全本)`、大小写不同的英文名），
 * 但**不能去掉括号之类的内容** —— 那会把《斗破苍穹》和《斗破苍穹（续）》并成一本。
 */
const norm = (value) =>
    String(value ?? '')
        .replace(/[\s\u3000]+/g, '')
        .toLowerCase()

/** 一个 (书源, 书) 对的标识，用来在详情页里认出「这条卡片里的某一源」 */
export const sourceBookKey = (sourceId, bookUrl) => `${sourceId}\u0000${bookUrl}`

/**
 * @param results 形如 `[{ sourceId, sourceName, books: [...] }]`（`/api/search` 的每一项）
 * @param options.prefer `(sourceId, book) => boolean`，把某一源选成「主源」；
 *        默认取第一个。界面上用它把**已在书架**的那一源优先选出来
 * @returns 合并后的条目数组，按「有几个源有这本书」降序
 */
export function mergeBooks(results, options = {}) {
    const prefer = typeof options.prefer === 'function' ? options.prefer : null
    /** 书名键 → 该书名下的若干条目（作者不同就是不同条目） */
    const byName = new Map()
    const merged = []

    for (const result of results ?? []) {
        if (!result || result.ok === false) continue
        for (const book of result.books ?? []) {
            const nameKey = norm(book?.name)
            if (nameKey === '') continue

            const authorKey = norm(book?.author)
            const siblings = byName.get(nameKey) ?? []
            if (!byName.has(nameKey)) byName.set(nameKey, siblings)

            // 作者相等、或有一侧没写作者 → 视为同一本
            let entry = siblings.find(
                (item) => item.authorKey === '' || authorKey === '' || item.authorKey === authorKey,
            )
            if (!entry) {
                entry = {
                    name: String(book?.name ?? ''),
                    author: String(book?.author ?? ''),
                    authorKey,
                    sources: [],
                }
                for (const field of FIELDS) entry[field] = ''
                siblings.push(entry)
                merged.push(entry)
            } else if (entry.authorKey === '' && authorKey !== '') {
                entry.author = String(book.author)
                entry.authorKey = authorKey
            }

            for (const field of FIELDS) {
                if (!entry[field] && book?.[field]) entry[field] = String(book[field])
            }
            entry.sources.push({
                sourceId: result.sourceId,
                sourceName: result.sourceName ?? '',
                book,
            })
        }
    }

    for (const entry of merged) {
        entry.preferred =
            (prefer && entry.sources.find((item) => prefer(item.sourceId, item.book))) ??
            entry.sources[0]
    }

    // 有这本书的源越多，通常越可信、字段也越全 —— 排前面
    return merged.sort((a, b) => b.sources.length - a.sources.length)
}
