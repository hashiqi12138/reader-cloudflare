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
 * 书架与阅读进度按身份隔离，这几个接口必须带身份头。
 * 冒烟里固定用两个身份，专门用来验「互相看不到」。
 */
const USER_HEADER = 'x-reader-user'
const USER_A = 'smoke-user-a-0123456789'
const USER_B = 'smoke-user-b-0123456789'

async function callAs(user, method, path, body) {
    const response = await fetch(BASE + path, {
        method,
        headers: {
            ...(user === null ? {} : { [USER_HEADER]: user }),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body:
            body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
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
// 必须是六个：对照验证要求 CSS / XPath / JS / JSON / @js:result / 字段模板 六条路径都在场
check(
    list.length >= 6,
    '六个测试书源齐备（CSS / XPath / JS / JSON / @js:result / 字段模板 各一）',
    `count=${list.length}`,
)
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
// 第 3、4 节只跑**文本源**：它们比的是三种规则方言在同一个页面上的提取结果。
// 媒体源（图片/音频/文件）的正文形态本来就不同，混进来会让「逐字一致」这个断言失真 ——
// 比如图片源返回的根本不是文字，比出来必然不等。它们在下面第 13 节单独验证。
const textSources = list.filter((source) => (source.type ?? 0) === 0)
const results = {}
for (const source of textSources) {
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
    // AGPL 第 13 条：网络服务的用户必须能拿到源码。把它变成一条会失败的检查，
    // 而不是只写在 README 里 —— 许可义务靠「记得」是保不住的
    check(
        /https:\/\/github\.com\/[^"']+/.test(pageText) && pageText.includes('源代码'),
        '页面里有指向源码仓库的链接（AGPL 第 13 条）',
        (pageText.match(/https:\/\/github\.com\/[^"']+/) ?? ['(没找到)'])[0],
    )

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

    // 本段所有书架/进度请求都用 USER_A 这个身份（服务端按身份隔离，不带头会被拒）
    const callA = (method, path, body) => callAs(USER_A, method, path, body)
    const shelfOf = async (user = USER_A) =>
        (await callAs(user, 'GET', '/api/shelf')).json?.entries ?? []

    // 清掉上一次可能留下的条目，保证可重复运行
    const existing = (await shelfOf()).find((e) => e.sourceId === sourceId && e.bookUrl === bookUrl)
    if (existing) await callA('DELETE', `/api/shelf?key=${encodeURIComponent(existing.bookKey)}`)

    const baseline = (await shelfOf()).length

    const added = await callA('POST', '/api/shelf', {
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

    const again = await callA('POST', '/api/shelf', {
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

    const saved = await callA('PUT', '/api/progress', {
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

    const readBack = await callAs(
        USER_A,
        'GET',
        `/api/progress?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
    )
    check(
        readBack.json?.progress?.chapterUrl === chapterUrl,
        '按书源 + 书籍地址读回进度',
        JSON.stringify(readBack.json?.progress?.chapterUrl),
    )

    const advanced = await callA('PUT', '/api/progress', {
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

    const removed = await callA(
        'DELETE',
        `/api/shelf?key=${encodeURIComponent(afterRead.bookKey ?? '')}`,
    )
    check(
        removed.status === 200 && removed.json?.name === '测试小说·甲',
        '移出书架',
        JSON.stringify(removed.json),
    )
    check((await shelfOf()).length === baseline, '移出后回到原来的条目数')

    const progressGone = await callAs(
        USER_A,
        'GET',
        `/api/progress?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
    )
    check(
        progressGone.json?.progress === null,
        '移出书架时进度一并清掉（不留孤儿进度）',
        JSON.stringify(progressGone.json?.progress),
    )

    const removeAgain = await callA(
        'DELETE',
        `/api/shelf?key=${encodeURIComponent(afterRead.bookKey ?? '')}`,
    )
    check(
        removeAgain.status === 404 && removeAgain.json?.code === 'shelf_entry_not_found',
        '重复移出报 404 shelf_entry_not_found',
        JSON.stringify(removeAgain.json?.code),
    )

    // ------------------------------------------------------------ 按身份隔离

    // 这一组是这层功能存在的理由本身：**换个身份就看不到别人的书架**。
    // 只测「自己的书架能读写」是测不出漏隔离的 —— 那只要所有查询都不带 owner 也能通过。

    const addForA = await callA('POST', '/api/shelf', {
        sourceId,
        bookUrl,
        name: '甲的书',
        author: '甲',
    })
    check(addForA.status === 201, '身份 A 加一本书', JSON.stringify(addForA.json?.created))

    const shelfA = await shelfOf(USER_A)
    const shelfB = await shelfOf(USER_B)
    check(shelfA.length > 0, '身份 A 能看到自己的书架', `count=${shelfA.length}`)
    check(
        shelfB.length === 0,
        '身份 B 的书架是空的（看不到 A 的）',
        `count=${shelfB.length} ${JSON.stringify(shelfB.map((e) => e.name))}`,
    )

    // 进度也要隔离：A 读了这一章，B 读同一章应当仍没有进度
    await callA('PUT', '/api/progress', {
        sourceId,
        bookUrl,
        chapterUrl,
        chapterName: '第一章 起风了',
        chapterIndex: 0,
    })
    const progressQuery = `/api/progress?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`
    const progressA = await callAs(USER_A, 'GET', progressQuery)
    const progressB = await callAs(USER_B, 'GET', progressQuery)
    check(progressA.json?.progress !== null, '身份 A 有阅读进度')
    check(
        progressB.json?.progress === null,
        '身份 B 没有阅读进度（看不到 A 的）',
        JSON.stringify(progressB.json?.progress),
    )

    // B 删不掉 A 的书架条目：按 owner 过滤之后应当报「找不到」而不是删掉别人的
    const keyOfA = shelfA.find((e) => e.name === '甲的书')?.bookKey ?? ''
    const deleteByB = await callAs(USER_B, 'DELETE', `/api/shelf?key=${encodeURIComponent(keyOfA)}`)
    check(
        deleteByB.status === 404,
        '身份 B 删不掉 A 的书架条目（404 而不是删掉）',
        `status=${deleteByB.status} code=${deleteByB.json?.code}`,
    )
    check(
        (await shelfOf(USER_A)).some((e) => e.bookKey === keyOfA),
        'A 的书架条目仍在',
    )

    // 不带身份必须明确报错，而不是「当作某个默认用户」
    const noHeader = await callAs(null, 'GET', '/api/shelf')
    check(
        noHeader.status === 400 && noHeader.json?.code === 'missing_identity',
        '不带身份头时返回 400 missing_identity（而不是共用一份书架）',
        `status=${noHeader.status} code=${noHeader.json?.code}`,
    )

    // 用 ASCII 的非法值来测：HTTP 头本身就不允许非 ASCII 字符，
    // 拿中文当用例的话请求根本发不出去，测到的是 fetch 的限制而不是服务端校验
    // （非 ASCII 那侧由 test/identity.test.ts 直接覆盖 parseUserToken）
    for (const bad of ['short-token', 'abcdefghijklmnopqrs!']) {
        const badHeader = await callAs(bad, 'GET', '/api/shelf')
        check(
            badHeader.status === 400 && badHeader.json?.code === 'missing_identity',
            `身份「${bad}」被拒（400）`,
            `status=${badHeader.status}`,
        )
    }

    // 收尾：把 A 造的数据清掉，保证可重复运行
    await callA('DELETE', `/api/shelf?key=${encodeURIComponent(keyOfA)}`)
    check((await shelfOf(USER_A)).length === baseline, '身份 A 的数据已清理')
    check((await shelfOf(USER_B)).length === 0, '身份 B 始终没有数据')
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

console.log('\n=== 10. 地址字段只取一个值 ===')
{
    // 真实书源逼出来的问题：搜索条目里往往有多个 <a>（书名一个、最新章节一个），
    // 而地址类字段被写成 `a@href` 会匹配到全部，然后被换行拼成一个字符串。
    // 更隐蔽的是 URL 解析器会把换行当非法字符删掉，于是得到
    // `/77706//77706//77706/65031092.html` 这种「看不出问题、但永远打不开」的地址。
    // 测试站点的条目现在也带两个链接（书名 + 最新章），正好用来钉住这一点。

    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '多链接地址测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/search?q={{key}}&p={{page}}`,
                ruleSearch: {
                    bookList: '.result-item',
                    name: 'h3.title@text',
                    author: 'span.author@text',
                    // 故意用会匹配到「书名链接 + 最新章节链接」的规则
                    bookUrl: 'a@href',
                },
                ruleBookInfo: { tocUrl: 'a@href' },
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
        '多链接条目仍能搜到 2 本',
        group?.error ?? `count=${group?.count}`,
    )

    const books = group?.books ?? []
    const expected = `${BASE}/fixture/book/1`
    check(
        books[0]?.bookUrl === expected,
        '书籍地址取的是第一个链接，且是干净的一条地址',
        `实际=${books[0]?.bookUrl}`,
    )
    check(
        books.every((b) => !/\/fixture\/book\/\d+\/fixture\//.test(String(b.bookUrl ?? ''))),
        '没有出现多个地址首尾相接的情况',
        JSON.stringify(books.map((b) => b.bookUrl)),
    )
    check(
        new Set(books.map((b) => b.bookUrl)).size === books.length,
        '两本书的地址互不相同（没有被拼成同一串）',
    )

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), '多链接测试源已清理')
}

console.log('\n=== 11. 分页目录（nextTocUrl） ===')
{
    // 真实站点的目录常分页：精华书阁一本 2226 章的书每页 20 章，要 112 页。
    // 只取第一页的话，长书只能读到开头几十章 —— 这是「导入了书源却读不下去」的典型形态。
    // 测试站点为此造了一份确定的两页目录：第 1 页 1 章 + 「下一页」，第 2 页 2 章。
    //
    // 顺带覆盖 `text.下一页@href` 这种「按文字找链接」的写法 —— 真实书源就是这么写翻页的。

    // 两种翻页写法都要走通：
    //   - `text.下一页@href`：HTML 里的链接，绝大多数站点这样写
    //   - `@js:` 返回**地址数组**：接口型站点一次给出后面所有页，喜马拉雅就是这样
    //
    // 后者如果被当成「一个地址」处理，几条地址会被 URL 解析器粘成一条
    // （解析器会把换行当非法字符删掉），得到一个必然 404 的怪地址 ——
    // 「只取第一页」于是伪装成「上游报错」，排查方向被带偏。
    const forms = [
        { label: 'HTML 链接', nextTocUrl: 'text.下一页@href', expect: 3 },
        {
            label: 'JS 地址数组',
            nextTocUrl:
                `@js:(function(){var m=String(baseUrl).match(/\\/paged-toc\\/(\\w+)\\/(\\d+)$/);` +
                `if(!m){return []} var n=Number(m[2]); if(n>=2){return []}` +
                `var out=[]; for(var i=2;i<=3;i++){out.push('${BASE}/fixture/paged-toc/'+m[1]+'/'+i)}` +
                `return out})()`,
            expect: 3,
        },
        {
            // 第 1 页拿到 1 章之后，下一页指向一个必然 404 的地址。
            // 正确行为是「保留已拿到的章节 + 给出 warning」，而不是把整份目录丢掉。
            label: '下一页失效',
            nextTocUrl: `@js:['${BASE}/fixture/paged-toc/nope']`,
            expect: 1,
            expectWarning: true,
        },
    ]

    for (const form of forms) {
        const id = `user:${BASE}`
        await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

        await call(
            'POST',
            '/api/sources',
            JSON.stringify([
                {
                    bookSourceName: `分页目录测试源（${form.label}）`,
                    bookSourceUrl: BASE,
                    searchUrl: `${BASE}/fixture/search?q={{key}}&p={{page}}`,
                    ruleSearch: {
                        bookList: '.result-item',
                        name: 'h3.title@text',
                        bookUrl: 'h3.title a@href',
                    },
                    ruleToc: {
                        chapterList: '@css:ul.chapter-list li',
                        chapterName: '@css:a@text',
                        chapterUrl: '@css:a@href',
                        nextTocUrl: form.nextTocUrl,
                    },
                    ruleContent: { content: '@css:div#content@textNodes' },
                },
            ]),
        )

        const toc = await getJson(
            `/api/toc?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(`${BASE}/fixture/paged-toc/1/1`)}`,
        )
        const chapters = toc.json?.chapters ?? []
        check(toc.status === 200, `[${form.label}] 目录接口返回 200`, `status=${toc.status}`)
        check(
            chapters.length === form.expect,
            `[${form.label}] 拿到 ${form.expect} 章`,
            toc.json?.error ?? `count=${chapters.length}`,
        )
        check(
            chapters[0]?.name === '第一章 起风了',
            `[${form.label}] 章节顺序以第一页的为准`,
            JSON.stringify(chapters[0]?.name),
        )
        check(
            new Set(chapters.map((c) => c.url)).size === chapters.length,
            `[${form.label}] 合并后没有重复章节`,
            JSON.stringify(chapters.map((c) => c.name)),
        )
        check(
            form.expectWarning ? Boolean(toc.json?.warning) : !toc.json?.warning,
            `[${form.label}] ${form.expectWarning ? '给出了「目录不完整」说明' : '没有多余的告警'}`,
            String(toc.json?.warning ?? ''),
        )

        await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    }
    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === `user:${BASE}`), '分页目录测试源已清理（两种写法各一轮）')
}

console.log('\n=== 12. 分页正文（nextContentUrl） ===')
{
    // 「章节内容不全」是最难察觉的一类问题：页面看起来完全正常，只是少了一半。
    // 不少站点把一章切成好几页，每页结尾写着「本章未完，请点击下一页继续阅读」。
    // 测试站点为此把一章拆成两页，两页合起来必须与单页正文**逐字相同**。

    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '分页正文测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/search?q={{key}}&p={{page}}`,
                ruleSearch: {
                    bookList: '.result-item',
                    name: 'h3.title@text',
                    bookUrl: 'h3.title a@href',
                },
                ruleToc: {
                    chapterList: '@css:ul.chapter-list li',
                    chapterName: '@css:a@text',
                    chapterUrl: '@css:a@href',
                },
                ruleContent: {
                    content: '@css:div#content@textNodes##本章未完.*',
                    // 按**文字**取，而不是按 id 取。真实站点把「下一章」也写成同一个 id，
                    // 按 id 会把后面几章的内容拼进当前章（测试站点的最后一页特意复现了这个陷阱）
                    nextContentUrl: 'text.下一页@href',
                },
            },
        ]),
    )

    // 单页正文：用内置 CSS 书源取同一章（正常章节页，3 段在一页里）
    const single = await getJson(
        `/api/content?sourceId=${encodeURIComponent('builtin:fixture-css')}&url=${encodeURIComponent(`${BASE}/fixture/chapter/1/1`)}`,
    )
    const singleText = String(single.json?.content ?? '')

    // 分页正文：同一章，但内容被拆成两页
    const paged = await getJson(
        `/api/content?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(`${BASE}/fixture/paged-chapter/1/1/1`)}`,
    )
    const pagedText = String(paged.json?.content ?? '')

    check(singleText.length > 0, '单页正文取到了（作为对照基准）', `len=${singleText.length}`)
    check(
        pagedText.includes('第三段'),
        '分页正文包含最后一页的内容（没有只取第一页）',
        paged.json?.error ?? JSON.stringify(pagedText.slice(-40)),
    )
    check(
        pagedText === singleText,
        '两页拼起来的正文与单页正文逐字一致',
        `分页=${pagedText.length}字 单页=${singleText.length}字`,
    )
    check(
        !pagedText.includes('测试小说·乙'),
        '没有跟着「下一章」跨到别的章节去（末页那个按钮与「下一页」共用 id）',
        JSON.stringify(pagedText.slice(-60)),
    )
    if (pagedText !== singleText) {
        console.log(`    分页：${JSON.stringify(pagedText)}`)
        console.log(`    单页：${JSON.stringify(singleText)}`)
    }

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), '分页正文测试源已清理')
}

console.log('\n=== 13. 图片 / 音频 / 文件源 ===')
{
    /**
     * 这三类源原先一律走文本那条路，表现是「读不出来」：
     *   - 图片源：返回一串 `<img src=...>` 源码，前端当正文渲染成满屏标签
     *   - 音频源：content 为空时报「未配置正文规则」；有 content 的只拿到一条网址文本
     *   - 文件源：content 为空（下载地址在 ruleBookInfo.downloadUrls 里，压根没读）
     *
     * 这里逐类型验证返回形态、媒体代取、Range 透传与签名保护。
     */
    const media = (path) => getJson(path)

    // ---- 图片源 ----
    const imageChapter = `${BASE}/fixture/image-chapter/img1/1/1`
    const imageRes = await media(
        `/api/content?sourceId=${encodeURIComponent('builtin:fixture-image')}&url=${encodeURIComponent(imageChapter)}`,
    )
    const imageList = imageRes.json?.images ?? []
    check(imageRes.json?.kind === 'images', '图片源返回 kind=images', imageRes.json?.error ?? '')
    check(
        imageList.length === 4,
        '翻页把两页的图片都取回来了（第 1 页 2 张 + 第 2 页 2 张，含一个陷阱地址）',
        `count=${imageList.length}`,
    )
    check(
        imageList.every((img) => String(img.url).includes('/fixture/media/')),
        '取到的是真地址而不是占位图',
        JSON.stringify(imageList.map((img) => img.url)),
    )
    check(
        !imageList.some((img) => img.url.includes('placeholder')),
        '占位图（src 上的 1x1 gif）没有被当成图片',
    )
    check(
        imageList.every((img) => String(img.proxyUrl ?? '').startsWith('/api/media/')),
        '图片地址换成了本站的签名代取地址',
    )

    // 代取回来的字节必须与上游**逐字节一致**，否则「能打开」只是假象
    const directPng = await fetch(`${BASE}/fixture/media/page-1.png`)
    const directBytes = new Uint8Array(await directPng.arrayBuffer())
    const proxiedPng = await fetch(`${BASE}${imageList[0]?.proxyUrl ?? ''}`)
    const proxiedBytes = new Uint8Array(await proxiedPng.arrayBuffer())
    check(proxiedPng.status === 200, '图片代取返回 200', `status=${proxiedPng.status}`)
    check(
        proxiedPng.headers.get('content-type')?.startsWith('image/png') === true,
        '图片代取带回了正确的 content-type',
        proxiedPng.headers.get('content-type') ?? '',
    )
    check(
        proxiedBytes.length === directBytes.length &&
            proxiedBytes.every((b, i) => b === directBytes[i]),
        '代取的字节与上游逐字节一致',
        `代理=${proxiedBytes.length} 上游=${directBytes.length}`,
    )

    // 「图片地址」其实指向 HTML 时必须降级：这个接口是**同源**的，
    // 以 text/html 透传等于在我们自己的域上执行别人的脚本，
    // 而 localStorage 里正放着身份令牌。
    const trapLink = imageList.find((img) => String(img.url).includes('not-really.png'))
    check(
        Boolean(trapLink),
        '陷阱地址确实被取回来了（否则下面两条断言测不到东西）',
        JSON.stringify(imageList.map((img) => img.url)),
    )
    const trapResponse = await fetch(`${BASE}${trapLink?.proxyUrl ?? ''}`)
    check(
        trapResponse.headers.get('content-type') === 'application/octet-stream',
        '上游返回 text/html 时代取接口降级成 octet-stream',
        trapResponse.headers.get('content-type') ?? '',
    )
    check(
        String(trapResponse.headers.get('content-disposition') ?? '').startsWith('attachment'),
        '并且加了 Content-Disposition，不会在同源下被执行',
        trapResponse.headers.get('content-disposition') ?? '',
    )

    // ---- 音频源：正文规则取 <audio> 的 src ----
    const audioChapter = `${BASE}/fixture/audio-chapter/aud1/1`
    const audioRes = await media(
        `/api/content?sourceId=${encodeURIComponent('builtin:fixture-audio')}&url=${encodeURIComponent(audioChapter)}`,
    )
    check(audioRes.json?.kind === 'audio', '音频源返回 kind=audio', audioRes.json?.error ?? '')
    check(
        String(audioRes.json?.audio?.url ?? '').endsWith('/fixture/media/tone.mp3'),
        '音频源取到的是音频直链（不是页面地址、也不是一段 HTML）',
        audioRes.json?.audio?.url ?? '',
    )

    const proxiedAudio = await fetch(`${BASE}${audioRes.json?.audio?.proxyUrl ?? ''}`)
    const audioBytes = new Uint8Array(await proxiedAudio.arrayBuffer())
    check(proxiedAudio.status === 200, '音频代取返回 200', `status=${proxiedAudio.status}`)
    check(
        proxiedAudio.headers.get('content-type') === 'audio/mpeg',
        '音频代取带回了 audio/mpeg',
        proxiedAudio.headers.get('content-type') ?? '',
    )
    check(audioBytes.length === 4096, '音频字节完整（4096）', `len=${audioBytes.length}`)
    check(
        proxiedAudio.headers.get('accept-ranges') === 'bytes',
        '音频代取保留了 accept-ranges（否则拖不动进度条）',
        proxiedAudio.headers.get('accept-ranges') ?? '',
    )

    // Range 必须透传：只测 200 的话，「Range 有没有传下去」根本没被验证
    const ranged = await fetch(`${BASE}${audioRes.json?.audio?.proxyUrl ?? ''}`, {
        headers: { Range: 'bytes=10-19' },
    })
    const rangedBytes = new Uint8Array(await ranged.arrayBuffer())
    check(ranged.status === 206, '带 Range 的请求返回 206', `status=${ranged.status}`)
    check(
        ranged.headers.get('content-range') === 'bytes 10-19/4096',
        '206 带回了正确的 content-range',
        ranged.headers.get('content-range') ?? '',
    )
    check(rangedBytes.length === 10, '只返回了请求的那 10 个字节', `len=${rangedBytes.length}`)
    check(
        rangedBytes.every((b, i) => b === audioBytes[10 + i]),
        '切片内容与完整内容对应位置一致',
    )

    // ---- 音频源：不写正文规则，章节地址本身就是直链 ----
    const noRule = await media(
        `/api/content?sourceId=${encodeURIComponent('builtin:fixture-audio-norule')}&url=${encodeURIComponent(`${BASE}/fixture/media/tone.mp3`)}`,
    )
    check(
        noRule.json?.kind === 'audio',
        '无正文规则的音频源返回 kind=audio',
        noRule.json?.error ?? '',
    )
    check(
        String(noRule.json?.audio?.url ?? '').endsWith('/fixture/media/tone.mp3'),
        'content 为空时回落到章节地址（这类源最常见的写法）',
        noRule.json?.audio?.url ?? '',
    )

    // ---- 文件源 ----
    const fileBook = `${BASE}/fixture/book/file1`
    const fileToc = await media(
        `/api/toc?sourceId=${encodeURIComponent('builtin:fixture-file')}&url=${encodeURIComponent(fileBook)}`,
    )
    check(
        fileToc.json?.chapters?.length === 1 && fileToc.json?.synthetic === true,
        '文件源没有目录时给一个合成的下载入口（否则整本书打不开）',
        JSON.stringify(fileToc.json?.chapters ?? fileToc.json?.error ?? ''),
    )

    const fileRes = await media(
        `/api/content?sourceId=${encodeURIComponent('builtin:fixture-file')}&url=${encodeURIComponent(fileBook)}`,
    )
    const downloads = fileRes.json?.downloads ?? []
    check(
        fileRes.json?.kind === 'downloads',
        '文件源返回 kind=downloads',
        fileRes.json?.error ?? '',
    )
    check(
        downloads.length === 1 &&
            String(downloads[0]?.url ?? '').endsWith('/fixture/media/book.txt'),
        '下载地址取自 ruleBookInfo.downloadUrls',
        JSON.stringify(downloads),
    )
    check(downloads[0]?.name === 'book.txt', '下载项带上了文件名', String(downloads[0]?.name))

    const proxiedFile = await fetch(`${BASE}${downloads[0]?.proxyUrl ?? ''}`)
    const fileBody = await proxiedFile.text()
    check(proxiedFile.status === 200, '文件代取返回 200', `status=${proxiedFile.status}`)
    check(
        String(proxiedFile.headers.get('content-disposition') ?? '').startsWith('attachment'),
        '文件代取强制下载（带 Content-Disposition）',
        proxiedFile.headers.get('content-disposition') ?? '',
    )
    check(
        fileBody.includes('这是下载文件的内容'),
        '文件内容取回正确',
        JSON.stringify(fileBody.slice(0, 30)),
    )

    // ---- 签名保护：代取接口不能被当成开放代理 ----
    const validProxy = String(imageList[0]?.proxyUrl ?? '')
    const dot = validProxy.lastIndexOf('.')
    const head = validProxy.slice(0, dot)
    const signature = validProxy.slice(dot + 1)

    // 改签名要改**开头**那一位：base64url 的最后一个字符里有几位是被丢弃的
    // （32 字节的摘要编成 43 个字符，最后一位只有 2 位有效），
    // 改末位有可能解出**完全相同的字节**，那样的断言是碰运气。
    const forged = `${head}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
    const forgedResponse = await fetch(`${BASE}${forged}`)
    check(
        forgedResponse.status === 403,
        '签名被改过的媒体地址返回 403',
        `status=${forgedResponse.status}`,
    )

    const bogus = await fetch(`${BASE}/api/media/not-a-real-token`)
    check(bogus.status === 403, '没签名的媒体地址返回 403', `status=${bogus.status}`)

    // 直接把 URL 塞进代取接口 —— 如果放行，它就是一个对全网开放的代理
    const openProxy = await fetch(
        `${BASE}/api/media/${encodeURIComponent('https://example.com/x.jpg')}`,
    )
    check(
        openProxy.status === 403,
        '把 URL 直接当代取参数会被拒（不是开放代理）',
        `status=${openProxy.status}`,
    )

    check(
        validProxy.startsWith('/api/media/') && !validProxy.includes('://'),
        '代取地址里不含上游地址明文（凭证拼不出来）',
        validProxy,
    )
}

console.log('\n=== 14. 字段规则里的 {{}} 模板 ===')
{
    /**
     * 线上 816 条书源里有 939 处字段模板，是最容易「静默取空」的一类写法：
     * 展开之后如果还当选择器去筛，只会得到空串，症状就是「这个字段读不出来」。
     *
     * 这里把几种真实形态各验一遍。asmr 那条源卡住的就是第一种：
     * `bookUrl: "/api/tracks/{{$.id}}"` 一直取到空串。
     */
    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '模板形态测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/api/search?q={{key}}&p={{page}}`,
                ruleSearch: {
                    bookList: '$.data.list',
                    // 字面文本 + 模板
                    name: '《{{$.name}}》',
                    author: '{{$.author}}',
                    // 模板 + 正则链：展开成字面值之后再套 `##`
                    kind: '{{$.kind}}##玄幻##类型：玄幻',
                    // 裸标识符 → 走沙箱取全局（书源里 `{{key}}`、`{{baseUrl}}` 就是这么用的）
                    lastChapter: '关键词：{{key}}',
                    intro: '{{$.intro}}',
                    // 这一条就是 asmr 的形状：模板 + 相对路径
                    bookUrl: `/fixture/book/{{$.id}}`,
                },
                ruleBookInfo: {
                    name: '@css:h1.book-name@text',
                    // 冗余 `@` 标记 + 规则（真实书源里有 214 处这么写）
                    intro: '{{@@h1.book-name@text}}',
                    // 纯模板当字面值，再套 `##` 正则链
                    tocUrl: '{{baseUrl}}##/book/##/toc/',
                },
                ruleToc: {
                    chapterList: '@css:ul.chapter-list li',
                    chapterName: '@css:a@text',
                    chapterUrl: '@css:a@href',
                },
                ruleContent: {
                    // 模板出现在 `##` 的查找串里：把章节标题从正文中删掉
                    content: '@css:div#content@textNodes##{{@css:h1.chapter-title@text}}',
                },
            },
        ]),
    )

    const searchRes = await call('POST', '/api/search', {
        keyword: '测试',
        sourceIds: [id],
    })
    const per = searchRes.json?.sources?.[0]
    const books = per?.books ?? []
    check(books.length === 2, '模板源搜到 2 本书', per?.error ?? `count=${books.length}`)

    if (books.length > 0) {
        const book = books[0]
        check(book.name === '《测试小说·甲》', '字面 + 模板：书名带上了书名号', book.name)
        check(book.author === '作者甲', '纯模板：作者取到了', book.author)
        check(book.kind === '类型：玄幻', '模板 + 正则链：`##` 作用在展开后的字面值上', book.kind)
        check(
            book.lastChapter === '关键词：测试',
            '裸标识符走沙箱：取到了 key 全局',
            book.lastChapter,
        )
        check(
            book.bookUrl === `${BASE}/fixture/book/1`,
            '模板 + 相对路径：地址拼对了（asmr 卡住的就是这一条）',
            book.bookUrl,
        )

        const info = await getJson(
            `/api/book?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(book.bookUrl)}`,
        )
        check(
            info.json?.intro === '测试小说·甲',
            '冗余 `@` 标记：规则照常生效',
            info.json?.intro ?? '',
        )
        check(
            info.json?.tocUrl === `${BASE}/fixture/toc/1`,
            '纯模板当字面值 + `##` 正则链：目录地址替换正确',
            info.json?.tocUrl ?? '',
        )

        const toc = await getJson(
            `/api/toc?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(info.json?.tocUrl ?? '')}`,
        )
        const chapters = toc.json?.chapters ?? []
        check(
            chapters.length === 3,
            '目录能正常打开',
            toc.json?.error ?? `count=${chapters.length}`,
        )

        if (chapters.length > 0) {
            const content = await getJson(
                `/api/content?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(chapters[0].url)}`,
            )
            const text = String(content.json?.content ?? '')
            check(
                text.includes('正文第一段'),
                '正文取到了',
                content.json?.error ?? JSON.stringify(text.slice(0, 40)),
            )
            check(
                !text.includes('第一章 起风了'),
                '模板进 `##` 查找串：章节标题被从正文里删掉了',
                JSON.stringify(text.slice(0, 60)),
            )
        }
    }

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // ---- 不支持的复合过滤器必须报错，而不是「没搜到」 ----
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '复合过滤器测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/api/search?q={{key}}&p={{page}}`,
                ruleSearch: {
                    bookList: '$.data.list[?(@.name&&@.author)]',
                    name: '{{$.name}}',
                    bookUrl: '/fixture/book/{{$.id}}',
                },
                ruleToc: {},
                ruleContent: {},
            },
        ]),
    )
    const badFilter = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const badPer = badFilter.json?.sources?.[0]
    check(
        badPer?.ok === false && String(badPer?.error ?? '').includes('复合过滤器'),
        '不支持的过滤器明确报错，而不是静默返回 0 条',
        JSON.stringify(badPer?.error ?? badPer?.books),
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), '模板测试源已清理')
}

