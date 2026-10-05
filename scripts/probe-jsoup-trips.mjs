/**
 * 量「桥的宿主往返」这条账：一条 jsoup 规则要过多少次桥、过桥值多少时间
 *
 * 为什么需要它
 * ------------
 * `__listOf`（把一个集合变成「数组形态的 Elements」）以前对**每个元素**做
 * `size` → `get(i)` → `outerHtml` 三次往返。第七十六轮把它改成宿主侧一次做完
 * （桥的 `list` op），并且顺带把「属性表 + 叶节点的文本」一起带回来，
 * 于是逐节点 `attr('href')` / `text()` 也不必再过桥（第七十七轮）。
 *
 * 这条脚本要回答的是**剩下多少**：它跑**两条只有一处不同**的规则 ——
 * 一条只读预取过的字段（`text` + `attr`），一条读没预取的（`ownText`）——
 * 两者的往返次数与耗时之差，就是「过桥」这件事的净成本。
 *
 *   BASE=http://127.0.0.1:8787 N=600 RUNS=5 node scripts/probe-jsoup-trips.mjs
 *
 * 打的是内置测试站点的搜索页（`?n=` 控制书数，最多 600）—— 一页上千个 `<a>`，
 * 正好把 n 撑大。响应里的条数就是 n。
 *
 * 输出里那两行「老 / 新」是按 n **算出来**的往返次数，不是量出来的：
 * 第七十六轮之前的实现是 `1 + 2n`（`size` 一次 + 每个元素 `get` 与 `outerHtml` 各一次），
 * 现在是 `1`。耗时是量出来的。
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const N = Number(process.env.N ?? '600')
const RUNS = Number(process.env.RUNS ?? '5')

/** 两条规则只差一处：`text()` 预取了、`ownText()` 没有 */
const VARIANTS = [
    {
        tag: 'A 只读预取过的字段',
        /** 每节点两次调用，都不过桥 */
        body: [
            'var d = org.jsoup.Jsoup.parse(result);',
            "var a = d.select('a');",
            "a.map(function (e) { return { text: e.text(), href: e.attr('href') } })",
        ].join('\n'),
        hostCalls: 0,
    },
    {
        tag: 'B 每节点过一次桥（ownText）',
        body: [
            'var d = org.jsoup.Jsoup.parse(result);',
            "var a = d.select('a');",
            "a.map(function (e) { return { text: e.ownText(), href: e.attr('href') } })",
        ].join('\n'),
        /** 每个节点一次 */
        hostCalls: 1,
    },
]

async function call(method, path, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body:
            body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try {
        json = JSON.parse(text)
    } catch {
        /* 非 JSON 时把原文交给调用方打印 */
    }
    return { status: res.status, json, text }
}

const health = await call('GET', '/api/probe')
if (health.status !== 200) {
    console.error(`服务没起来：/api/probe 返回 ${health.status}`)
    process.exit(1)
}
// 探针要打内置测试站点，所以先确认它真的挂着（`ENABLE_FIXTURE=true` 才有）
const fixture = await call('GET', '/fixture/search?q=%E6%B5%8B%E8%AF%95&p=1&n=1')
if (fixture.status !== 200) {
    console.error(
        `内置测试站点没开（ENABLE_FIXTURE=true 才有它）—— /fixture/search 返回 ${fixture.status}`,
    )
    console.error('自建那份：$env:ENABLE_FIXTURE="true"; node dist-node/server.mjs')
    process.exit(1)
}

const results = []
let nodes = 0
for (const variant of VARIANTS) {
    const sourceUrl = `${BASE}/probe-jsoup-trips-${variant.hostCalls}`
    const id = `user:${sourceUrl}`
    /** 先清掉上一次留下的那条（重复导入会变成改一条，量出来的就不是干净状态了） */
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    const imported = await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: `探针：jsoup 往返（${variant.tag}）`,
                bookSourceUrl: sourceUrl,
                bookSourceGroup: '探针',
                enabled: true,
                searchUrl: `${BASE}/fixture/search?q={{key}}&p={{page}}&n=${N}`,
                ruleSearch: { bookList: `@js:\n${variant.body}`, name: 'text', bookUrl: 'href' },
            },
        ]),
    )
    if (imported.status !== 200) {
        console.error(`导入探针书源失败：${imported.status} ${imported.text.slice(0, 200)}`)
        process.exit(1)
    }

    const times = []
    let failure = ''
    for (let i = 0; i < RUNS; i += 1) {
        const res = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
        const one = res.json?.sources?.[0]
        if (!one || one.ok !== true) {
            failure = `${res.status} ${one?.error ?? res.text.slice(0, 160)}`
            break
        }
        nodes = Math.max(nodes, one.count ?? 0)
        times.push(one.elapsedMs ?? 0)
    }
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    if (failure !== '') {
        console.error(`【${variant.tag}】搜索失败：${failure}`)
        process.exit(1)
    }
    times.sort((a, b) => a - b)
    results.push({ ...variant, median: times[Math.floor(times.length / 2)] ?? 0, times })
}

console.log(`节点数 ${nodes}（= select('a') 命中的节点数） · ${RUNS} 次取中位\n`)
for (const one of results) {
    console.log(`【${one.tag}】中位 ${one.median}ms（${one.times.join(' / ')}）`)
}
const [a, b] = results
if (a && b) {
    const spread = Math.max(...a.times) - Math.min(...a.times)
    console.log(`\n每节点多过一次桥 → 多花 ${b.median - a.median}ms（${nodes} 个节点）`)
    console.log(
        `  抖动提示：同一条规则连跑 ${RUNS} 次的极差就有 ${spread}ms —— 差值小于它时**别当结论**。`,
    )
    console.log(
        `  这一趟测的是**整条 HTTP 请求**（取页面 + 解析 + 建沙箱 + 序列化响应都算在内），` +
            `过桥只是其中一小块；要单独量它得把沙箱那一层拎出来直测（见 EXPERIENCE.md 第七十七轮的数字）。`,
    )
}
console.log('\n宿主往返次数（按元素数算，不是量的）：')
console.log(`  A 每节点 0 次 = 4 次（parse / select / 两次取整串）`)
console.log(`  B 每节点 1 次 = ${4 + nodes} 次`)
console.log(`  第七十六轮之前的实现则是 1 + 2n = ${1 + 2 * nodes} 次 ← 当年那笔账`)
