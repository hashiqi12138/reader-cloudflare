/**
 * 端到端冒烟：搜索 → 详情 → 目录 → 正文
 *
 * 需要本地 dev server 已在跑（npm run dev，且 ENABLE_FIXTURE=true）。
 * 打的是**真实 HTTP**，走完整条链路，因此能抓到单测覆盖不到的问题：
 * 路由没挂上、asset 与 Worker 的先后顺序不对、字符集解码出错等等。
 *
 * 除了逐源跑通，还会**对照三种规则方言**（CSS / XPath / JS+java.ajax）在同一个
 * 页面上的提取结果 —— 只测一套的话，另一条路径上的问题会被掩盖。
 *
 *   npm run dev          # 另开一个终端
 *   npm run smoke
 */

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787'

const failures = []
function check(ok, label, extra = '') {
    console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${extra ? '  ' + extra : ''}`)
    if (!ok) failures.push(label)
}

function parseMaybeJson(text) {
    try {
        return text === '' ? null : JSON.parse(text)
    } catch {
        return null
    }
}

async function getJson(path) {
    const response = await fetch(BASE + path)
    const text = await response.text()
    return { status: response.status, json: parseMaybeJson(text), text }
}

/**
 * 带请求体的调用。写一次给下面各段共用 ——
 * 之前每段各抄一份，其中一份漏了「已经是字符串就不再序列化」这一条，
 * 结果导入接口收到一个 JSON 字符串而不是数组，报 invalid_shape，
 * 表面上却像是「书源没导进去」。复制粘贴的 helper 就是这么坏的。
 */
async function call(method, path, body) {
    const response = await fetch(BASE + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        // 已经是字符串就当作原始 JSON 文本发送（导入接口吃的就是书源 JSON 原文）
        body:
            body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, json: parseMaybeJson(text), text }
}

console.log('=== 1. 运行时自检（cheerio + QuickJS） ===')
{
    const probe = await getJson('/api/probe')
    check(probe.status === 200, 'GET /api/probe 返回 200', `status=${probe.status}`)
    check(
        probe.json?.cheerio?.text === '斗破苍穹',
        'cheerio 能正确解析中文',
        JSON.stringify(probe.json?.cheerio),
    )
    check(
        typeof probe.json?.quickjs?.value === 'string' &&
            probe.json.quickjs.value.includes('经 QuickJS 处理'),
        'QuickJS 沙箱能执行脚本',
        JSON.stringify(probe.json?.quickjs),
    )
}

console.log('\n=== 2. 书源列表 ===')
const sources = await getJson('/api/sources')
check(sources.status === 200, 'GET /api/sources 返回 200')
const list = sources.json?.sources ?? []
// 必须是三个：对照验证要求 CSS / XPath / JS 三条路径都在场
check(list.length >= 3, '三个测试书源齐备（CSS / XPath / JS 各一）', `count=${list.length}`)
if (list.length === 0) {
    console.error('\n没有可用书源。是否忘记在 .dev.vars 里设置 ENABLE_FIXTURE=true？')
    process.exit(1)
}

/** 跑完整条链路，返回各步结果 */
async function runChain(source, label) {
    const searchResponse = await fetch(`${BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: '测试', sourceIds: [source.id] }),
    })
    const searchJson = await searchResponse.json()
    const perSource = searchJson.sources?.[0]

    check(
        searchResponse.status === 200,
        `[${label}] 搜索返回 200`,
        `status=${searchResponse.status}`,
    )
    check(perSource?.ok === true, `[${label}] 搜索未报错`, perSource?.error ?? '')
    const books = perSource?.books ?? []
    check(books.length > 0, `[${label}] 搜到书籍`, `count=${books.length}`)
    if (books.length === 0) return null

    const book = books[0]
    check(
        Boolean(book.name && book.author && book.bookUrl),
        `[${label}] 书名/作者/地址齐全`,
        book.name,
    )

    const info = await getJson(
        `/api/book?sourceId=${encodeURIComponent(source.id)}&url=${encodeURIComponent(book.bookUrl)}`,
    )
    check(
        Boolean(info.json?.tocUrl),
        `[${label}] 拿到目录地址`,
        info.json?.tocUrl ?? info.json?.error ?? '',
    )
    if (!info.json?.tocUrl) return null

    const toc = await getJson(
        `/api/toc?sourceId=${encodeURIComponent(source.id)}&url=${encodeURIComponent(info.json.tocUrl)}`,
    )
    const chapters = toc.json?.chapters ?? []
    check(
        chapters.length > 0,
        `[${label}] 拿到章节列表`,
        // 失败时必须把上游给的错误带出来，否则只剩一个 count=0，无从下手
        toc.json?.error ?? `count=${chapters.length}`,
    )
    if (chapters.length === 0) return null

    const content = await getJson(
        `/api/content?sourceId=${encodeURIComponent(source.id)}&url=${encodeURIComponent(chapters[0].url)}`,
    )
    const text = String(content.json?.content ?? '')
    check(text.length > 0, `[${label}] 正文非空`, content.json?.error ?? `length=${text.length}`)
    check(
        text.includes('正文第一段'),
        `[${label}] 正文内容符合预期`,
        text.length ? JSON.stringify(text.slice(0, 80)) : '',
    )

    return {
        bookNames: books.map((b) => b.name),
        authors: books.map((b) => b.author),
        chapterNames: chapters.map((c) => c.name),
        content: text,
    }
}

