/**
 * 按书名子串抽查「发现」链路
 *
 * 用法：node scripts/probe-sources.mjs 海棠文学 哔哩轻小说 七猫小说
 *
 * 与 probe-explore.mjs 的分工：那个跑全量、只输出分布；这个针对**指定书源**
 * 打印分类与书目，用来验证「某个能力补上之后，这条源是不是真的能用了」。
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const wanted = process.argv.slice(2)

if (wanted.length === 0) {
    console.error('用法：node scripts/probe-sources.mjs <书名子串> [更多子串…]')
    process.exit(2)
}

const { sources } = await (await fetch(`${BASE}/api/sources`)).json()

async function get(path, params) {
    const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`)
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
}

for (const needle of wanted) {
    const hits = sources.filter((s) => s.name.includes(needle))
    if (hits.length === 0) {
        console.log(`\n===== ${needle} =====\n  没有匹配的书源`)
        continue
    }

    for (const source of hits) {
        console.log(`\n===== ${source.name}（${source.id}）=====`)
        if (!source.hasExplore) {
            console.log('  没有发现页（exploreUrl + ruleExplore.bookList 不齐）')
            continue
        }

        const cat = await get('/api/explore', { sourceId: source.id })
        if (cat.status !== 200) {
            console.log(`  分类失败（HTTP ${cat.status}）：${cat.body.error}`)
            continue
        }
        const categories = cat.body.categories ?? []
        console.log(
            `  分类 ${categories.length} 个：${categories
                .slice(0, 8)
                .map((c) => c.title)
                .join(' / ')}`,
        )
        if (categories.length === 0) continue

        for (const category of categories.slice(0, 2)) {
            const books = await get('/api/explore/books', {
                sourceId: source.id,
                url: category.url,
                page: '1',
            })
            if (books.status !== 200) {
                console.log(`  「${category.title}」失败：${books.body.error}`)
                continue
            }
            const list = books.body.books ?? []
            console.log(
                `  「${category.title}」书目 ${list.length} 本：${list
                    .slice(0, 5)
                    .map((b) => b.name)
                    .join(' / ')}`,
            )
        }
    }
}
