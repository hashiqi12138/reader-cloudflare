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

    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '分页目录测试源',
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
                    // 按文字找「下一页」链接，与真实书源的写法一致
                    nextTocUrl: 'text.下一页@href',
                },
                ruleContent: { content: '@css:div#content@textNodes' },
            },
        ]),
    )

    const toc = await getJson(
        `/api/toc?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(`${BASE}/fixture/paged-toc/1/1`)}`,
    )
    const chapters = toc.json?.chapters ?? []
    check(toc.status === 200, '目录接口返回 200', `status=${toc.status}`)
    check(
        chapters.length === 3,
        '两页目录被合并成 3 章（不是只取第一页的 1 章）',
        toc.json?.error ?? `count=${chapters.length}`,
    )
    check(
        chapters[0]?.name === '第一章 起风了',
        '章节顺序以第一页的为准',
        JSON.stringify(chapters[0]?.name),
    )
    check(
        new Set(chapters.map((c) => c.url)).size === chapters.length,
        '合并后没有重复章节',
        JSON.stringify(chapters.map((c) => c.name)),
    )

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), '分页目录测试源已清理')
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

console.log('\n=== 结果 ===')
if (failures.length === 0) {
    console.log(
        `全部通过：搜索 → 详情 → 目录 → 正文，${succeeded.length} 个书源（CSS / XPath / JS）结果一致，书源管理与书架往返正常`,
    )
} else {
    console.log(`失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
}