console.log('\n=== 3. 逐源跑通链路 ===')
const results = {}
for (const source of list) {
    console.log(`\n--- ${source.name} ---`)
    results[source.id] = await runChain(source, source.id)
}

console.log('\n=== 4. 多方言对照 ===')
const succeeded = Object.entries(results).filter(([, r]) => r !== null)
const failedIds = Object.entries(results)
    .filter(([, r]) => r === null)
    .map(([id]) => id)
// 对照验证的前提是「参与对照的方言一个都不能少」：某个源挂了就自动降级成两方比对，
// 会把挂掉那条路径上的问题一起放行 —— 那正是这套对照要防的事，所以这里是硬失败。
check(
    failedIds.length === 0,
    '所有书源都跑通（对照集合必须完整）',
    failedIds.length ? `未跑通：${failedIds.join('、')}` : '',
)
if (succeeded.length < 2) {
    check(false, '至少两个书源跑通（对照的前提）', `实际跑通 ${succeeded.length} 个`)
} else {
    const [baseId, base] = succeeded[0]
    for (const [id, other] of succeeded.slice(1)) {
        check(
            JSON.stringify(base.bookNames) === JSON.stringify(other.bookNames),
            `${baseId} 与 ${id} 的书名一致`,
            JSON.stringify(other.bookNames),
        )
        check(
            JSON.stringify(base.authors) === JSON.stringify(other.authors),
            `${baseId} 与 ${id} 的作者一致`,
        )
        check(
            JSON.stringify(base.chapterNames) === JSON.stringify(other.chapterNames),
            `${baseId} 与 ${id} 的章节名一致`,
        )
        check(base.content === other.content, `${baseId} 与 ${id} 的正文逐字一致`)
        if (base.content !== other.content) {
            console.log(`  ${baseId}:`, JSON.stringify(base.content.slice(0, 200)))
            console.log(`  ${id}:`, JSON.stringify(other.content.slice(0, 200)))
        }
    }
    console.log(`\n  正文预览（${baseId}）:`)
    console.log(
        base.content
            .split('\n')
            .map((line) => '        ' + line)
            .join('\n'),
    )
}

