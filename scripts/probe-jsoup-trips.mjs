/**
 * 量「桥的宿主往返」这条账：一条 jsoup 规则要过多少次桥
 *
 * 为什么需要它
 * ------------
 * `__listOf`（把一个集合变成「数组形态的 Elements」）以前对**每个元素**做
 * `size` → `get(i)` → `outerHtml` 三次往返，而每次往返都要过一遍 JSON + QuickJS 宿主调用。
 * 第七十六轮把它改成宿主侧一次做完（桥的 `list` op）—— 那一轮要的是**改动前后**的数字，
 * 而「元素数 × 常数」这种账从代码里能算，真正要量的是**总耗时**。
 *
 * 做法：临时导入一条书源，它的 `bookList` 是一段 `@js:`：
 *
 *     var d = org.jsoup.Jsoup.parse(result);   // 整页
 *     var a = d.select('a');                   // 一次选出成百上千个节点
 *     a.map(e => ({ text: e.text(), href: e.attr('href') }))
 *
 * 打的是内置测试站点的搜索页（`?n=` 控制书数，最多 600）—— 一页上千个 `<a>`，
 * 正好把 `__listOf` 的 n 撑大。响应里的条数就是 n。
 *
 *   BASE=http://127.0.0.1:8787 N=600 RUNS=5 node scripts/probe-jsoup-trips.mjs
 *
 * 输出里那两行「老 / 新」是按 n **算出来**的往返次数，不是量出来的：
 * 老实现 `1 + 2n`（`size` 一次 + 每个元素 `get` 与 `outerHtml` 各一次），
 * 新实现 `1`。耗时是量出来的。改动前后各跑一次这个脚本就能拿到两个耗时 ——
 * 第七十六轮那次的结果记在 README 里。
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const N = Number(process.env.N ?? '600')
const RUNS = Number(process.env.RUNS ?? '5')
/** 书源地址用这个假路径当身份，导入后可整条删掉 */
const SOURCE_URL = `${BASE}/probe-jsoup-trips`
const SOURCE_ID = `user:${SOURCE_URL}`

/** 那条用来量往返的规则（见文件头） */
const BOOK_LIST = [
    '@js:',
    'var d = org.jsoup.Jsoup.parse(result);',
    "var a = d.select('a');",
    "a.map(function (e) { return { text: e.text(), href: e.attr('href') } })",
].join('\n')

async function call(method, path, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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
    console.error(`内置测试站点没开（ENABLE_FIXTURE=true 才有它）—— /fixture/search 返回 ${fixture.status}`)
    console.error('自建那份：$env:ENABLE_FIXTURE="true"; node dist-node/server.mjs')
    process.exit(1)
}

/** 先清掉上一次留下的那条（重复导入会变成改一条，量出来的就不是干净状态了） */
await call('DELETE', `/api/sources?id=${encodeURIComponent(SOURCE_ID)}`)

const imported = await call(
    'POST',
    '/api/sources',
    JSON.stringify([
        {
            bookSourceName: `探针：jsoup 往返（${N} 个节点）`,
            bookSourceUrl: SOURCE_URL,
            bookSourceGroup: '探针',
            enabled: true,
            searchUrl: `${BASE}/fixture/search?q={{key}}&p={{page}}&n=${N}`,
            ruleSearch: {
                bookList: BOOK_LIST,
                name: 'text',
                bookUrl: 'href',
            },
        },
    ]),
)
if (imported.status !== 200) {
    console.error(`导入探针书源失败：${imported.status} ${imported.text.slice(0, 200)}`)
    process.exit(1)
}

const times = []
let nodes = 0
let failure = ''
for (let i = 0; i < RUNS; i += 1) {
    const res = await call('POST', '/api/search', { keyword: '测试', sourceIds: [SOURCE_ID] })
    const one = res.json?.sources?.[0]
    if (!one || one.ok !== true) {
        failure = `${res.status} ${one?.error ?? res.text.slice(0, 160)}`
        break
    }
    nodes = Math.max(nodes, one.count ?? 0)
    times.push(one.elapsedMs ?? 0)
}

await call('DELETE', `/api/sources?id=${encodeURIComponent(SOURCE_ID)}`)

if (failure !== '') {
    console.error(`搜索失败：${failure}`)
    process.exit(1)
}

times.sort((a, b) => a - b)
const median = times[Math.floor(times.length / 2)] ?? 0

console.log(`节点数 ${nodes}（= select('a') 命中的节点数） · ${RUNS} 次取中位`)
console.log(`  耗时中位 ${median}ms（${times.join(' / ')}）`)
console.log('  宿主往返次数（按元素数算，不是量的）：')
console.log(`    老实现 1 + 2n = ${1 + 2 * nodes} 次   ← \`size\` 一次 + 每个元素 \`get\` 与 \`outerHtml\` 各一次`)
console.log(`    新实现 1       = 1 次                ← 桥的 \`list\` op 一次把句柄与 outerHTML 都带回来`)
console.log(`    另有每节点 2 次（\`text\` / \`attr\`）两边都一样，共 ${2 * nodes} 次，抵掉之后净省 ${2 * nodes} 次`)
