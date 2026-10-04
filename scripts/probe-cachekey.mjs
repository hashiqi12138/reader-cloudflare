/**
 * 把前端拼 `/api/content` 请求 URL 的过程复刻一遍，看「键稳不稳」。
 *
 *   BASE=http://127.0.0.1:8788 node scripts/probe-cachekey.mjs
 *
 * 为什么要有它：离线时出现过「同一章缓存里明明有、查表却 MISS」（表现为「正文取不到」）。
 * 原因是键取的是整条 URL，而查询串里夹着 `book` / `chapter` 两段 JSON —— 它们是给规则
 * 求值用的**上下文**，由客户端现算，并不稳定：
 *   - `/api/book` 有的源不返回作者（内置测试源 `author` 就是空串），于是 `book.author`
 *     退回到地址栏 hash 里的 hint；
 *   - 章节的 `isVip` 有的源给 `undefined`、有的给 `false`。
 *
 * 这个脚本把「同一章、不同入口」的几种拼法并排列出来：整条 URL 各不相同，
 * 而按 `swPolicy.storageKey` 的新算法（只留 `sourceId` + `url`）算下来是同一个。
 * 所以它钉的是**判据本身**，不是某一次运行的结果 —— 单测见 `test/swPolicy.test.mjs`。
 */
import { CONTENT_CACHE, storageKey } from '../public/js/swPolicy.js'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8788'
const SOURCE = process.env.SOURCE ?? 'builtin:fixture-explore'
const BOOK_URL = `${BASE}/fixture/book/1`
const NAME_HINT = '测试小说·甲'
const AUTHOR_HINT = '作者甲'

const compactObject = (obj) => {
    if (!obj) return null
    const out = {}
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined || value === null || value === '') continue
        out[key] = value
    }
    return Object.keys(out).length > 0 ? out : null
}

/** 与 `public/js/core.js` 的 `contextParams` 同一份逻辑 */
const contextParams = (book, chapter) => {
    const out = {}
    const b = compactObject(book)
    if (b) out.book = JSON.stringify(b)
    const c = compactObject(chapter)
    if (c) out.chapter = JSON.stringify(c)
    return out
}

const paramsOf = (obj) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
    }
    return search.toString()
}

const getJson = async (path) => {
    const res = await fetch(BASE + path)
    return { status: res.status, json: await res.json() }
}

const main = async () => {
    const info = await getJson(
        `/api/book?${paramsOf({ sourceId: SOURCE, url: BOOK_URL, ...contextParams({ name: NAME_HINT, author: AUTHOR_HINT, bookUrl: BOOK_URL }) })}`,
    )
    console.log('--- /api/book ---')
    console.log('status', info.status)
    console.log(
        'name=',
        JSON.stringify(info.json?.name),
        ' author=',
        JSON.stringify(info.json?.author),
    )
    console.log('tocUrl=', JSON.stringify(info.json?.tocUrl))

    const tocUrl = info.json?.tocUrl || BOOK_URL
    const toc = await getJson(
        `/api/toc?${paramsOf({
            sourceId: SOURCE,
            url: tocUrl,
            ...contextParams({
                name: info.json?.name || NAME_HINT,
                author: info.json?.author || AUTHOR_HINT,
                bookUrl: BOOK_URL,
            }),
        })}`,
    )
    console.log('\n--- /api/toc ---')
    console.log('status', toc.status, ' chapters=', (toc.json?.chapters ?? []).length)
    console.log('warning=', JSON.stringify(toc.json?.warning ?? null))
    for (const [i, ch] of (toc.json?.chapters ?? []).entries()) {
        console.log(
            `  [${i}] name=${JSON.stringify(ch.name)} url=${ch.url} isVip=${JSON.stringify(ch.isVip)} keys=${Object.keys(ch).join(',')}`,
        )
    }

    // ---- 复刻前端拼正文请求的那一段 ----
    const bookName = info.json?.name || NAME_HINT || '未命名'
    const bookAuthor = info.json?.author || AUTHOR_HINT
    const book = { name: bookName, author: bookAuthor, bookUrl: BOOK_URL }

    console.log('\n--- /api/content 的几种拼法（整条 URL 不同、新键相同）---')
    for (const index of [0, 1]) {
        const chapter = (toc.json?.chapters ?? [])[index]
        if (!chapter) continue
        const chapterCtx = { title: chapter.name, index, url: chapter.url, isVip: chapter.isVip }
        const variants = {
            '详情页进（带 author hint）': paramsOf({
                sourceId: SOURCE,
                url: chapter.url,
                ...contextParams(book, chapterCtx),
            }),
            'isVip 写成 false': paramsOf({
                sourceId: SOURCE,
                url: chapter.url,
                ...contextParams(book, { ...chapterCtx, isVip: chapter.isVip ?? false }),
            }),
            '搜索页进（book 用 hint）': paramsOf({
                sourceId: SOURCE,
                url: chapter.url,
                ...contextParams(
                    { name: NAME_HINT, author: AUTHOR_HINT, bookUrl: BOOK_URL },
                    chapterCtx,
                ),
            }),
        }
        console.log(`\nindex=${index}  url=${chapter.url}`)
        const keys = new Set()
        for (const [label, query] of Object.entries(variants)) {
            // 直接问被测的那份算法，而不是在探针里再抄一遍
            const key = storageKey(`${BASE}/api/content?${query}`, CONTENT_CACHE)
            keys.add(key)
            console.log(`  ${label}：整条 ${query.length} 字符 → 键 ${key.slice(BASE.length)}`)
        }
        console.log(`  三种拼法算出来的键是否同一个：${keys.size === 1}`)
    }
}

main().catch((err) => {
    console.error('探针失败：', err)
    process.exitCode = 1
})