console.log('\n=== 5. 书源管理（D1） ===')
{
    const importedId = `user:${BASE}`

    // 先清掉上一次可能留下的同一条：本地 D1 是持久的，否则重复运行会越积越多
    await fetch(`${BASE}/api/sources?id=${encodeURIComponent(importedId)}`, { method: 'DELETE' })

    const baseline = (await getJson('/api/sources')).json?.sources?.length ?? 0

    // 这份书源用 @css: 规则打内置测试站点，因此**导入进来的书源必须真的能跑通全链路** ——
    // 这才是 D1 的意义：书源来自库里，而不是写死在代码里
    const importBody = JSON.stringify([
        {
            bookSourceName: '导入测试源（CSS 规则）',
            bookSourceUrl: BASE,
            bookSourceGroup: '导入测试',
            enabled: true,
            searchUrl: `${BASE}/fixture/search?q={{key}}&p={{page}}`,
            ruleSearch: {
                bookList: '@css:div.result-item',
                name: '@css:h3.title@text',
                author: '@css:span.author@text',
                bookUrl: '@css:h3.title a@href',
            },
            ruleBookInfo: {
                name: '@css:h1.book-name@text',
                author: '@css:span.book-author@text',
                tocUrl: '@css:a.toc-link@href',
            },
            ruleToc: {
                chapterList: '@css:ul.chapter-list li',
                chapterName: '@css:a@text',
                chapterUrl: '@css:a@href',
            },
            ruleContent: { content: '@css:div#content@textNodes' },
        },
    ])

    const first = await call('POST', '/api/sources', importBody)
    check(
        first.status === 200 && first.json?.imported === 1,
        '导入一条新书源',
        JSON.stringify(first.json),
    )

    const afterImport = await getJson('/api/sources')
    check(
        afterImport.json?.sources?.length === baseline + 1,
        '列表里多出一条',
        `baseline=${baseline} now=${afterImport.json?.sources?.length}`,
    )
    const imported = afterImport.json?.sources?.find((s) => s.id === importedId)
    check(imported?.builtin === false, '导入的条目不是内置源', JSON.stringify(imported))

    const searching = await fetch(`${BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: '测试', sourceIds: [importedId] }),
    })
    const searchJson = await searching.json()
    const searchBooks = searchJson.sources?.[0]?.books ?? []
    check(
        searchBooks.length === 2,
        '导入的书源能真正驱动引擎（搜到 2 本）',
        searchJson.sources?.[0]?.error ?? `count=${searchBooks.length}`,
    )

    const again = await call('POST', '/api/sources', importBody)
    check(
        again.status === 200 && again.json?.updated === 1 && again.json?.imported === 0,
        '重复导入同一地址算更新而不是新增',
        JSON.stringify(again.json),
    )
    check(
        (await getJson('/api/sources')).json?.sources?.length === baseline + 1,
        '重复导入后列表长度没变',
    )

    const badJson = await call('POST', '/api/sources', '这不是 JSON')
    check(
        badJson.status === 400 && badJson.json?.code === 'invalid_json',
        '非 JSON 内容被拒（400 invalid_json）',
        JSON.stringify(badJson.json),
    )

    const empty = await call('POST', '/api/sources', '[]')
    check(
        empty.status === 400 && empty.json?.code === 'empty_import',
        '空数组被拒（400 empty_import）',
        JSON.stringify(empty.json),
    )

    const partial = await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            { bookSourceName: '缺地址的源' },
            { bookSourceName: '协议不对的源', bookSourceUrl: 'ftp://example.com' },
            { bookSourceName: '可以用的源', bookSourceUrl: 'https://example.com' },
        ]),
    )
    check(
        partial.status === 200 &&
            partial.json?.imported === 1 &&
            partial.json?.rejected?.length === 2,
        '坏条目被逐条拒绝、好条目照常导入',
        JSON.stringify(partial.json),
    )
    // 上面那条 https://example.com 是导入来当反例的，验证完就删掉，别留在库里
    await call('DELETE', '/api/sources?id=' + encodeURIComponent('user:https://example.com'))

    const disabled = await call('PATCH', '/api/sources', { id: importedId, enabled: false })
    check(
        disabled.status === 200 && disabled.json?.enabled === false,
        '停用书源',
        JSON.stringify(disabled.json),
    )

    const afterDisable = await fetch(`${BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: '测试', sourceIds: [importedId] }),
    }).then((r) => r.json())
    check(
        afterDisable.sourceCount === 0,
        '停用后搜索不再使用它',
        `sourceCount=${afterDisable.sourceCount}`,
    )

    const builtinDelete = await call(
        'DELETE',
        '/api/sources?id=' + encodeURIComponent('builtin:fixture-css'),
    )
    check(
        builtinDelete.status === 400 && builtinDelete.json?.code === 'builtin_readonly',
        '内置源不允许删除（400 builtin_readonly）',
        JSON.stringify(builtinDelete.json),
    )

    const removed = await call('DELETE', '/api/sources?id=' + encodeURIComponent(importedId))
    check(
        removed.status === 200 && removed.json?.deleted === true,
        '删除书源',
        JSON.stringify(removed.json),
    )

    const afterDelete = await getJson('/api/sources')
    check(
        afterDelete.json?.sources?.length === baseline,
        '删除后回到导入前的数量',
        `expect=${baseline} now=${afterDelete.json?.sources?.length}`,
    )
}

