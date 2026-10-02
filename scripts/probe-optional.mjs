/**
 * 只测「URL 里有 `<,>` 可选段」的书源：分类 + 第一页书目。
 *
 * 这些源在支持可选段之前是**必然 404**（尖括号被编码进地址），
 * 所以这个脚本是那条修复的端到端验证，而不是又一份全量报告。
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'

const { readFile } = await import('node:fs/promises')
const DUMP = process.env.DUMP ?? 'live-explore-dump.json'
const dump = JSON.parse((await readFile(DUMP, 'utf8')).replace(/^\uFEFF/, ''))

/** 转储是 `[{results:[{payload:"<书源 JSON 字符串>"}]}]` 的搜索接口原样响应 */
function sourcesOf(node) {
    const out = []
    for (const group of Array.isArray(node) ? node : []) {
        for (const hit of group.results ?? []) {
            if (typeof hit.payload !== 'string') continue
            try {
                out.push(JSON.parse(hit.payload))
            } catch {
                /* 单条坏数据不影响整体 */
            }
        }
    }
    return out
}

const raw = sourcesOf(dump)
const names = new Set(
    raw
        .filter((s) => typeof s.exploreUrl === 'string' && s.exploreUrl.includes('<,'))
        .map((s) => s.bookSourceName),
)
console.log(`带 <,> 可选段的书源：${names.size}`)

const { sources } = await (await fetch(`${BASE}/api/sources`)).json()
const targets = sources.filter((s) => names.has(s.name))
console.log(`线上库中匹配到：${targets.length}\n`)

for (const source of targets) {
    let line = `· ${source.name}`
    try {
        const catRes = await fetch(
            `${BASE}/api/explore?${new URLSearchParams({ sourceId: source.id })}`,
        )
        const cat = await catRes.json()
        if (!catRes.ok) {
            console.log(`${line}\n    分类失败：${cat.error}`)
            continue
        }
        const cats = cat.categories ?? []
        line += `  分类 ${cats.length}`
        const first = cats[0]
        if (first) {
            const bookRes = await fetch(
                `${BASE}/api/explore/books?${new URLSearchParams({ sourceId: source.id, url: first.url, page: '1' })}`,
            )
            const books = await bookRes.json()
            line += bookRes.ok
                ? `  第 1 页书目 ${(books.books ?? []).length}`
                : `  书目失败：${books.error}`
        }
        console.log(line)
    } catch (err) {
        console.log(`${line}\n    异常：${err.message}`)
    }
}
