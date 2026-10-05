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
 * 第五十一轮加了两层 —— 「源能搜到」与「那本书的字段填上了」是两件事：
 *
 *   1. **字段填充率**（零额外请求）：在搜索响应上直接数 name / author / intro /
 *      kind / coverUrl 各填了多少本。第四十五~五十轮修的多半是「这一格静默空着」
 *      （字段容错、单斜杠 XPath、`class.A B`），只看「有没有结果」是照不出来的。
 *   2. **封面真的取得到吗**（可选，`SCAN_COVERS=1`，默认开）：每个「有结果」的源取
 *      首本封面，走代取地址（`/api/media/…`）或原地址各试一次 —— 第四十七/四十八轮
 *      改的就是封面（防盗链、http 混合内容）。
 *
 * 输出：分类计数 + 字段填充率 + 封面存活 + 正文形态 + 每类样例 + （可选）SCAN_OUT 指定的 JSON 明细。
 *
 * 第七十一轮又加了一层 —— 「源能搜到」与「那本书**读得下去**」也不是同一件事：
 *
 *   3. **正文取回来是什么形态**（可选，`SCAN_CONTENT=1`，默认开）：对**有结果**的源
 *      再走三步（详情 → 目录 → 第一章正文），数长度、段数与**标签**。
 *      第七十轮那个 bug（`@html` 取回来的是原样 HTML、`<br>` 不变换行）挂的正是这一层：
 *      搜索那一栏全绿，点进去正文却是一堆字面标签、段落还糊成一坨。
 *      判据里 `正文里还有标签` 就是那一道修复的**回归哨兵**。
 */

import { writeFileSync } from 'node:fs'

const BASE = process.env.SMOKE_BASE ?? 'https://reader-api.liujieahu.workers.dev'
const KEYWORD = process.env.SCAN_KEYWORD ?? '斗破苍穹'
const STEP = Number(process.env.SCAN_STEP ?? '13')
const LIMIT = Number(process.env.SCAN_LIMIT ?? '60')
const GAP_MS = Number(process.env.SCAN_GAP_MS ?? '4000')
const OUT = process.env.SCAN_OUT ?? ''
/** 封面存活抽查：默认开，`SCAN_COVERS=0` 关掉 */
const COVERS = (process.env.SCAN_COVERS ?? '1') !== '0'
/** 最多抽查几张（每张一次请求，别有几十张的时候把时间耗在这上面） */
const COVER_MAX = Number(process.env.SCAN_COVER_MAX ?? '24')
/** 封面抽查的间隔：打的是我们自己的 /api/media 或上游图站，比搜索松一点 */
const COVER_GAP_MS = Number(process.env.SCAN_COVER_GAP_MS ?? '1200')

/** 正文层：默认开，`SCAN_CONTENT=0` 关掉（它每个源要再发三个请求，跑一轮会明显变慢） */
const CONTENT = (process.env.SCAN_CONTENT ?? '1') !== '0'
/** 最多抽几个源读正文（每源 3 个请求，别把时间全耗在这一层） */
const CONTENT_MAX = Number(process.env.SCAN_CONTENT_MAX ?? '20')
/** 正文层每一步之间的间隔；打的是**我们自己的 Worker**，所以照搜索那一层的节奏来 */
const CONTENT_GAP_MS = Number(process.env.SCAN_CONTENT_GAP_MS ?? '3000')
/** 响应不是 JSON 时（平台截断的特征）等这么久再问一次 */
const CONTENT_RETRY_MS = Number(process.env.SCAN_CONTENT_RETRY_MS ?? '8000')

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

/** 展示用字段：这几格坏了只留空（不报错），所以要单独量 */
const FIELD_KEYS = ['name', 'author', 'intro', 'kind', 'coverUrl']

const TAG_LIKE_SOURCE = '<[a-zA-Z/][^>]{0,120}>'
const TAG_LIKE = new RegExp(TAG_LIKE_SOURCE)
const TAG_LIKE_ALL = new RegExp(TAG_LIKE_SOURCE, 'g')

/**
 * 正文层分类：这一章的正文取回来是什么形态
 *
 * 最要紧的那一档是 `正文里还有标签` —— 它是第七十轮那道修复（正文里的 HTML 摊平）
 * 的**回归哨兵**。判据按「像不像标签」而不是「含 `<`」：小说正文里出现小于号是可能的
 * （`a<b`、`<3`），那不该被算成标签。标签名一并带出来，方便一眼看出是哪一种。
 */
export function classifyContent(row) {
    if (row.contentError) {
        // 先认**平台自己**的问题：它生成的错误页不是 JSON，与「上游站点坏了」是两回事
        if (/响应不是 JSON/.test(row.contentError)) return '被平台截断（非书源问题）'
        // 「没写正文规则」是书源自己的事，与「站点坏了」分开记
        if (/未配置正文规则/.test(row.contentError)) return '报错·书源没写正文规则'
        return classify({ ok: false, error: row.contentError })
    }
    if (row.contentKind && row.contentKind !== 'text') return `非文本源（${row.contentKind}）`
    if ((row.contentLen ?? 0) === 0) return '正文为空'
    if ((row.contentTags?.length ?? 0) > 0) return '正文里还有标签'
    return '取到正文'
}