console.log('\n=== 6. 前端静态资源 ===')
{
    // 静态资源是「先查 assets、匹配不到才进 Worker」的，而接口必须反着来。
    // 这两条规则一旦配错，表现是「页面能开、接口全 404」或者「接口正常、页面是接口的 404」，
    // 都很容易被误判成前端写错了。所以这里直接钉住两边。
    const page = await fetch(BASE + '/')
    const pageText = await page.text()
    check(page.status === 200, '/ 返回 200', `status=${page.status}`)
    check(
        (page.headers.get('content-type') ?? '').includes('text/html'),
        '/ 的 content-type 是 HTML',
        page.headers.get('content-type') ?? '',
    )
    check(pageText.includes('id="view"'), '页面里有挂载点 #view')

    for (const asset of ['/app.js', '/style.css']) {
        const response = await fetch(BASE + asset)
        check(response.status === 200, `${asset} 返回 200`, `status=${response.status}`)
        check((await response.text()).length > 500, `${asset} 不是空文件`)
    }

    // 未命中的接口必须由 Worker 回 JSON 404，而不是被 SPA 回退喂成 index.html
    const missing = await fetch(BASE + '/api/not-a-real-endpoint')
    const missingType = missing.headers.get('content-type') ?? ''
    check(
        missing.status === 404 && missingType.includes('application/json'),
        '未命中的 /api/* 回 JSON 404（没有被 SPA 回退吃掉）',
        `status=${missing.status} type=${missingType}`,
    )
}

console.log('\n=== 7. 书架与阅读进度 ===')
{
    const sourceId = 'builtin:fixture-css'
    const bookUrl = `${BASE}/fixture/book/1`
    const chapterUrl = `${BASE}/fixture/chapter/1/1`

    const shelfOf = async () => (await getJson('/api/shelf')).json?.entries ?? []

    // 清掉上一次可能留下的条目，保证可重复运行
    const existing = (await shelfOf()).find((e) => e.sourceId === sourceId && e.bookUrl === bookUrl)
    if (existing) await call('DELETE', `/api/shelf?key=${encodeURIComponent(existing.bookKey)}`)

    const baseline = (await shelfOf()).length

    const added = await call('POST', '/api/shelf', {
        sourceId,
        bookUrl,
        name: '测试小说·甲',
        author: '测试作者',
    })
    check(
        added.status === 201 && added.json?.created === true,
        '加入书架（首次返回 201 created）',
        JSON.stringify(added.json?.created),
    )
    check((await shelfOf()).length === baseline + 1, '书架条目数加一')

    const again = await call('POST', '/api/shelf', {
        sourceId,
        bookUrl,
        name: '测试小说·甲',
        author: '测试作者',
    })
    check(
        again.status === 200 && again.json?.created === false,
        '重复加入不产生第二条（200 created=false）',
        JSON.stringify(again.json?.created),
    )
    check((await shelfOf()).length === baseline + 1, '重复加入后条目数没变')

    const beforeRead = (await shelfOf()).find((e) => e.sourceId === sourceId) ?? {}
    check(
        beforeRead.chapterName === null,
        '没读过时进度为空',
        JSON.stringify(beforeRead.chapterName),
    )

    const saved = await call('PUT', '/api/progress', {
        sourceId,
        bookUrl,
        chapterUrl,
        chapterName: '第一章 起风了',
        chapterIndex: 0,
    })
    check(
        saved.status === 200 && saved.json?.progress?.chapterIndex === 0,
        '写入阅读进度',
        JSON.stringify(saved.json?.progress),
    )

    const afterRead = (await shelfOf()).find((e) => e.sourceId === sourceId) ?? {}
    check(
        afterRead.chapterName === '第一章 起风了' && afterRead.chapterIndex === 0,
        '书架列表带出阅读位置（LEFT JOIN 生效）',
        JSON.stringify({ name: afterRead.chapterName, index: afterRead.chapterIndex }),
    )

    const readBack = await getJson(
        `/api/progress?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
    )
    check(
        readBack.json?.progress?.chapterUrl === chapterUrl,
        '按书源 + 书籍地址读回进度',
        JSON.stringify(readBack.json?.progress?.chapterUrl),
    )

    const advanced = await call('PUT', '/api/progress', {
        sourceId,
        bookUrl,
        chapterUrl: `${BASE}/fixture/chapter/1/2`,
        chapterName: '第二章',
        chapterIndex: 1,
    })
    check(
        advanced.json?.progress?.chapterIndex === 1,
        '进度可以往前推',
        JSON.stringify(advanced.json?.progress?.chapterIndex),
    )

    const removed = await call(
        'DELETE',
        `/api/shelf?key=${encodeURIComponent(afterRead.bookKey ?? '')}`,
    )
    check(
        removed.status === 200 && removed.json?.name === '测试小说·甲',
        '移出书架',
        JSON.stringify(removed.json),
    )
    check((await shelfOf()).length === baseline, '移出后回到原来的条目数')

    const progressGone = await getJson(
        `/api/progress?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
    )
    check(
        progressGone.json?.progress === null,
        '移出书架时进度一并清掉（不留孤儿进度）',
        JSON.stringify(progressGone.json?.progress),
    )

    const removeAgain = await call(
        'DELETE',
        `/api/shelf?key=${encodeURIComponent(afterRead.bookKey ?? '')}`,
    )
    check(
        removeAgain.status === 404 && removeAgain.json?.code === 'shelf_entry_not_found',
        '重复移出报 404 shelf_entry_not_found',
        JSON.stringify(removeAgain.json?.code),
    )
}

