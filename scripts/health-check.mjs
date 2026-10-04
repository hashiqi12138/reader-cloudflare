/**
 * 抽样体检：把启用中的书源每隔 k 条取一条，用同一个关键字搜一遍，把结果分类。
 *
 * 「哪些源能用、卡在哪一类」是**量的**，不是猜的 —— 第四十五轮就是靠它拿到分布，
 * 并顺手量出「超时那一类里 12/13 是死域名」（结论是**不该**放宽超时）。
 *
 *   SMOKE_BASE=https://reader-api.liujieahu.workers.dev node scripts/health-check.mjs
 *   SCAN_KEYWORD=斗破苍穹 SCAN_STEP=13 SCAN_LIMIT=60 node scripts/health-check.mjs
 *
 * 默认打**线上**那台（不是本地冒烟站）：体检要的就是真实书源面对真实站点。
 * 请求间隔默认 4 秒 —— 一页 3 个源（与前端步长一致），快过这个数容易被 Cloudflare 掐。
 *
 * 输出：分类计数 + 每类的样例 + （可选）SCAN_OUT 指定的 JSON 明细。
 */

import { writeFileSync } from 'node:fs'

const BASE = process.env.SMOKE_BASE ?? 'https://reader-api.liujieahu.workers.dev'
const KEYWORD = process.env.SCAN_KEYWORD ?? '斗破苍穹'
const STEP = Number(process.env.SCAN_STEP ?? '13')
const LIMIT = Number(process.env.SCAN_LIMIT ?? '60')
const GAP_MS = Number(process.env.SCAN_GAP_MS ?? '4000')
const OUT = process.env.SCAN_OUT ?? ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(path) {
    const res = await fetch(BASE + path)
    const text = await res.text()
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

/**
 * 失败分类
 *
 * 分「上游的错」与「我们的错」是重点：前者改不动，后者才是下一轮要修的东西。
 * 判据只看错误文本 —— 服务端已经把 `errorCode` 分好了，但这里要的是更细的几类。
 */
export function classify(row) {
    if (row.ok) return row.count > 0 ? '有结果' : '静默 0 条'
    const e = row.error ?? ''
    if (/请求超时/.test(e)) return '报错·超时（多半是死域名）'
    if (/HTTP 4\d\d/.test(e)) return '报错·上游 4xx（被挡/需要登录）'
    if (/HTTP 5\d\d/.test(e)) return '报错·上游 5xx（站点坏了）'
    if (/TypeError|cannot read|is not a function/.test(e)) return '报错·脚本（缺 helper 之类）'
    if (/XPath 执行失败|CSS 选择器无效/.test(e)) return '报错·选择器（规则写错）'
    if (/不是合法 JSON/.test(e)) return '报错·请求选项不是合法 JSON'
    if (/WebView/i.test(e)) return '报错·需要 WebView（本引擎不支持）'
    return '报错·其他'
}

const list = await getJson('/api/sources')
const all = list?.sources ?? []
if (all.length === 0) {
    console.error(`拿不到书源列表：${BASE}/api/sources`)
    process.exit(1)
}
const sample = []
for (let i = 0; i < all.length && sample.length < LIMIT; i += STEP) sample.push(all[i])
console.log(
    `源总数 ${all.length}，抽样 ${sample.length} 条（每 ${STEP} 条取 1），关键字「${KEYWORD}」\n`,
)

const rows = []
for (let i = 0; i < sample.length; i += 3) {
    const batch = sample.slice(i, i + 3)
    const res = await fetch(`${BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: KEYWORD, sourceIds: batch.map((s) => s.id) }),
    })
    let sources = []
    try {
        sources = (await res.json()).sources ?? []
    } catch {
        /* 这一批没回 JSON：记下来，别让它悄悄消失 */
    }
    for (const batchSource of batch) {
        const hit = sources.find((s) => s.sourceId === batchSource.id)
        rows.push(
            hit
                ? {
                      name: hit.sourceName ?? batchSource.name,
                      ok: hit.ok === true,
                      count: hit.count ?? 0,
                      error: String(hit.error ?? ''),
                      elapsedMs: hit.elapsedMs ?? 0,
                  }
                : {
                      name: batchSource.name,
                      ok: false,
                      count: 0,
                      error: '（这一页没有回结果）',
                      elapsedMs: 0,
                  },
        )
    }
    process.stdout.write(`\r  已搜 ${Math.min(i + 3, sample.length)}/${sample.length}`)
    await sleep(GAP_MS)
}
console.log('\n')

const tally = new Map()
for (const row of rows) tally.set(classify(row), (tally.get(classify(row)) ?? 0) + 1)
console.log('=== 分类 ===')
for (const [kind, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${kind}  ${((n / rows.length) * 100).toFixed(0)}%`)
}

const slowest = rows
    .filter((r) => r.ok)
    .sort((a, b) => b.elapsedMs - a.elapsedMs)
    .slice(0, 5)
if (slowest.length > 0) {
    console.log('\n=== 最慢的几个（成功的）===')
    for (const r of slowest)
        console.log(`  ${String(r.elapsedMs).padStart(6)}ms  ${r.name}  ${r.count} 条`)
}

console.log('\n=== 报错明细 ===')
for (const r of rows.filter((r) => !r.ok)) {
    console.log(`  [${classify(r)}] ${r.name} :: ${r.error.replace(/\s+/g, ' ').slice(0, 120)}`)
}

if (OUT !== '') {
    writeFileSync(OUT, JSON.stringify(rows, null, 1))
    console.log(`\n明细已写入 ${OUT}`)
}