console.log('\n=== 15. 沙箱助手（java.getString / timeFormat / md5 / hex / UI no-op） ===')
{
    /**
     * `java.getString(规则)` 让沙箱里的脚本回过头去跑一条引擎规则 —— 真实书源里
     * `{{java.getString('$.freeStack')=='1'?'':'💲VIP'}}` 这种写法很多。
     *
     * 它必须由规则求值层注入（「当前节点」只有那一层知道），而且要挡住「规则里再套 JS」：
     * asyncify 不支持嵌套挂起。
     *
     * `java.timeFormat` 是纯计算，实现放在宿主侧，格式串的替换规则在单测里逐条钉过；
     * 这里验的是它确实从沙箱里接上了。
     */
    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // 固定时间戳，便于断言（同一数值同时写进规则与期望值）
    const fixedMs = Date.parse('2026-07-19T20:04:05Z')

    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '沙箱助手测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/api/search?q={{key}}&p={{page}}`,
                ruleSearch: {
                    bookList: '$.data.list',
                    name: '{{$.name}}',
                    author: '{{$.author}}',
                    bookUrl: '/fixture/book/{{$.id}}',
                    // 模板里的 JS 表达式回头跑一条规则
                    kind: "{{java.getString('$.kind')}}",
                    // 时间格式化：默认 +8
                    lastChapter: `@js:java.timeFormat(${fixedMs}, 'yyyy-MM-dd HH:mm')`,
                    // 显式时区：UTC
                    wordCount: `@js:java.timeFormatUTC(${fixedMs}, 'yyyy-MM-dd HH:mm', 0)`,
                    // 第二个参数：在给定内容上求值，而不是当前节点
                    intro: `@js:java.getString('$.name', '{"name":"另一段内容"}')`,
                    /**
                     * 摘要与十六进制助手，以及**纯 UI 动作**。
                     * toast / refreshExplore 在服务端没有界面可弹，但书源里它们常和取数据
                     * 写在同一个 try 里，缺一个就是「not a function」把整条规则带走 ——
                     * 所以必须有，且必须是 no-op 而不是抛错。
                     */
                    author: `@js:java.md5Encode('abc') + '|' + java.hexEncodeToString('中') + '|' + java.hexDecodeToString('e4b8ad') + '|' + (java.toast('调试') === undefined ? 'toast-ok' : 'toast-bad') + '|' + (java.refreshExplore() === undefined ? 'refresh-ok' : 'refresh-bad') + '|' + (java.getWebViewUA().indexOf('Chrome/') > 0 ? 'ua-ok' : 'ua-bad')`,
                },
                ruleBookInfo: { name: '@css:h1.book-name@text', tocUrl: '@css:a.toc-link@href' },
                ruleToc: {
                    chapterList: '@css:ul.chapter-list li',
                    chapterName: '@css:a@text',
                    chapterUrl: '@css:a@href',
                },
                ruleContent: { content: '@css:div#content@textNodes' },
            },
        ]),
    )

    const searchRes = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const per = searchRes.json?.sources?.[0]
    const books = per?.books ?? []
    check(books.length === 2, '沙箱助手源搜到 2 本书', per?.error ?? `count=${books.length}`)

    if (books.length > 0) {
        const book = books[0]
        check(book.kind === '玄幻', 'java.getString 在模板里跑通了 JSONPath', String(book.kind))
        check(
            book.lastChapter === '2026-07-20 04:04',
            'java.timeFormat 默认按 +8 渲染（UTC 下会是前一天）',
            String(book.lastChapter),
        )
        check(
            book.wordCount === '2026-07-19 20:04',
            'java.timeFormatUTC 按显式偏移渲染',
            String(book.wordCount),
        )
        check(
            book.intro === '另一段内容',
            'java.getString 的第二个参数：在给定内容上求值',
            String(book.intro),
        )
        check(
            book.author === '900150983cd24fb0d6963f7d28e17f72|e4b8ad|中|toast-ok|refresh-ok|ua-ok',
            'md5 / hex 互转正确，且 toast、refreshExplore、getWebViewUA 不打断规则',
            String(book.author),
        )
    }

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // ---- 规则里再套 JS 必须明确报错（asyncify 不支持嵌套挂起） ----
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '嵌套 JS 测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/api/search?q={{key}}&p={{page}}`,
                ruleSearch: {
                    bookList: '$.data.list',
                    name: '{{$.name}}',
                    bookUrl: '/fixture/book/{{$.id}}',
                    wordCount: "@js:java.getString('@js:1')",
                },
                ruleToc: {},
                ruleContent: {},
            },
        ]),
    )
    const nested = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const nestedPer = nested.json?.sources?.[0]
    check(
        nestedPer?.ok === false && String(nestedPer?.error ?? '').includes('嵌套挂起'),
        'java.getString 里再套 JS 会明确报错，而不是悄悄挂起',
        JSON.stringify(nestedPer?.error ?? nestedPer?.books?.[0]?.wordCount),
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), '沙箱助手测试源已清理')
}