console.log('\n=== 8. 相对地址以书源地址为基准 ===')
{
    // 这条是真实书源逼出来的：精华书阁、圣武书库这类书源的 searchUrl 写的是
    // `/search.html?word={{key}}` 这种**相对路径**，Legado 拿 bookSourceUrl 当基准。
    // 如果错拿「当前请求的来源」（也就是我们自己的域名）当基准，请求会打到 Worker 自己身上，
    // 而 SPA 回退还会回 200 + 首页 HTML，规则照样能从首页里抠出链接 ——
    // 表现是「搜索成功、有结果」，但结果是本站首页里的东西。全程不报任何错。

    const NOTHING_LISTENING = 'http://127.0.0.1:59999/'

    const makeSource = (name, url, searchUrl) => ({
        bookSourceName: name,
        bookSourceUrl: url,
        group: '地址基准测试',
        searchUrl,
        ruleSearch: {
            bookList: '@css:div.result-item',
            name: '@css:h3.title@text',
            author: '@css:span.author@text',
            bookUrl: '@css:h3.title a@href',
        },
    })

    const relativeId = `user:${BASE}`
    const foreignId = `user:${NOTHING_LISTENING}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(relativeId)}`)
    await call('DELETE', `/api/sources?id=${encodeURIComponent(foreignId)}`)

    // --- 正例：基准存在时，相对地址应当能正常工作 ---
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            makeSource('相对地址测试源', BASE, '/fixture/search?q={{key}}&p={{page}}'),
        ]),
    )
    const relativeSearch = await call('POST', '/api/search', {
        keyword: '测试',
        sourceIds: [relativeId],
    })
    const relativeGroup = relativeSearch.json?.sources?.[0]
    check(
        relativeGroup?.ok === true && relativeGroup.count === 2,
        '相对 searchUrl 能按书源地址解析（搜到 2 本）',
        relativeGroup?.error ?? `count=${relativeGroup?.count}`,
    )

    // --- 反例：基准指向别处时，**必须**打到那个别处，而不是打到我们自己 ---
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([makeSource('异地基准测试源', NOTHING_LISTENING, '/search?q={{key}}')]),
    )
    const foreignSearch = await call('POST', '/api/search', {
        keyword: '测试',
        sourceIds: [foreignId],
    })
    const foreignGroup = foreignSearch.json?.sources?.[0]
    check(
        foreignGroup?.ok === false,
        '基准在别处时搜索应当失败（而不是「成功」地返回本站首页里的链接）',
        `ok=${foreignGroup?.ok} count=${foreignGroup?.count}`,
    )
    check(
        String(foreignGroup?.error ?? '').includes('127.0.0.1:59999'),
        '错误信息指向书源地址所在的主机',
        String(foreignGroup?.error ?? '').slice(0, 160),
    )

    await call('DELETE', `/api/sources?id=${encodeURIComponent(relativeId)}`)
    await call('DELETE', `/api/sources?id=${encodeURIComponent(foreignId)}`)
    const left = (await getJson('/api/sources')).json?.sources ?? []
    // 只断言这两条测试源没了 —— 库里可能有使用者自己导入的书源，
    // 断言「一条用户书源都不剩」会误伤他们
    check(
        !left.some((s) => s.id === relativeId || s.id === foreignId),
        '清理干净，两条测试源都已删除',
    )
}

