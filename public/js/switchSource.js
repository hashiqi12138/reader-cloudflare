/*
 * 换源：找「这本书在别的书源上」的候选，以及换过去之后该落在哪一章
 *
 * 两件事都是纯计算，所以单独成一个文件、单独一组测试（`test/switchSource.test.mjs`）：
 *
 * 1. **候选** —— 从 `/api/search` 那份「按源分组的结果」里挑出与当前这本**同一本**的条目。
 *    判据用 `merge.js` 的 `sameBook`，也就是搜索页「按书合并」那一把尺子：两处各写一套的话，
 *    会出现「搜索结果里已经合并成一条了，换源时却认不出是同一本」这种自相矛盾的事。
 *    当前那一源本身**不在候选里** —— 换源的意义就是换到别处去。
 * 2. **落点** —— 新书源的目录里，哪一章对应「我正在读的这一章」。先**按章节名对**
 *    （归一化后相等），对不上再退到**同一下标**（两边分卷不同、章名被改过、增删章
 *    都会让下标漂移，所以这一条只是「有个位置总比回到第一页好」），连下标都越界就
 *    返回 `none`，由界面如实说「没对上，从第一章开始」—— 而不是假装对上了。
 *
 * 「对上了」与「没对上」这件事必须能传到界面上：换源之后落在错的章节，比从头开始更难发现。
 */

import { sameBook, sourceBookKey } from './merge.js'

/**
 * 这本书在别的书源上的候选
 *
 * @param results `/api/search` 返回的 `sources`（每项 `{ sourceId, sourceName, ok, books }`）
 * @param current `{ sourceId, name, author }` —— 现在打开的这一本
 * @returns `[{ sourceId, sourceName, book }]`，顺带把**作者不一致**的条目标出来
 *          （`authorDiffers`），界面上要提示「可能是同名书」
 */
export function candidatesFor(results, current) {
    const out = []
    const seen = new Set()

    for (const result of Array.isArray(results) ? results : []) {
        if (!result || result.ok === false) continue
        const sourceId = String(result.sourceId ?? '')
        // 当前这一源不参与：换源不是「原地换地址」
        if (sourceId === '' || sourceId === String(current?.sourceId ?? '')) continue

        for (const book of result.books ?? []) {
            if (!sameBook(book, current)) continue
            const key = sourceBookKey(sourceId, String(book?.bookUrl ?? ''))
            if (seen.has(key)) continue
            seen.add(key)
            out.push({
                sourceId,
                sourceName: String(result.sourceName ?? ''),
                book,
                // 书名一样、作者只写了一边时也算同一本（见 `sameBook`），
                // 但这种条目值得在界面上标一句 —— 同名不同作者的书是存在的
                authorDiffers:
                    String(book?.author ?? '').trim() !== '' &&
                    String(current?.author ?? '').trim() !== '' &&
                    String(book.author).trim() !== String(current.author).trim(),
            })
        }
    }
    return out
}

/**
 * 换过去落在哪一章
 *
 * @param chapters 新书源的目录（`/api/toc` 的 `chapters`）
 * @param want `{ name, index }` —— 当前读到的章节（书架进度里存的那两个字段）
 * @returns `{ index, how }`：`index` 是**新目录里的下标**，`-1` 表示没对上；
 *          `how` 是 `'name'`（按名字对上了）、`'index'`（退到同一下标）、
 *          `'none'`（都没对上，从第一章开始）
 */
export function matchChapter(chapters, want) {
    const list = Array.isArray(chapters) ? chapters : []
    if (list.length === 0) return { index: -1, how: 'none' }

    const name = normalize(want?.name)
    if (name !== '') {
        const found = list.findIndex((one) => normalize(one?.name) === name)
        if (found >= 0) return { index: found, how: 'name' }
    }

    const at = Math.trunc(Number(want?.index))
    if (Number.isFinite(at) && at >= 0 && at < list.length) return { index: at, how: 'index' }

    return { index: -1, how: 'none' }
}

/**
 * 书架行 / 进度行 → 落点 `{ name, index }`
 *
 * 两个来源的形状不一样，但「读没读过」只有一条判据：`chapterName` 与 `chapterIndex`
 * 都是 `null` 就是没读过，给 `null`，由界面如实说「从第一章开始」。
 *
 * 单独抽出来是因为这件事在详情页上踩过一次坑：落点原先只从**书架缓存**里取，
 * 而那份缓存是模块级、只在 `invalidateShelf()` 之后才重取 —— 阅读页每换一章都写
 * 进度却不刷新它，于是「刚读完第二章、回去换源」拿到的是一份 `chapterName: null`
 * 的旧数据，换源静默把阅读位置降级成「从头开始」。现在详情页改问 `/api/progress`，
 * 两条路都走这个函数，也就有了能单测的出口（见 `test/switchSource.test.mjs`）。
 */
export function progressPosition(row) {
    if (!row) return null
    const name = row.chapterName ?? null
    const index = row.chapterIndex ?? null
    if (name === null && index === null) return null
    return { name: name === null ? '' : name, index: index === null ? -1 : index }
}

/** 与 `merge.js` 里那份归一化同一套：去掉所有空白（含全角）再转小写 */
const normalize = (value) =>
    String(value ?? '')
        .replace(/[\s\u3000]+/g, '')
        .toLowerCase()