/** 数一批书里各字段填了几本（`name` 是必填，正常应当 100%） */
function countFilled(books) {
    const out = {}
    for (const key of FIELD_KEYS) {
        out[key] = books.filter((b) => typeof b?.[key] === 'string' && b[key].trim() !== '').length
    }
    return out
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
        if (!hit) {
            rows.push({
                id: batchSource.id,
                type: batchSource.type ?? 0,
                name: batchSource.name,
                ok: false,
                count: 0,
                error: '（这一页没有回结果）',
                elapsedMs: 0,
                books: 0,
                fields: {},
                firstBook: null,
                firstCover: '',
                firstProxy: '',
            })
            continue
        }
        const books = Array.isArray(hit.books) ? hit.books : []
        rows.push({
            id: batchSource.id,
            type: batchSource.type ?? 0,
            name: hit.sourceName ?? batchSource.name,
            ok: hit.ok === true,
            count: hit.count ?? 0,
            error: String(hit.error ?? ''),
            elapsedMs: hit.elapsedMs ?? 0,
            books: books.length,
            fields: countFilled(books),
            // 正文层要用：搜到的那本书本身（不再重搜一遍）
            firstBook: books[0]
                ? { name: books[0].name, author: books[0].author, bookUrl: books[0].bookUrl }
                : null,
            firstCover: String(books[0]?.coverUrl ?? ''),
            firstProxy: String(books[0]?.coverProxyUrl ?? ''),
        })
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

/**
 * 字段填充率
 *
 * 只在**有结果**的那批里算：搜不到的源本来就没有字段可填，混进来会把水搅浑。
 */
const withBooks = rows.filter((r) => r.books > 0)
const totalBooks = withBooks.reduce((sum, r) => sum + r.books, 0)
console.log(`\n=== 字段填充率（${withBooks.length} 个有结果的源，共 ${totalBooks} 本书）===`)
if (totalBooks > 0) {
    for (const key of FIELD_KEYS) {
        const n = withBooks.reduce((sum, r) => sum + (r.fields?.[key] ?? 0), 0)
        const pct = ((n / totalBooks) * 100).toFixed(0)
        console.log(`  ${key.padEnd(9)} ${String(n).padStart(4)}  ${pct}%`)
    }
}

if (COVERS) {
    const targets = withBooks.filter((r) => r.firstProxy !== '' || r.firstCover !== '')
    const picked = targets.slice(0, COVER_MAX)
    console.log(`\n=== 封面（每个有结果的源取首本，抽 ${picked.length} 张）===`)
    let proxyOk = 0
    let proxyBad = 0
    let directOk = 0
    let directBad = 0
    for (const r of picked) {
        // 有代取地址就走代取（第四十七/四十八轮那条路），否则按浏览器直连量
        const viaProxy = r.firstProxy !== ''
        const url = viaProxy ? BASE + r.firstProxy : r.firstCover
        let line = ''
        try {
            const res = await fetch(url)
            const type = res.headers.get('content-type') ?? ''
            const isImg = res.status === 200 && type.startsWith('image/')
            if (viaProxy) {
                if (isImg) proxyOk += 1
                else proxyBad += 1
            } else if (isImg) {
                directOk += 1
            } else {
                directBad += 1
            }
            line = `${isImg ? 'OK  ' : 'BAD '} ${res.status} ${type.padEnd(16)} ${viaProxy ? '代取' : '直连'}  ${r.name}`
        } catch (err) {
            if (viaProxy) proxyBad += 1
            else directBad += 1
            line = `ERR  ${String(err.message).slice(0, 32).padEnd(34)} ${viaProxy ? '代取' : '直连'}  ${r.name}`
        }
        console.log(`  ${line}`)
        await sleep(COVER_GAP_MS)
    }
    console.log(
        `  → 代取：取到图 ${proxyOk} / 取不到 ${proxyBad}    直连：取到图 ${directOk} / 取不到 ${directBad}`,
    )
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

if (CONTENT) {
    /**
     * 正文层：对**有结果**的源走三步（详情 → 目录 → 第一章正文）
     *
     * 只抽文本源（`bookSourceType = 0`）：图片 / 音频 / 文件源本来就没有「正文文本」，
     * 混进来只会让 `非文本源` 那一档虚高。目录里的**卷标题**也跳过 ——
     * 它不是章，取正文必然什么都没有。
     */
    const targets = rows
        .filter((r) => r.books > 0 && r.firstBook && (r.type ?? 0) === 0)
        .slice(0, CONTENT_MAX)
    console.log(`\n=== 正文（抽 ${targets.length} 个有结果的文本源，各取第一章）===`)

    // 先歇一会儿再开工：搜索那一层刚连着打了二十多批，CPU 窗口这时候最容易被截
    await sleep(CONTENT_RETRY_MS)

    /**
     * 取一步；**响应不是 JSON 时重试一次**
     *
     * 为什么必须重试：这一层打的是**我们自己的 Worker**，而免费计划那个 10 ms 的 CPU
     * 窗口在成串请求之后会把请求直接截掉 —— 响应不是 JSON，于是 `json?.tocUrl` 取不到，
     * 看起来就像「这个书源没有 tocUrl 规则」。第一次跑这一层时 18 个源里 16 个报
     * 「没有 tocUrl」，而分类里连一条 503 都没有：**平台限制被记成了书源的问题**。
     * 抽检最忌讳这个（上一轮那份「源有问题」的结论就是这么来的），
     * 所以宁可多等一会儿再问一次，并把这个「等过一次」的事实一起报出来。
     */
    let retried = 0
    const step = async (path) => {
        let last = { status: 0, json: null }
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await sleep(attempt === 0 ? CONTENT_GAP_MS : CONTENT_RETRY_MS)
            const res = await fetch(BASE + path)
            const text = await res.text()
            let json = null
            try {
                json = JSON.parse(text)
            } catch {
                /* 不是 JSON：多半是平台自己生成的错误页 */
            }
            last = { status: res.status, json }
            if (json !== null) return last
        }
        retried += 1
        return { ...last, note: `HTTP ${last.status}，响应不是 JSON（重试一次仍然如此）` }
    }

    for (const r of targets) {
        const hint = JSON.stringify(r.firstBook)
        const src = `sourceId=${encodeURIComponent(r.id)}`
        try {
            const info = await step(
                `/api/book?${src}&url=${encodeURIComponent(r.firstBook.bookUrl)}&book=${encodeURIComponent(hint)}`,
            )
            if (!info.json?.tocUrl) {
                r.contentError = info.note ?? `详情页：${info.json?.error ?? '没有 tocUrl'}`
                continue
            }
            const toc = await step(
                `/api/toc?${src}&url=${encodeURIComponent(info.json.tocUrl)}&book=${encodeURIComponent(hint)}`,
            )
            const chapters = (toc.json?.chapters ?? []).filter((c) => !c.isVolume)
            if (chapters.length === 0) {
                r.contentError = toc.note ?? `目录：${toc.json?.error ?? '0 章'}`
                continue
            }
            const chapter = chapters[0]
            const chapterCtx = JSON.stringify({ title: chapter.name, index: 0, url: chapter.url })
            const got = await step(
                `/api/content?${src}&url=${encodeURIComponent(chapter.url)}&book=${encodeURIComponent(hint)}&chapter=${encodeURIComponent(chapterCtx)}`,
            )
            if (!got.json || got.json.error) {
                r.contentError = got.note ?? `正文：${got.json?.error ?? `HTTP ${got.status}`}`
                continue
            }
            r.contentKind = got.json.kind
            r.contentChapter = chapter.name
            if (got.json.kind === 'text') {
                const text = String(got.json.content ?? '')
                r.contentLen = text.length
                r.contentParas = text.split('\n').filter((line) => line.trim() !== '').length
                r.contentTags = [...new Set(text.match(TAG_LIKE_ALL) ?? [])].slice(0, 4)
                r.contentHead = text.slice(0, 80).replace(/\s+/g, ' ')
            }
        } catch (err) {
            r.contentError = String(err.message)
        }
    }

    const contentTally = new Map()
    for (const r of targets) {
        const kind = classifyContent(r)
        contentTally.set(kind, (contentTally.get(kind) ?? 0) + 1)
    }
    for (const r of targets) {
        const kind = classifyContent(r)
        let detail = ''
        if (r.contentError) detail = String(r.contentError).replace(/\s+/g, ' ').slice(0, 80)
        else if (r.contentKind && r.contentKind !== 'text') detail = r.contentKind
        else
            detail =
                `${r.contentLen ?? 0} 字 / ${r.contentParas ?? 0} 段` +
                (r.contentTags?.length ? ` / 标签 ${JSON.stringify(r.contentTags)}` : '')
        console.log(
            `  ${kind === '取到正文' ? 'OK  ' : 'BAD '} ${kind.padEnd(16)} ${r.name}  ${detail}`,
        )
    }
    console.log(
        '  → ' +
            [...contentTally.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([kind, n]) => `${kind} ${n}`)
                .join('    ') +
            (retried > 0 ? `    （其中 ${retried} 步重试一次仍不是 JSON，算作平台截断）` : ''),
    )
}

if (OUT !== '') {
    writeFileSync(OUT, JSON.stringify(rows, null, 1))
    console.log(`\n明细已写入 ${OUT}`)
}