console.log('\n=== 9. 裸 CSS 选择器 ===')
{
    // 真实书源里 `.searchbook`、`h3.title@text`、`div#content@textNodes` 这种
    // 不带 `@css:` 前缀的裸 CSS 写法非常常见。
    // 一旦它们没被认成 CSS 而落到 JSOUP 解析器上，会被**静默**解成别的东西
    // （开头的 `.` 变成「取所有子节点」、`div#content` 变成整页），
    // 表现是「搜索成功但结果是整页导航的拼接」。所以这里从搜到正文整条走一遍。

    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '裸 CSS 规则测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/search?q={{key}}&p={{page}}`,
                // 以下全部是裸 CSS 写法：没有 @css: 前缀，也不是 class./tag. 简写
                ruleSearch: {
                    bookList: '.result-item',
                    name: 'h3.title@text',
                    author: 'span.author@text',
                    bookUrl: 'h3.title a@href',
                },
                ruleBookInfo: {
                    name: 'h1.book-name@text',
                    author: 'span.book-author@text',
                    tocUrl: 'a.toc-link@href',
                },
                ruleToc: {
                    chapterList: 'ul.chapter-list li',
                    chapterName: 'a@text',
                    chapterUrl: 'a@href',
                },
                ruleContent: { content: '#content@textNodes' },
            },
        ]),
    )

    const search = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const group = search.json?.sources?.[0]
    check(
        group?.ok === true && group.count === 2,
        '裸 CSS 列表规则圈定的条目数正确（2 本）',
        group?.error ?? `count=${group?.count}`,
    )

    const book = group?.books?.[0] ?? {}
    check(
        typeof book.bookUrl === 'string' &&
            book.bookUrl.startsWith(BASE) &&
            book.bookUrl.includes('/fixture/book/'),
        '裸 CSS 取到的书籍地址是正常的一条地址（而不是整页链接的拼接）',
        String(book.bookUrl ?? '').slice(0, 100),
    )
    check(book.name === '测试小说·甲', '裸 CSS 取到的书名正确', String(book.name ?? ''))

    if (book.bookUrl) {
        const info = await getJson(
            `/api/book?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(book.bookUrl)}`,
        )
        check(
            Boolean(info.json?.tocUrl),
            '裸 CSS 能拿到目录地址',
            info.json?.error ?? info.json?.tocUrl ?? '',
        )

        if (info.json?.tocUrl) {
            const toc = await getJson(
                `/api/toc?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(info.json.tocUrl)}`,
            )
            const chapters = toc.json?.chapters ?? []
            check(
                chapters.length === 3,
                '裸 CSS 能拿到章节列表（3 章）',
                toc.json?.error ?? `count=${chapters.length}`,
            )

            if (chapters.length > 0) {
                const content = await getJson(
                    `/api/content?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(chapters[0].url)}`,
                )
                const text = String(content.json?.content ?? '')
                check(
                    text.includes('正文第一段'),
                    '裸 CSS 能取到正文',
                    content.json?.error ?? JSON.stringify(text.slice(0, 60)),
                )
            }
        }
    }

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), '裸 CSS 测试源已清理')
}

console.log('\n=== 结果 ===')
if (failures.length === 0) {
    console.log(
        `全部通过：搜索 → 详情 → 目录 → 正文，${succeeded.length} 个书源（CSS / XPath / JS）结果一致，书源管理与书架往返正常`,
    )
} else {
    console.log(`失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
}