console.log('\n=== 16. JS 里的连接符不能被切碎 ===')
{
    /**
     * `&&` / `||` / `%%` 是规则的同级连接符，但 JS 代码里的它们是运算符。
     * 线上 816 条书源里有 303 处规则同时含 JS 与连接符，三种形态都会被切碎：
     *   - 整条是 `@js:`（禁漫天堂API、七猫、听小说APP）
     *   - 连接符在 `<js>` 块内（书旗小说、微信读书、晋江文学）
     *   - `选择器@js:代码`（鸟鸟韩漫、存书啦、塔读文学）
     *
     * 被切开的后果不是报「规则不支持」，而是一句莫名其妙的 JS 语法错误
     * （实测听小说APP 报的是 `expecting ','`），排查方向被带偏。
     */
    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: 'JS 连接符测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/api/search?q={{key}}&p={{page}}`,
                ruleSearch: {
                    bookList: '$.data.list',
                    name: '{{$.name}}',
                    bookUrl: '/fixture/book/{{$.id}}',
                    // 整条是 @js:，代码里有 ||（用表达式形式，沙箱不把脚本包进函数）。
                    // 特意把 `||` 用在括号里：被切碎的话括号不配平 → JS 报错，
                    // 而不会「碰巧取到前半段仍是非空值」把断言蒙过去
                    author: "@js:(java.getString('$.author') || '（无作者）') + '·已读'",
                    // <js> 块里有 &&
                    kind: "<js>if (1 === 1 && 2 === 2) { result = '一致性通过' } else { result = '不该走到这里' }</js>",
                },
                ruleBookInfo: {
                    name: '@css:h1.book-name@text',
                    tocUrl: '@css:a.toc-link@href',
                    // 选择器 + @js:（代码里有 ||）+ 净化链：三段都要完好
                    intro: '@css:div.book-intro@text@js:String(result || "") + "（已处理）"##已处理##OK',
                },
                ruleToc: {
                    chapterList: '@css:ul.chapter-list li',
                    chapterName: '@css:a@text',
                    chapterUrl: '@css:a@href',
                },
                ruleContent: { content: '@css:div#content@textNodes' },
            },
        ]),
    )

    const searchRes = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const per = searchRes.json?.sources?.[0]
    const books = per?.books ?? []
    check(books.length === 2, '含 JS 连接符的源能搜到书', per?.error ?? `count=${books.length}`)

    if (books.length > 0) {
        check(
            books[0].author === '作者甲·已读',
            '整条 @js: 里的 || 没被切碎（切碎会变成 JS 语法错误或取到半截值）',
            String(books[0].author),
        )
        check(books[0].kind === '一致性通过', '<js> 块里的 && 没被切碎', String(books[0].kind))

        const info = await getJson(
            `/api/book?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(books[0].bookUrl)}`,
        )
        check(
            info.json?.intro === '这是一本用于验证链路的小说。（OK）',
            '选择器 + @js:（代码里有 ||）+ 净化链：三段都完好',
            JSON.stringify(info.json?.intro ?? info.json?.error),
        )
        check(
            String(info.json?.tocUrl ?? '').endsWith('/fixture/toc/1'),
            '同一份规则里的普通字段不受影响',
            String(info.json?.tocUrl),
        )
    }

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), 'JS 连接符测试源已清理')
}

