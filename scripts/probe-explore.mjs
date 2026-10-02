/**
 * 全量探测「发现」链路，输出**分类与失败原因的分布**而不是逐条日志。
 *
 * 594 个带发现页的书源逐条打印没有可读性，真正要回答的是：
 *   1. 分类能出来的有多少、出不来的又是卡在哪一步
 *   2. 分类出来了但取不到书的，是规则问题还是站点问题
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const CONCURRENCY = Number(process.env.CONCURRENCY ?? '8')

const { sources } = await (await fetch(`${BASE}/api/sources`)).json()
const targets = sources.filter((s) => s.hasExplore && s.enabled)

/** 把错误收敛成可统计的类别，避免每条 URL 各算一类 */
function classify(message) {
    const text = String(message ?? '')
    if (text === '') return '（无错误信息）'
    const cut = text.replace(/\s+/g, ' ').slice(0, 90)
    if (/ReferenceError: '(\w+)' is not defined/.test(cut)) {
        return `脚本缺少 ${cut.match(/ReferenceError: '(\w+)'/)[1]}`
    }
    if (/Cannot read propert/.test(cut)) return '脚本访问了空值属性'
    if (/TypeError/.test(cut)) return '脚本类型错误'
    if (/没有配置/.test(cut)) return '书源未配置对应规则'
    if (/fetch|network|connect|timeout|ENOTFOUND|ECONN|超时/i.test(cut)) return '取网失败'
    return cut
}

const stats = {
    categories: { ok: 0, empty: 0, fail: 0 },
    books: { ok: 0, empty: 0, fail: 0, skipped: 0 },
    whyCategories: new Map(),
    whyBooks: new Map(),
    samples: { emptyBooks: [], failCategories: [] },
}
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

async function get(path, params) {
    const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`)
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
}

async function check(source) {
    let cats = []
    try {
        const { status, body } = await get('/api/explore', { sourceId: source.id })
        if (status !== 200) {
            stats.categories.fail++
            const key = classify(body.error)
            bump(stats.whyCategories, key)
            if (stats.samples.failCategories.length < 12) {
                stats.samples.failCategories.push(
                    `${source.name}: ${String(body.error).slice(0, 110)}`,
                )
            }
            return
        }
        cats = body.categories ?? []
    } catch (err) {
        stats.categories.fail++
        bump(stats.whyCategories, classify(err.message))
        return
    }

    if (cats.length === 0) {
        stats.categories.empty++
        bump(stats.whyCategories, '分类解析出来是空的')
        return
    }
    stats.categories.ok++

    try {
        const { status, body } = await get('/api/explore/books', {
            sourceId: source.id,
            url: cats[0].url,
            page: '1',
        })
        if (status !== 200) {
            stats.books.fail++
            bump(stats.whyBooks, classify(body.error))
            return
        }
        const books = body.books ?? []
        if (books.length === 0) {
            stats.books.empty++
            bump(stats.whyBooks, '规则跑通但没匹配到书')
            if (stats.samples.emptyBooks.length < 12) {
                stats.samples.emptyBooks.push(
                    `${source.name} → 「${cats[0].title}」 ${cats[0].url.slice(0, 60)}`,
                )
            }
        } else {
            stats.books.ok++
        }
    } catch (err) {
        stats.books.fail++
        bump(stats.whyBooks, classify(err.message))
    }
}

const queue = [...targets]
const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) await check(queue.shift())
})
await Promise.all(workers)

const show = (map) =>
    [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `    ${String(v).padStart(4)}  ${k}`)
        .join('\n')

console.log(`带发现页的书源：${targets.length}\n`)
console.log('【分类】')
console.log(
    `    成功 ${stats.categories.ok}  解析为空 ${stats.categories.empty}  接口失败 ${stats.categories.fail}`,
)
console.log(show(stats.whyCategories))
console.log('\n【书目】（仅统计分类成功的）')
console.log(`    有书 ${stats.books.ok}  无书 ${stats.books.empty}  接口失败 ${stats.books.fail}`)
console.log(show(stats.whyBooks))
if (stats.samples.emptyBooks.length) {
    console.log('\n【无书样本】')
    for (const s of stats.samples.emptyBooks) console.log(`    ${s}`)
}
if (stats.samples.failCategories.length) {
    console.log('\n【分类失败样本】')
    for (const s of stats.samples.failCategories) console.log(`    ${s}`)
}