console.log('\n=== 17. @js: 列表规则（接口型书源的关键路径） ===')
{
    /**
     * 接口型书源（音频、漫画）的 `bookList` 大量写成整条 `@js:`，脚本返回一个数组。
     * 这里有三处必须同时成立，缺一处就是**一条都搜不到、而且不报错**：
     *
     *   1. `@js:` 规则不能被 `detectKind` 归进 JSOUP 简写 —— 那样会解析出空步骤，
     *      于是「整页变成一个条目」，后续字段规则在整页上当然取不到 `$.name`。
     *   2. 数组结果必须**逐个**返回，不能被换行 join 成一条（N 个条目只剩 1 个）。
     *   3. 条目的 `source` 必须是**条目自己的文本**，`$.name` 与 `result` 都在这份文本上求值。
     *
     * 三条都是静默失败，所以这里断言的是「条目数」和「字段值」，而不是「接口没报错」。
     */
    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: 'JS 列表规则测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/api/search?q={{key}}&p={{page}}`,
                ruleSearch: {
                    // 返回 3 条 JSON 字符串（真实书源最常见的形态）
                    bookList: `@js:(function(){ var o = []; for (var i = 1; i <= 3; i++) { o.push(JSON.stringify({ name: '第' + i + '本', author: '作者' + i, url: '/fixture/book/' + i })); } return o; })()`,
                    name: '$.name',
                    author: '$.author',
                    bookUrl: '$.url',
                    // 同一批条目上，`result` 必须是条目自己（而不是整页响应）
                    kind: '@js:JSON.parse(result).author + "·条目内"',
                },
                ruleToc: {},
                ruleContent: {},
            },
        ]),
    )

    const listRes = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const listPer = listRes.json?.sources?.[0]
    const listBooks = listPer?.books ?? []
    check(
        listBooks.length === 3,
        '@js: 列表规则返回 3 条就是 3 个条目（不会被拍平成 1 条）',
        listPer?.error ?? `count=${listBooks.length}`,
    )
    check(
        listBooks[0]?.name === '第1本' && listBooks[2]?.name === '第3本',
        '每个条目的 $.字段 取自条目自己的 JSON，而不是整页',
        JSON.stringify(listBooks.map((b) => b.name)),
    )
    check(
        listBooks[0]?.kind === '作者1·条目内',
        '条目内的 result 绑定的是条目文本',
        String(listBooks[0]?.kind),
    )
    check(
        String(listBooks[1]?.bookUrl ?? '') === `${BASE}/fixture/book/2`,
        '条目里的相对地址按书源地址补全',
        String(listBooks[1]?.bookUrl),
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // ---- `@js:` 返回对象数组（不是字符串）也不能退化成 [object Object] ----
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: 'JS 对象数组测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/api/search?q={{key}}&p={{page}}`,
                ruleSearch: {
                    bookList: `@js:[{ name: '甲', author: '乙', url: '/fixture/book/1' }, { name: '丙', author: '丁', url: '/fixture/book/2' }]`,
                    name: '$.name',
                    author: '$.author',
                    bookUrl: '$.url',
                },
                ruleToc: {},
                ruleContent: {},
            },
        ]),
    )
    const objRes = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const objBooks = objRes.json?.sources?.[0]?.books ?? []
    check(
        objBooks.length === 2 && objBooks[0]?.name === '甲' && objBooks[1]?.author === '丁',
        '@js: 返回对象数组时逐条 JSON 化（不是 [object Object]）',
        JSON.stringify(objBooks.map((b) => `${b.name}/${b.author}`)),
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // ---- 返回 HTML 片段数组时，条目要按 HTML 解析，后续 CSS 规则照常可用 ----
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: 'JS HTML 条目测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/api/search?q={{key}}&p={{page}}`,
                ruleSearch: {
                    bookList: `@js:(function(){ return ['<li><h3>庚书</h3><a href="/fixture/book/1">详情</a></li>', '<li><h3>辛书</h3><a href="/fixture/book/2">详情</a></li>']; })()`,
                    name: 'h3@text',
                    author: 'h3@text',
                    bookUrl: 'a@href',
                },
                ruleToc: {},
                ruleContent: {},
            },
        ]),
    )
    const htmlRes = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const htmlBooks = htmlRes.json?.sources?.[0]?.books ?? []
    check(
        htmlBooks.length === 2 && htmlBooks[0]?.name === '庚书' && htmlBooks[1]?.name === '辛书',
        '@js: 返回 HTML 片段数组时，条目按 HTML 解析、CSS 字段规则可用',
        JSON.stringify(htmlBooks.map((b) => b.name)),
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), 'JS 列表规则测试源已清理')
}

console.log('\n=== 结果 ===')
if (failures.length === 0) {
    console.log(
        `全部通过：搜索 → 详情 → 目录 → 正文，${succeeded.length} 个书源（CSS / XPath / JS / JSON / @js:result / 字段模板）结果一致，` +
            '图片/音频/文件源各自取回对应形态，媒体代取与签名保护正常',
    )
} else {
    console.log(`失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
}
