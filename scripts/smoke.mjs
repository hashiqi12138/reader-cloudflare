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
 * 注册一个临时账号，返回「带着它会话 cookie」的调用器
 *
 * 书架与阅读进度现在挂在**账号**上，会话是 HttpOnly cookie，所以这一段
 * 不再用自定义头，而是真的走一遍注册把 cookie 拿到手。
 * 用户名每次都带时间戳与随机数，免得与上一次运行的残留撞车（唯一约束会直接 409）。
 */
async function sessionUser(prefix) {
    const username = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
    const response = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'smoke-password-1' }),
    })
    let cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]

    return {
        username,
        get cookie() {
            return cookie
        },
        status: response.status,
        async call(method, path, body) {
            const res = await fetch(BASE + path, {
                method,
                headers: {
                    ...(cookie ? { cookie } : {}),
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                body:
                    body === undefined
                        ? undefined
                        : typeof body === 'string'
                          ? body
                          : JSON.stringify(body),
            })
            // 登录/登出会重新下发或清掉 cookie，跟着更新 ——
            // 不然「登出再登录」这一段的第二次请求还带着已经失效的那个会话
            const setCookie = res.headers.get('set-cookie')
            if (setCookie) cookie = setCookie.split(';')[0]
            const text = await res.text()
            return { status: res.status, json: parseMaybeJson(text), text }
        },
    }
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
// 必须是七个：对照验证要求 CSS / XPath / JS / JSON / @js:result / 字段模板 / 选择器@js: 七条路径都在场
check(
    list.length >= 7,
    '七个测试书源齐备（CSS / XPath / JS / JSON / @js:result / 字段模板 / 选择器@js: 各一）',
    `count=${list.length}`,
)
if (list.length === 0) {
    console.error('\n没有可用书源。是否忘记在 .dev.vars 里设置 ENABLE_FIXTURE=true？')
    process.exit(1)
}

/**
 * POST 表单搜索：守住「带请求体必须声明 Content-Type」
 *
 * 测试站点这个端点照 PHP 的样子写 —— 不是 `application/x-www-form-urlencoded` 就
 * 当作没收到参数、直接返回空结果页。所以这一条一旦红了，说明引擎发 POST 时又没带上
 * 那个头：线上 320 个源（39%）是 POST 搜索，全都会变成「跑通但 0 条」且不报错。
 */
const formSearchSource = list.find((s) => s.id === 'builtin:fixture-post-form')
check(Boolean(formSearchSource), '内置 POST 表单搜索源已注册', formSearchSource?.name ?? '未找到')
if (formSearchSource) {
    const formSearch = await call('POST', '/api/search', {
        keyword: '测试',
        sourceIds: [formSearchSource.id],
    })
    const per = formSearch.json?.sources?.[0]
    check(
        per?.ok === true && (per?.count ?? 0) > 0,
        'POST 表单搜索能搜到书（请求体带上了表单 Content-Type）',
        `ok=${per?.ok} count=${per?.count} ${per?.error ?? ''}`,
    )
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
console.log('\n=== 搜索分页（免费计划的 10 ms CPU 上限逼出来的形态）===')
{
    // 不带 sourceIds：服务端按「健康度」分页，一次只搜一页
    const page1 = await call('POST', '/api/search', { keyword: '测试', limit: 3 })
    check(page1.status === 200, '[分页] 一页搜索返回 200', `status=${page1.status}`)
    const ids1 = (page1.json?.sources ?? []).map((s) => s.sourceId)
    check(ids1.length <= 3, '[分页] 一页不超过 limit 个源', `searched=${ids1.length}`)
    check(
        typeof page1.json?.totalSources === 'number' && page1.json.totalSources > 0,
        '[分页] 返回启用书源总数（界面靠它算「还有多少个没搜」）',
        `totalSources=${page1.json?.totalSources}`,
    )
    check(page1.json?.offset === 0, '[分页] 首页 offset 是 0', `offset=${page1.json?.offset}`)

    const page2 = await call('POST', '/api/search', { keyword: '测试', limit: 3, offset: 3 })
    const ids2 = (page2.json?.sources ?? []).map((s) => s.sourceId)
    check(
        ids2.length > 0 && ids2.every((id) => !ids1.includes(id)),
        '[分页] 第二页换了一批源（offset 真的生效）',
        `p1=${ids1.join(',')} / p2=${ids2.join(',')}`,
    )

    // 不传 limit 时的默认值：界面默认一页几个源，服务端兜底就得是几个，
    // 两边不是同一个数的话，「继续加载」的步长会和用户预期对不上
    const defaulted = await call('POST', '/api/search', { keyword: '测试' })
    const idsDefault = (defaulted.json?.sources ?? []).map((s) => s.sourceId)
    check(
        idsDefault.length > 0 && idsDefault.length <= 3,
        '[分页] 不传 limit 时默认一页不超过 3 个源',
        `searched=${idsDefault.length}`,
    )
}
// limit 的上限兜底（500 → 50）没写成断言：那会真的去搜 50 个源、每源一次外网请求，
// 本地跑一轮要等很久 —— 不值这个价。上限逻辑在 index.ts 的 clampPage 里，改动时看一眼即可。

/**
 * 链路测试只跑**内置**测试源
 *
 * 用户导入的真实源指向外部站点，国内很多连不上（规则也会随时失效），
 * 拿它们当断言对象只会让冒烟常年飘红 —— 冒烟要验的是引擎，不是外网站点。
 * 真实源能不能用，由搜索页的「健康度」记录，见 README「第二十七轮」。
 */
const textSources = list.filter((source) => source.builtin && (source.type ?? 0) === 0)
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

    /**
     * 把 `选择器@js:` 那条单独点出来
     *
     * 它的正文规则是 `div#content p@text##第一段。##第1段。##@js:result.replace(…)`，
     * 三段语义全在一个规则里：选择器**命中 3 个段落**、`result` 按**字符串**绑、
     * 净化链在 `@js:` **之前**、脚本再把 `第1段。` 换回 `第一段。`。
     * 上面「逐字一致」那条断言已经覆盖了它，这里再单独断言一次，是为了让
     * **失败信息直接点出是哪一段语义坏了**，而不是淹没在七条方言的比对里。
     */
    const selectorJs = results['builtin:fixture-selector-js']
    check(
        Boolean(selectorJs) && selectorJs.content.split('\n').length >= 3,
        '选择器@js: 的链在脚本之前跑，正文段落一条不少',
        selectorJs ? JSON.stringify(selectorJs.content.slice(0, 70)) : '这条源没跑通',
    )
}

console.log('\n=== 4b. 空选择器 + 取值链（`##正则##$1###`）===')
{
    /**
     * CSS 方言的 `ruleBookInfo.intro` 写成了 `##class="book-intro">([^<]+)<##$1###` ——
     * 前面**没有选择器**，直接以净化链开头。线上 55 处这么写
     * （⚡📂未来天王 六个字段、🔞PO18文学 的 wordCount、📂被电子书 …）。
     *
     * 一条规则同时钉住两件事：空选择器的输入是**整页原文**；`###` 是「取第一个匹配」
     * （结果是匹配到的那一段），不是「整段里替换第一处」—— 后者会让 intro 等于**整页**。
     * 拿 XPath 方言的 `//div[@class="book-intro"]/text()` 当参照：两条路必须给出同一段简介。
     */
    const bookOf = (id) =>
        getJson(
            `/api/book?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(`${BASE}/fixture/book/1`)}`,
        )
    const fromCss = await bookOf('builtin:fixture-css')
    const fromXPath = await bookOf('builtin:fixture-xpath')
    const intro = String(fromCss.json?.intro ?? '')
    const viaXPath = String(fromXPath.json?.intro ?? '')
    check(
        intro.length > 0 && intro === viaXPath,
        '空选择器 + `###` 从整页里抠出了简介（不是整页、也不是空）',
        `css=${JSON.stringify(intro.slice(0, 50))} xpath=${JSON.stringify(viaXPath.slice(0, 50))}`,
    )
}

console.log('\n=== 4c. 列表规则开头的 `+` 与**顶格** `<js>` ===')
{
    /**
     * 两件事出自同一类症状：**规则跑起来了，但看到的不是它要的那份内容**。
     *
     *   1. 开头的 `+`（线上 8 处：6 处 chapterList + 2 处 bookList）早先是一条明确报错
     *      「列表规则 AllInOne(js) 暂未实现：以 + 开头的规则」，于是 `+@css:.bookbox`
     *      这种**纯 CSS** 列表规则整条目录/搜索直接变成报错。语料否掉了「`+` = AllInOne」
     *      那个读法（AllInOne 必须以 `:` 开头），剥掉按后面的规则求值即可。
     *   2. **顶格** `<js>` 块里的 `result` 之前是**空串**（它从 `values = []` 起步）。
     *      顶格 `<js>` 与顶格 `@js:` 是同一件事：`result` 该是**页面原文**。
     *      `⚡📂全本小说网`/`📂基友书屋`/`📂趣书小说`/`🔞po18城` 的目录规则都靠这条。
     *
     * 三种 `+` 形态各来一条（`@js:` / `<js>` / `@css:`），断言的是**条目数与章节名**，
     * 因为这条路上的失败大多是静默的：剥不掉就整条报错，剥掉了但 `result` 是空串就是 0 条。
     */
    const id = `user:${BASE}`
    const tocUrl = `${BASE}/fixture/toc/1`
    const expected = ['第一章 起风了', '第二章 雨落下来', '第三章 天晴了']
    // 在**整页原文**上扫 `<li><a href="…">…</a></li>`：只有拿到页面原文才扫得出 3 条
    const SCAN = `var h = String(result);var re = /<li><a href="([^"]+)">([^<]+)<\\/a><\\/li>/g;var m;var out = [];while ((m = re.exec(h))) { out.push(JSON.stringify({ name: m[2], url: m[1] })) }return out`

    // 字段规则的默认写法配的是「条目是一段 JSON」的形态；节点型条目要用选择器，
    // 所以 CSS 那一条单独覆盖（否则 `JSON.parse(<li>…)` 会抛错、条目全被丢掉，
    // 看起来像 `+@css:` 没生效 —— 其实是测试自己的字段规则配错了）
    const importWith = (name, chapterList, extra = {}) =>
        call(
            'POST',
            '/api/sources',
            JSON.stringify([
                {
                    bookSourceName: name,
                    bookSourceUrl: BASE,
                    ruleToc: {
                        chapterList,
                        chapterName: '@js:JSON.parse(result).name',
                        chapterUrl: '@js:JSON.parse(result).url',
                        ...extra,
                    },
                },
            ]),
        )

    const tocOf = async () => {
        const res = await getJson(
            `/api/toc?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(tocUrl)}`,
        )
        return res.json?.chapters ?? []
    }

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // ---- 形态 1：`+@js:`（剥完是顶格 `@js:`，`result` = 页面原文） ----
    await importWith('列表标记测试源（+@js:）', `+@js:(function(){${SCAN}})()`)
    let chapters = await tocOf()
    check(
        chapters.length === 3 &&
            chapters[0]?.name === expected[0] &&
            chapters[2]?.name === expected[2],
        '`+@js:` 剥掉之后脚本拿到页面原文，目录 3 条',
        `count=${chapters.length} names=${JSON.stringify(chapters.map((c) => c.name))}`,
    )
    check(
        String(chapters[0]?.url ?? '') === `${BASE}/fixture/chapter/1/1`,
        '`+@js:` 里的相对地址照常按书源地址补全',
        String(chapters[0]?.url),
    )

    // ---- 形态 2：`+<js>`（剥完是顶格 `<js>`，同样要页面原文） ----
    await importWith('列表标记测试源（+<js>）', `+<js>\n(function(){${SCAN}})()\n</js>`)
    chapters = await tocOf()
    check(
        chapters.length === 3 &&
            chapters[0]?.name === expected[0] &&
            chapters[1]?.name === expected[1],
        '`+<js>` 剥掉之后 `result` 是页面原文（不是空串），目录 3 条',
        `count=${chapters.length} names=${JSON.stringify(chapters.map((c) => c.name))}`,
    )

    // ---- 形态 3：`+@css:`（剥掉就是普通 CSS 列表规则） ----
    await importWith('列表标记测试源（+@css:）', '+@css:ul.chapter-list li', {
        chapterName: '@css:a@text',
        chapterUrl: '@css:a@href',
    })
    chapters = await tocOf()
    check(
        chapters.length === 3 && chapters[2]?.name === expected[2],
        '`+@css:` 剥掉之后就是普通 CSS 列表规则，同样 3 条',
        `count=${chapters.length} names=${JSON.stringify(chapters.map((c) => c.name))}`,
    )

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
}

console.log('\n=== 4d. `选择器@js:` 里 `result` 绑成节点（Elements）===')
{
    /**
     * Legado 里 `result` 是 jsoup 的 `Elements`（节点集合、一个 List），
     * 于是脚本会写 `result.size()`、`result.forEach(e => e.attr('href'))`、
     * `result.select('a')` 之后再 `links[i]`。线上三处这么写
     * （⚡📂八一中文网、🔞西瓜书屋、🔞紫云宫），而它们原来都跑不起来 ——
     * 多命中时 `result` 是**字符串数组**，`result.size is not a function`。
     *
     * 还有一层更隐蔽的：`result` 里装的是**按取值方式抠出来的字符串**，
     * 而裸 CSS / JSOUP 简写的默认取值一个是「名为空串的属性」（恒空）、一个是 `text`，
     * 拿它当 HTML 解析自然什么都选不出来。所以这一节用**默认取值**的选择器开头，
     * 断言的是**章节名与地址**（静默失败看不出来），并且两条路各来一遍：
     *
     *   - 多命中 → 数组形态的 Elements（`size()` / `forEach`）
     *   - 单命中 → 一份 HTML 字符串，`select()` 的返回值也必须是能下标的（`links[i]`）
     */
    const id = `user:${BASE}`
    const tocUrl = `${BASE}/fixture/toc/1`
    const expected = ['第一章 起风了', '第二章 雨落下来', '第三章 天晴了']
    // 节点的 `text()` 与 `attr('href')` 都只有「元素」才给得出来：给纯文本的话 attr 恒为空
    const ITEM = `o.push(JSON.stringify({ n: String(e.text()), u: String(e.attr('href')) }))`

    const importWith = (name, chapterList) =>
        call(
            'POST',
            '/api/sources',
            JSON.stringify([
                {
                    bookSourceName: name,
                    bookSourceUrl: BASE,
                    ruleToc: {
                        chapterList,
                        chapterName: '@js:JSON.parse(result).n',
                        chapterUrl: '@js:JSON.parse(result).u',
                    },
                },
            ]),
        )

    const tocOf = async () => {
        const res = await getJson(
            `/api/toc?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(tocUrl)}`,
        )
        return res.json?.chapters ?? []
    }

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    /**
     * 选择器取到的必须是**带 href 的元素**（`li a`），不能是 `li` ——
     * `li` 上本来就没有 href，`e.attr('href')` 当然是空串，条目会被当成「没有地址」丢掉。
     * 这一条第一版就踩了：断言红了半天，以为是引擎的问题，其实是测试自己的选择器取错了元素。
     */
    const SEL = '@css:ul.chapter-list li a'

    // ---- 集合级：`result.size()` + 逐个元素 ----
    await importWith(
        '节点绑定测试源（集合级）',
        `${SEL}@js:(function(){var o=[];var s=result.size();for(var i=0;i<s;i++){var e=result[i];${ITEM}}return o})()`,
    )
    let chapters = await tocOf()
    check(
        chapters.length === 3 &&
            chapters[0]?.name === expected[0] &&
            chapters[2]?.name === expected[2],
        '`result.size()` 与逐个元素拿到 3 个节点，章节名与地址都对',
        `count=${chapters.length} names=${JSON.stringify(chapters.map((c) => c.name))}`,
    )

    // ---- 迭代式：`result.forEach(e => e.attr(...))`（🔞西瓜书屋 的形状） ----
    await importWith(
        '节点绑定测试源（迭代式）',
        `${SEL}@js:(function(){var o=[];result.forEach(function(e){${ITEM}});return o})()`,
    )
    chapters = await tocOf()
    check(
        chapters.length === 3 && chapters[1]?.name === expected[1],
        '`result.forEach(e => e.attr("href"))` 里的 `e` 是元素（能取到 href）',
        `count=${chapters.length} names=${JSON.stringify(chapters.map((c) => c.name))}`,
    )
    check(
        chapters.every((c) => String(c.url).startsWith(`${BASE}/fixture/chapter/`)),
        '每个元素的 `attr("href")` 取到了自己的地址（不是空串）',
        JSON.stringify(chapters.map((c) => c.url)),
    )

    // ---- 单命中 + `result.select("a")`：select 的返回值必须能下标（🔞紫云宫 的形状） ----
    await importWith(
        '节点绑定测试源（select + 下标）',
        `@css:ul.chapter-list@js:(function(){var links=result.select("a");var o=[];for(var i=0;i<links.length;i++){var e=links[i];${ITEM}}return o})()`,
    )
    chapters = await tocOf()
    check(
        chapters.length === 3 && chapters[2]?.name === expected[2],
        '`result.select("a")` 的返回值能下标（`links[i]`），3 条都取到',
        `count=${chapters.length} names=${JSON.stringify(chapters.map((c) => c.name))}`,
    )

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
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

    // reader.js 会 import 这几个模块，因此它们也必须真的能取到 ——
    // 少一个的话浏览器只会报「Failed to fetch dynamically imported module」，
    // 页面照旧打开、阅读界面却是空的，光看首页看不出问题
    for (const asset of [
        '/app.js',
        '/style.css',
        '/js/core.js',
        '/js/views.js',
        '/js/reader.js',
        '/js/merge.js',
        '/js/replace.js',
        '/js/replaceSync.js',
        '/js/search.js',
        '/js/zoom.js',
    ]) {
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

console.log('\n=== 7. 账号、书架、阅读进度与书签 ===')
{
    const sourceId = 'builtin:fixture-css'
    const bookUrl = `${BASE}/fixture/book/1`
    const chapterUrl = `${BASE}/fixture/chapter/1/1`

    // ---- 未登录必须被挡住：这是「需要登录」的底线，不能只靠前端藏界面 ----
    const anonShelf = await fetch(`${BASE}/api/shelf`)
    const anonShelfBody = parseMaybeJson(await anonShelf.text())
    check(
        anonShelf.status === 401 && anonShelfBody?.code === 'unauthenticated',
        '未登录访问书架返回 401 unauthenticated',
        `status=${anonShelf.status} code=${anonShelfBody?.code}`,
    )
    const anonHome = await fetch(`${BASE}/api/home`)
    check(anonHome.status === 401, '未登录访问首页接口同样是 401', `status=${anonHome.status}`)

    // ---- 注册两个账号，之后所有书架/进度操作都用它们的会话 ----
    const a = await sessionUser('smokea')
    const b = await sessionUser('smokeb')
    check(
        a.status === 201 && b.status === 201 && a.cookie !== '' && b.cookie !== '',
        '注册两个临时账号并拿到会话 cookie',
        `${a.status}/${b.status} cookie=${a.cookie !== ''}/${b.cookie !== ''}`,
    )

    const meA = await a.call('GET', '/api/auth/me')
    check(
        meA.json?.user?.username === a.username,
        '/api/auth/me 认得会话（cookie 生效）',
        JSON.stringify(meA.json?.user?.username),
    )

    // 登录接口的几条否定路径：都必须是明确的状态码，而不是含混的失败
    const repeat = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: a.username, password: 'smoke-password-1' }),
    })
    check(repeat.status === 409, '重复用户名注册返回 409', `status=${repeat.status}`)

    const weak = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `${a.username}x`, password: 'short' }),
    })
    check(weak.status === 400, '弱口令被拒（400）', `status=${weak.status}`)

    const wrongPassword = await a.call('POST', '/api/auth/login', {
        username: a.username,
        password: 'definitely-wrong',
    })
    check(
        wrongPassword.status === 401 && wrongPassword.json?.code === 'bad_credentials',
        '密码不对返回 401 bad_credentials',
        `status=${wrongPassword.status} code=${wrongPassword.json?.code}`,
    )

    const unknownUser = await a.call('POST', '/api/auth/login', {
        username: `nobody${Date.now().toString(36)}`,
        password: 'whatever-12345',
    })
    check(
        unknownUser.status === 401 && unknownUser.json?.error === wrongPassword.json?.error,
        '账号不存在与密码不对给出同一句话（不泄漏哪个用户名存在）',
        JSON.stringify(unknownUser.json?.error),
    )

    const callA = (method, path, body) => a.call(method, path, body)
    const shelfOf = async (user = a) => (await user.call('GET', '/api/shelf')).json?.entries ?? []

    // 新账号的书架天然是空的，不需要清理上一次的残留
    const baseline = (await shelfOf()).length
    check(baseline === 0, '新账号的书架是空的', `count=${baseline}`)

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

    const readBack = await a.call(
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

    const progressGone = await a.call(
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

    const shelfA = await shelfOf(a)
    const shelfB = await shelfOf(b)
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
    const progressA = await a.call('GET', progressQuery)
    const progressB = await b.call('GET', progressQuery)
    check(progressA.json?.progress !== null, '身份 A 有阅读进度')
    check(
        progressB.json?.progress === null,
        '身份 B 没有阅读进度（看不到 A 的）',
        JSON.stringify(progressB.json?.progress),
    )

    // B 删不掉 A 的书架条目：按 owner 过滤之后应当报「找不到」而不是删掉别人的
    const keyOfA = shelfA.find((e) => e.name === '甲的书')?.bookKey ?? ''
    const deleteByB = await b.call('DELETE', `/api/shelf?key=${encodeURIComponent(keyOfA)}`)
    check(
        deleteByB.status === 404,
        '身份 B 删不掉 A 的书架条目（404 而不是删掉）',
        `status=${deleteByB.status} code=${deleteByB.json?.code}`,
    )
    check(
        (await shelfOf(a)).some((e) => e.bookKey === keyOfA),
        'A 的书架条目仍在',
    )

    // 登出之后会话必须立刻失效：真正把「会话」和「只是一串本地数据」区分开的正是这一条
    await a.call('POST', '/api/auth/logout', {})
    const afterLogout = await a.call('GET', '/api/shelf')
    check(
        afterLogout.status === 401,
        '登出后原 cookie 立即失效（401）',
        `status=${afterLogout.status}`,
    )

    const backIn = await a.call('POST', '/api/auth/login', {
        username: a.username,
        password: 'smoke-password-1',
    })
    check(backIn.status === 200, '用密码重新登录成功', `status=${backIn.status}`)
    const afterLogin = await a.call('GET', '/api/shelf')
    check(
        afterLogin.status === 200 && (afterLogin.json?.entries ?? []).length > 0,
        '重新登录后书架还在（数据挂在账号上，不是挂在会话上）',
        `count=${(afterLogin.json?.entries ?? []).length}`,
    )

    // 收尾：把 A 造的数据清掉
    await callA('DELETE', `/api/shelf?key=${encodeURIComponent(keyOfA)}`)
    check((await shelfOf(a)).length === baseline, '身份 A 的数据已清理')
    check((await shelfOf(b)).length === 0, '身份 B 始终没有数据')

    // ------------------------------------------------------------ 书签

    // 书签与进度是两种数据：进度只有一条、跟着你走；书签是**攒下来的**，
    // 一条一处、可以很多条、可以带备注、可以被单独删掉。所以这一段重点在
    // 「每条各自独立」与「换了身份一条也看不到」。

    const bmQuery = `/api/bookmarks?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`

    const anonBookmarks = await fetch(`${BASE}${bmQuery}`)
    check(anonBookmarks.status === 401, '未登录读书签返回 401', `status=${anonBookmarks.status}`)

    const bmEmpty = await callA('GET', bmQuery)
    check(
        bmEmpty.status === 200 && bmEmpty.json?.count === 0,
        '这本书还没有书签',
        `count=${bmEmpty.json?.count}`,
    )

    const bmAdded = await callA('POST', '/api/bookmarks', {
        sourceId,
        bookUrl,
        chapterUrl,
        chapterName: '第一章 起风了',
        chapterIndex: 0,
        pageIndex: 2,
        excerpt: '这是一段摘录',
        note: '这里的伏笔',
    })
    const bmId = bmAdded.json?.bookmark?.id ?? ''
    check(bmAdded.status === 201 && bmId !== '', '加一条书签（201）', `status=${bmAdded.status}`)
    check(
        bmAdded.json?.bookmark?.excerpt === '这是一段摘录' &&
            bmAdded.json?.bookmark?.note === '这里的伏笔' &&
            bmAdded.json?.bookmark?.pageIndex === 2,
        '摘录、备注、位置都原样存下',
        JSON.stringify(bmAdded.json?.bookmark),
    )

    // 同一位置再留一条：**不去重**。书签的语义是「我在这里留了个标记」，
    // 去重会把「同一页留两处不同备注」这种用法直接堵死
    const bmSecond = await callA('POST', '/api/bookmarks', {
        sourceId,
        bookUrl,
        chapterUrl,
        chapterName: '第一章 起风了',
        chapterIndex: 0,
        pageIndex: 2,
        excerpt: '同一页的第二次标注',
    })
    check(bmSecond.status === 201, '同一位置可以再留一条（不去重）', `status=${bmSecond.status}`)

    const bmOther = await callA('POST', '/api/bookmarks', {
        sourceId,
        bookUrl,
        chapterUrl: `${BASE}/fixture/chapter/1/2`,
        chapterName: '第二章',
        chapterIndex: 1,
        percent: 0.5,
    })
    check(bmOther.status === 201, '另一章的一条书签', `status=${bmOther.status}`)

    const bmItems = (await callA('GET', bmQuery)).json?.bookmarks ?? []
    check(bmItems.length === 3, '列表返回 3 条', `count=${bmItems.length}`)
    check(
        bmItems[0]?.chapterIndex === 0 && bmItems[2]?.chapterIndex === 1,
        '按章节顺序排（不是按加入时间）',
        JSON.stringify(bmItems.map((item) => item.chapterIndex)),
    )
    check(
        Math.abs((bmItems[2]?.percent ?? 0) - 0.5) < 1e-9,
        '滚动位置按比例存下来（跳回时才落得到原处）',
        String(bmItems[2]?.percent),
    )

    const bmNoted = await callA('PUT', '/api/bookmarks', { id: bmId, note: '改成新的备注' })
    check(
        bmNoted.json?.bookmark?.note === '改成新的备注' && bmNoted.json?.bookmark?.pageIndex === 2,
        '改备注不动位置',
        JSON.stringify({
            note: bmNoted.json?.bookmark?.note,
            page: bmNoted.json?.bookmark?.pageIndex,
        }),
    )

    const bmMissing = await callA('POST', '/api/bookmarks', { sourceId, bookUrl })
    check(
        bmMissing.status === 400 && bmMissing.json?.code === 'invalid_bookmark_input',
        '缺 chapterUrl 返回 400 invalid_bookmark_input',
        `status=${bmMissing.status} code=${bmMissing.json?.code}`,
    )

    // 隔离：书签 id 是随机串，但别人的 id 也必须删不掉、看不着
    const bmOfB = await b.call('GET', bmQuery)
    check(bmOfB.json?.count === 0, '身份 B 看不到 A 的书签', `count=${bmOfB.json?.count}`)
    const bmForeign = await b.call('DELETE', `/api/bookmarks?id=${encodeURIComponent(bmId)}`)
    check(
        bmForeign.status === 404 && bmForeign.json?.code === 'bookmark_not_found',
        '身份 B 删不掉 A 的书签（404 而不是删掉）',
        `status=${bmForeign.status} code=${bmForeign.json?.code}`,
    )

    const bmRemoved = await callA('DELETE', `/api/bookmarks?id=${encodeURIComponent(bmId)}`)
    check(
        bmRemoved.status === 200 && bmRemoved.json?.removed === bmId,
        '删除自己的一条书签',
        JSON.stringify(bmRemoved.json),
    )
    check((await callA('GET', bmQuery)).json?.count === 2, '删除后剩 2 条')

    const bmRemoveAgain = await callA('DELETE', `/api/bookmarks?id=${encodeURIComponent(bmId)}`)
    check(
        bmRemoveAgain.status === 404 && bmRemoveAgain.json?.code === 'bookmark_not_found',
        '重复删除报 404 bookmark_not_found',
        JSON.stringify(bmRemoveAgain.json?.code),
    )

    // 收尾：剩下的清掉，重复运行不在库里越积越多
    for (const item of (await callA('GET', bmQuery)).json?.bookmarks ?? []) {
        await callA('DELETE', `/api/bookmarks?id=${encodeURIComponent(item.id)}`)
    }
    check((await callA('GET', bmQuery)).json?.count === 0, '书签已清理')
}

console.log('\n=== 7b. 改显示名与改密码 ===')
{
    /**
     * 账号设置这一页原先不存在（顶栏那个按钮直接就是「退出登录」），服务端也连接口都没有 ——
     * 于是用户一旦怀疑密码泄露，唯一能做的是重新注册一个账号，书架、进度、书签全留在旧的里。
     *
     * 这一节盯住三件容易做错的事：
     *   1. 改密码必须**带当前密码**（否则一条偷来的会话就能永久占住账号），
     *      而且失败要计进失败计数 —— 不然这里就是个不限速的口令猜测入口；
     *   2. 改完之后**其它设备的会话必须失效**，而当前这条必须还能用；
     *   3. 新密码要真的登得进去，旧密码要真的登不进去。
     */
    const user = await sessionUser('smokeacct')
    check(user.status === 201, '注册一个临时账号用于账号设置', `status=${user.status}`)

    const renamed = await user.call('PATCH', '/api/account', { displayName: '读书人·烟雾' })
    check(
        renamed.status === 200 && renamed.json?.user?.displayName === '读书人·烟雾',
        '改显示名：返回新的显示名',
        `status=${renamed.status} displayName=${renamed.json?.user?.displayName}`,
    )
    const me = await user.call('GET', '/api/auth/me')
    check(
        me.json?.user?.displayName === '读书人·烟雾' && me.json?.user?.username === user.username,
        '改显示名之后 /me 跟着变，用户名不变',
        `displayName=${me.json?.user?.displayName} username=${me.json?.user?.username}`,
    )
    const badName = await user.call('PATCH', '/api/account', { displayName: '张三\n李四' })
    check(badName.status === 400, '显示名里的换行被拒（400）', `status=${badName.status}`)

    // 「另一台设备」：同一账号再登一次，拿第二条会话
    const secondLogin = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username, password: 'smoke-password-1' }),
    })
    const secondCookie = (secondLogin.headers.get('set-cookie') ?? '').split(';')[0]
    check(
        secondLogin.status === 200 && secondCookie !== '',
        '同一账号在「另一台设备」上再登一次',
        `status=${secondLogin.status}`,
    )

    const wrongCurrent = await user.call('POST', '/api/account/password', {
        currentPassword: 'not-the-password',
        newPassword: 'smoke-password-2',
    })
    check(
        wrongCurrent.status === 400,
        '当前密码不对时被拒（400，而不是 500）',
        `status=${wrongCurrent.status}`,
    )

    const samePassword = await user.call('POST', '/api/account/password', {
        currentPassword: 'smoke-password-1',
        newPassword: 'smoke-password-1',
    })
    check(
        samePassword.status === 400,
        '新密码与当前密码相同被拒（400）',
        `status=${samePassword.status}`,
    )

    const weakNext = await user.call('POST', '/api/account/password', {
        currentPassword: 'smoke-password-1',
        newPassword: 'short',
    })
    check(
        weakNext.status === 400,
        '新密码太短被拒（400）—— 与注册共用同一份长度校验',
        `status=${weakNext.status}`,
    )

    const changed = await user.call('POST', '/api/account/password', {
        currentPassword: 'smoke-password-1',
        newPassword: 'smoke-password-2',
    })
    check(
        changed.status === 200 && Number(changed.json?.revoked ?? 0) >= 1,
        '改密码成功，并踢掉了其它设备上的会话',
        `status=${changed.status} revoked=${changed.json?.revoked}`,
    )

    const stillMine = await user.call('GET', '/api/auth/me')
    check(
        stillMine.json?.user != null,
        '当前这条会话仍然有效（没把自己也踢下线）',
        `user=${stillMine.json?.user?.username ?? 'null'}`,
    )

    const kicked = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: secondCookie } })
    const kickedBody = parseMaybeJson(await kicked.text())
    check(
        kickedBody?.user == null,
        '另一台设备的会话已失效',
        `user=${kickedBody?.user?.username ?? 'null'}`,
    )

    const oldLogin = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username, password: 'smoke-password-1' }),
    })
    check(oldLogin.status === 401, '旧密码登不进去了（401）', `status=${oldLogin.status}`)

    const newLogin = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username, password: 'smoke-password-2' }),
    })
    check(newLogin.status === 200, '新密码能登进去', `status=${newLogin.status}`)
}

console.log('\n=== 7c. 导出 / 导入备份 ===')
{
    /**
     * 书架、阅读进度、书签只存在这个部署的 D1 里，之前**没有任何办法**搬走 ——
     * 换部署、换账号，攒下的东西就留在原地。
     *
     * 这一节把「两台设备」演出来：A 攒了三样 → 导出 → B 导入 → B 拿到同样的东西；
     * 再往下是三件「只测一次导入会漏掉」的事：
     *   - 同一份文件再导一次必须**幂等**（重试、两台机器各导一次都很常见）；
     *   - 拿一份**更旧的**进度导进来，不能把 B 读到的新章节倒回去；
     *   - 导出必须**只含自己账号的东西**（否则就是一次数据泄露）。
     */
    const sourceId = 'builtin:fixture-css'
    const bookUrl = `${BASE}/fixture/book/1`
    const chapterUrl = `${BASE}/fixture/chapter/1/1`

    const a = await sessionUser('smoketransa')
    const b = await sessionUser('smoketransb')

    await a.call('POST', '/api/shelf', {
        sourceId,
        bookUrl,
        name: '测试小说·甲',
        author: '作者甲',
    })
    await a.call('PUT', '/api/progress', {
        sourceId,
        bookUrl,
        chapterUrl,
        chapterName: '第一章 起风了',
        chapterIndex: 0,
        pageIndex: 2,
    })
    await a.call('POST', '/api/bookmarks', {
        sourceId,
        bookUrl,
        chapterUrl,
        chapterName: '第一章 起风了',
        chapterIndex: 0,
        pageIndex: 1,
        note: '备份往返测试',
    })

    const exported = await a.call('GET', '/api/backup')
    check(
        exported.status === 200 &&
            exported.json?.kind === 'reader-cloudflare-backup' &&
            exported.json?.counts?.shelf === 1 &&
            exported.json?.counts?.progress === 1 &&
            exported.json?.counts?.bookmarks === 1,
        '导出：一份带 kind 与计数的备份',
        `status=${exported.status} counts=${JSON.stringify(exported.json?.counts)}`,
    )

    const imported = await b.call('POST', '/api/backup', exported.json)
    check(
        imported.status === 200 &&
            imported.json?.imported?.shelf === 1 &&
            imported.json?.imported?.progress === 1 &&
            imported.json?.imported?.bookmarks === 1,
        '导入：三样都进了另一个账号',
        `status=${imported.status} imported=${JSON.stringify(imported.json?.imported)}`,
    )

    const bShelf = await b.call('GET', '/api/shelf')
    const bProgress = await b.call(
        'GET',
        `/api/progress?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
    )
    const bBookmarks = await b.call(
        'GET',
        `/api/bookmarks?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
    )
    check(
        bShelf.json?.count === 1 && bShelf.json?.entries?.[0]?.name === '测试小说·甲',
        '导入之后 B 的书架里就有了这本书',
        `count=${bShelf.json?.count} name=${bShelf.json?.entries?.[0]?.name ?? ''}`,
    )
    check(
        bProgress.json?.progress?.pageIndex === 2 &&
            bProgress.json?.progress?.chapterName === '第一章 起风了',
        '导进来的阅读位置带上了「停在第几页」',
        `pageIndex=${bProgress.json?.progress?.pageIndex}`,
    )
    check(
        bBookmarks.json?.count === 1 && bBookmarks.json?.bookmarks?.[0]?.note === '备份往返测试',
        '导进来的书签连备注一起',
        `count=${bBookmarks.json?.count}`,
    )

    const again = await b.call('POST', '/api/backup', exported.json)
    check(
        again.json?.imported?.shelf === 0 &&
            again.json?.imported?.bookmarks === 0 &&
            again.json?.imported?.progress === 0 &&
            again.json?.imported?.progressKept === 1,
        '同一份文件再导一次是幂等的（不新增、不变两倍）',
        `imported=${JSON.stringify(again.json?.imported)}`,
    )
    const stillOne = await b.call('GET', '/api/shelf')
    check(
        stillOne.json?.count === 1,
        '书架仍然只有一本（没被导成两本）',
        `count=${stillOne.json?.count}`,
    )

    // B 往后读，再导一份**更旧的**进度：不能倒回去
    await b.call('PUT', '/api/progress', {
        sourceId,
        bookUrl,
        chapterUrl: `${BASE}/fixture/chapter/1/3`,
        chapterName: '第三章 天晴了',
        chapterIndex: 2,
        pageIndex: 5,
    })
    const stale = {
        ...exported.json,
        progress: [{ ...exported.json.progress[0], chapterIndex: 0, pageIndex: 2, updatedAt: 1 }],
    }
    const staleImport = await b.call('POST', '/api/backup', stale)
    const afterStale = await b.call(
        'GET',
        `/api/progress?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
    )
    check(
        staleImport.json?.imported?.progress === 0 &&
            staleImport.json?.imported?.progressKept === 1 &&
            afterStale.json?.progress?.chapterIndex === 2 &&
            afterStale.json?.progress?.pageIndex === 5,
        '导一份更旧的备份：读到的新章节没被倒回去（更新者胜）',
        `kept=${staleImport.json?.imported?.progressKept} chapterIndex=${afterStale.json?.progress?.chapterIndex}`,
    )

    const fresh = await sessionUser('smoketransc')
    const freshBackup = await fresh.call('GET', '/api/backup')
    check(
        freshBackup.json?.counts?.shelf === 0 &&
            freshBackup.json?.counts?.progress === 0 &&
            freshBackup.json?.counts?.bookmarks === 0,
        '导出只含自己账号的数据（新账号导出来是空的）',
        `counts=${JSON.stringify(freshBackup.json?.counts)}`,
    )

    const notBackup = await b.call('POST', '/api/backup', [{ bookSourceName: '某源' }])
    check(
        notBackup.status === 400 && notBackup.json?.code === 'invalid_backup',
        '把书源合集当备份导入被拒（400 invalid_backup）',
        `status=${notBackup.status} code=${notBackup.json?.code}`,
    )
    const brokenJson = await b.call('POST', '/api/backup', '{ 这不是 JSON')
    check(brokenJson.status === 400, '不是 JSON 被拒（400）', `status=${brokenJson.status}`)
    const badRecord = await b.call('POST', '/api/backup', {
        ...exported.json,
        shelf: [{ sourceId: 'a', name: '缺地址' }],
    })
    check(
        badRecord.status === 400 && /bookUrl/.test(String(badRecord.json?.error ?? '')),
        '记录缺字段时明确指出是哪个字段',
        `status=${badRecord.status} error=${badRecord.json?.error}`,
    )
    const anon = await fetch(`${BASE}/api/backup`)
    check(anon.status === 401, '未登录不能导出（401）', `status=${anon.status}`)
}

console.log('\n=== 7d. 书签清单导出（Markdown / CSV）===')
{
    /**
     * 与「导出备份」的分工：那个是整份数据的 JSON（为了能导回来），
     * 这个是**能读**的清单（摘录 + 备注，按章节排）。断言的是内容形态：
     * 时区写没写、Markdown 表格会不会被摘录里的竖线拆散、CSV 有没有 BOM 与 CRLF、
     * 中文文件名有没有走 `filename*`、只给一半过滤参数时会不会「以为导的是这本」。
     */
    const sourceId = 'builtin:fixture-css'
    const bookUrl = `${BASE}/fixture/book/1`

    const anon = await fetch(`${BASE}/api/export/bookmarks`)
    check(anon.status === 401, '未登录导出书签清单返回 401', `status=${anon.status}`)

    const e = await sessionUser('smokee')
    // 先把两本书加进书架：清单里的书名/作者是**从书架拼的**（书签表里没有书名），
    // 不加的话两本书都会显示成空书名 —— 那也是一种真实情况，但会把「按书分组」这条测没了
    for (const [url, name, author] of [
        [bookUrl, '测试小说·甲', '作者甲'],
        [`${BASE}/fixture/book/2`, '测试小说·乙', '作者乙'],
    ]) {
        await e.call('POST', '/api/shelf', { sourceId, bookUrl: url, name, author })
    }
    const addBookmark = (url, excerpt, note) =>
        e.call('POST', '/api/bookmarks', {
            sourceId,
            bookUrl: url,
            chapterUrl: `${BASE}/fixture/chapter/1/1`,
            chapterName: '第一章 起风了',
            chapterIndex: 0,
            pageIndex: 2,
            excerpt,
            note,
        })
    await addBookmark(bookUrl, '这是一段摘录', '备注|带竖线')
    await addBookmark(`${BASE}/fixture/book/2`, '另一段,带逗号', '另一条')

    const getText = async (query) => {
        const res = await fetch(`${BASE}/api/export/bookmarks${query}`, {
            headers: { cookie: e.cookie },
        })
        // BOM 会被 `res.text()` / `TextDecoder` 吃掉，所以字节要单独留一份来断言
        const bytes = new Uint8Array(await res.arrayBuffer())
        return {
            status: res.status,
            type: res.headers.get('content-type') ?? '',
            disposition: res.headers.get('content-disposition') ?? '',
            bytes,
            body: new TextDecoder().decode(bytes),
        }
    }

    const md = await getText('?format=md')
    check(
        md.status === 200 && md.type.includes('text/markdown'),
        'Markdown 清单回 text/markdown',
        `${md.status} ${md.type}`,
    )
    check(
        md.body.includes('# 书签清单') &&
            md.body.includes('（UTC+8）') &&
            md.body.includes('- 共 2 条，来自 2 本书'),
        '清单里写了时区与条数',
        JSON.stringify(md.body.split('\n').slice(0, 6)),
    )
    check(
        md.body.includes('备注\\|带竖线'),
        'Markdown 表格里的竖线被转义（否则列数会变）',
        JSON.stringify(md.body.split('\n').find((line) => line.includes('竖线')) ?? ''),
    )
    check(
        md.disposition.includes("filename*=UTF-8''") &&
            md.disposition.includes('%E4%B9%A6%E7%AD%BE'),
        '中文文件名走 filename*（头部里不能出现非 ASCII）',
        md.disposition,
    )

    const csv = await getText('?format=csv')
    check(
        csv.status === 200 && csv.type.includes('text/csv'),
        'CSV 清单回 text/csv',
        `${csv.status} ${csv.type}`,
    )
    check(
        csv.bytes[0] === 0xef &&
            csv.bytes[1] === 0xbb &&
            csv.bytes[2] === 0xbf &&
            csv.body.includes('\r\n') &&
            csv.body.includes('书名,作者,章节,位置,摘录,备注,添加时间'),
        'CSV 带 BOM 与 CRLF（不然 Excel 双击是乱码）',
        `${csv.bytes[0]},${csv.bytes[1]},${csv.bytes[2]} ${JSON.stringify(csv.body.slice(0, 40))}`,
    )
    check(
        csv.body.includes('"另一段,带逗号"'),
        'CSV 里含逗号的字段加了引号',
        JSON.stringify(csv.body.split('\r\n').find((line) => line.includes('逗号')) ?? ''),
    )

    const one = await getText(
        `?format=md&sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
    )
    check(
        one.body.includes('- 共 1 条，来自 1 本书') && one.body.includes('这是一段摘录'),
        '给全 sourceId + bookUrl 时只导这一本',
        JSON.stringify(one.body.split('\n').slice(0, 5)),
    )
    const half = await getText(`?format=md&sourceId=${encodeURIComponent(sourceId)}`)
    check(
        half.body.includes('- 共 2 条，来自 2 本书'),
        '只给一半参数时按「全部」处理（不猜）',
        JSON.stringify(half.body.split('\n').slice(0, 5)),
    )
}

console.log('\n=== 7e. 替换净化规则跟着账号走 ===')
{
    // 规则本身在浏览器 localStorage（改一条立刻重排正文），这一层只负责把它搬上账号。
    // 冒烟要验的是**搬的过程**：整份往返、冲突不覆盖、账号之间互相看不见。
    // 那三条单测都碰不到 —— 它们的价值全在于和 D1 里那一行真的对上。

    const user = await sessionUser('repl')
    check(user.status === 201 && user.cookie !== '', '临时账号注册成功', `HTTP ${user.status}`)

    const fresh = await user.call('GET', '/api/replace')
    check(
        fresh.status === 200 &&
            fresh.json?.updatedAt === 0 &&
            (fresh.json?.rules ?? []).length === 0,
        '从没同步过的账号得到空的一份，而不是 404',
        `HTTP ${fresh.status} ${fresh.text.slice(0, 80)}`,
    )

    // 没登录的人不该能读也不能写（规则是私人格式偏好，但接口一样要挡住）
    const anonGet = await getJson('/api/replace')
    const anonPut = await call('PUT', '/api/replace', { rules: [], baseUpdatedAt: 0 })
    check(
        anonGet.status === 401 && anonPut.status === 401,
        '未登录时读/写都是 401',
        `GET ${anonGet.status} PUT ${anonPut.status}`,
    )

    const local = [
        { name: '去广告', group: '通用', pattern: '广告', replacement: '', enabled: true },
        { name: '去掉空行', group: '排版', pattern: '\\n{2,}', replacement: '\n', enabled: false },
    ]
    const first = await user.call('PUT', '/api/replace', { rules: local, baseUpdatedAt: 0 })
    const firstAt = Number(first.json?.updatedAt ?? 0)
    check(
        first.status === 200 && firstAt > 0,
        '上传一份规则，拿到一个新的版本时间戳',
        `HTTP ${first.status} ${first.text.slice(0, 80)}`,
    )

    const back = await user.call('GET', '/api/replace')
    const got = back.json?.rules ?? []
    check(
        got.length === 2 &&
            got[0].pattern === '广告' &&
            got[1].name === '去掉空行' &&
            got[1].enabled === false &&
            got[1].replacement === '\n',
        '整份往返：条数、顺序、停用状态、替换串（真的换行）都没变',
        JSON.stringify(got.slice(0, 2)),
    )

    // 字段归一：少写 group、name 写成数字，都不该让整份传不上去
    const loose = await user.call('PUT', '/api/replace', {
        rules: [{ name: 123, pattern: '广告' }],
        baseUpdatedAt: firstAt,
    })
    const looseBack = await user.call('GET', '/api/replace')
    check(
        loose.status === 200 &&
            looseBack.json.rules.length === 1 &&
            looseBack.json.rules[0].name === '123' &&
            looseBack.json.rules[0].group === '默认' &&
            looseBack.json.rules[0].enabled === true,
        '缺字段/写数字都收敛成能用的值（不是拒绝整份）',
        JSON.stringify(looseBack.json?.rules ?? []),
    )
    const secondAt = Number(looseBack.json?.updatedAt ?? 0)
    check(secondAt > firstAt, '每次写入的时间戳都往前走', `${firstAt} → ${secondAt}`)

    // 冲突：拿一个过期的基准再传一次，服务端**不许写**，而是把现在那份回给客户端
    const stale = await user.call('PUT', '/api/replace', { rules: local, baseUpdatedAt: firstAt })
    check(
        stale.status === 409 &&
            stale.json?.code === 'replace_rules_conflict' &&
            (stale.json?.server?.rules ?? []).length === 1 &&
            Number(stale.json?.server?.updatedAt ?? 0) === secondAt,
        '基准过期时回 409 并附上服务端现在那份（不做「最后写入者胜」）',
        `HTTP ${stale.status} ${stale.json?.code} server=${(stale.json?.server?.rules ?? []).length} 条`,
    )
    const afterConflict = await user.call('GET', '/api/replace')
    check(
        (afterConflict.json?.rules ?? []).length === 1,
        '被拒绝的那一次**没有**写进去（库里还是 1 条）',
        `${(afterConflict.json?.rules ?? []).length} 条`,
    )

    // 用户看过服务端那份之后，拿它的版本当基准再传一次 —— 这就是「确认覆盖」的口子
    const forced = await user.call('PUT', '/api/replace', { rules: local, baseUpdatedAt: secondAt })
    const afterForce = await user.call('GET', '/api/replace')
    check(
        forced.status === 200 && (afterForce.json?.rules ?? []).length === 2,
        '带上刚看到的版本号重传即覆盖（不需要额外的「强制」标志）',
        `HTTP ${forced.status} ${(afterForce.json?.rules ?? []).length} 条`,
    )

    // 另一个账号看不见：这份规则挂在 owner 上，不是全局表
    const other = await sessionUser('repl2')
    const otherGet = await other.call('GET', '/api/replace')
    check(
        otherGet.status === 200 && (otherGet.json?.rules ?? []).length === 0,
        '另一个账号读到的是空的一份（规则跟着账号走）',
        JSON.stringify(otherGet.json?.rules ?? []),
    )

    // 坏数据要说得清坏在哪，而不是「格式不对」
    const notArray = await user.call('PUT', '/api/replace', { rules: { a: 1 }, baseUpdatedAt: 0 })
    const badItem = await user.call('PUT', '/api/replace', {
        rules: [local[0], '这不是对象'],
        baseUpdatedAt: 0,
    })
    check(
        notArray.status === 400 &&
            notArray.json?.code === 'invalid_replace_rules' &&
            /数组/.test(notArray.json?.error ?? ''),
        'rules 不是数组 → 400，并说清应该是数组',
        `HTTP ${notArray.status} ${notArray.json?.error}`,
    )
    check(
        badItem.status === 400 && /第 2 条/.test(badItem.json?.error ?? ''),
        '坏在第 2 条就报到第 2 条',
        `HTTP ${badItem.status} ${badItem.json?.error}`,
    )

    const tooMany = await user.call('PUT', '/api/replace', {
        rules: Array.from({ length: 201 }, () => local[0]),
        baseUpdatedAt: secondAt,
    })
    check(
        tooMany.status === 400 && tooMany.json?.code === 'too_many_replace_rules',
        '超过 200 条 → 400 too_many_replace_rules',
        `HTTP ${tooMany.status} ${tooMany.json?.error}`,
    )

    const huge = await user.call('PUT', '/api/replace', {
        rules: [],
        baseUpdatedAt: secondAt,
        padding: 'x'.repeat(2 * 1024 * 1024 + 4096),
    })
    check(
        huge.status === 413 && huge.json?.code === 'body_too_large',
        '请求体超过 2 MiB → 413（先看 content-length，不先解析）',
        `HTTP ${huge.status} ${huge.json?.error}`,
    )
}

console.log('\n=== 7f. 笔记（独立于书签，且进备份） ===')
{
    // 笔记与书签**几乎**同形（一张表、四个接口、位置三件套），唯一的硬差别是
    // **正文必填**。所以这一段的重心是：正文为空的各种写法都要被挡住，
    // 以及笔记能进备份、能从备份里回来（换设备不丢东西）。

    const user = await sessionUser('note')
    const other = await sessionUser('note2')
    const sourceId = 'builtin:fixture-css'
    const bookUrl = 'http://127.0.0.1:8787/fixture/book/1'
    const where = `?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`

    const noParams = await user.call('GET', '/api/notes')
    check(noParams.status === 400, '少参数时 400（不猜是哪本书）', `HTTP ${noParams.status}`)

    const empty = await user.call('GET', `/api/notes${where}`)
    check(
        empty.status === 200 && empty.json?.count === 0,
        '新账号这本书没有笔记，回空数组而不是 404',
        JSON.stringify(empty.json),
    )

    // 正文里的换行必须原样带回来 —— 笔记是「一段话」，压掉换行就等于改写了它
    const body = '第一行想法\n\n第二行：换行要保留'
    const created = await user.call('POST', '/api/notes', {
        sourceId,
        bookUrl,
        chapterName: '第一章 起风了',
        chapterIndex: 0,
        pageIndex: 3,
        excerpt: '这一段的原文',
        text: body,
    })
    const noteId = created.json?.note?.id ?? ''
    check(
        created.status === 201 && noteId !== '' && created.json?.note?.text === body,
        '写一条笔记：201，换行原样回来',
        `HTTP ${created.status} ${JSON.stringify(created.json?.note?.text)}`,
    )
    check(
        created.json?.note?.chapterIndex === 0 && created.json?.note?.pageIndex === 3,
        '位置与摘录一起存下（跳回原处要靠它）',
        JSON.stringify({
            chapterIndex: created.json?.note?.chapterIndex,
            pageIndex: created.json?.note?.pageIndex,
            excerpt: created.json?.note?.excerpt,
        }),
    )

    const blank = await user.call('POST', '/api/notes', { sourceId, bookUrl, text: '   ' })
    const missing = await user.call('POST', '/api/notes', { sourceId, bookUrl })
    check(
        blank.status === 400 && blank.json?.code === 'invalid_note_input' && missing.status === 400,
        '正文为空 / 没给正文都 400（书签可以只有一个位置，笔记不行）',
        `blank=${blank.status} ${blank.json?.code} missing=${missing.status}`,
    )

    // 第二条放在后一章，用来验顺序
    await user.call('POST', '/api/notes', {
        sourceId,
        bookUrl,
        chapterName: '第二章',
        chapterIndex: 1,
        pageIndex: 0,
        text: '第二章的一点想法',
    })
    const listed = await user.call('GET', `/api/notes${where}`)
    check(
        listed.json?.count === 2 &&
            listed.json?.notes?.[0]?.chapterIndex === 0 &&
            listed.json?.notes?.[1]?.chapterIndex === 1,
        '两条笔记按章节顺序排（与阅读顺序一致）',
        JSON.stringify((listed.json?.notes ?? []).map((n) => n.chapterIndex)),
    )

    const edited = await user.call('PUT', '/api/notes', { id: noteId, text: '改过之后的想法' })
    check(
        edited.status === 200 &&
            edited.json?.note?.text === '改过之后的想法' &&
            edited.json?.note?.pageIndex === 3 &&
            edited.json?.note?.chapterIndex === 0 &&
            edited.json?.note?.createdAt === created.json?.note?.createdAt &&
            edited.json?.note?.updatedAt > created.json?.note?.updatedAt,
        '改正文：位置与摘录不动、createdAt 不动、updatedAt 往前走',
        JSON.stringify({
            pageIndex: edited.json?.note?.pageIndex,
            createdAt: edited.json?.note?.createdAt,
            updatedAt: edited.json?.note?.updatedAt,
        }),
    )
    const editBlank = await user.call('PUT', '/api/notes', { id: noteId, text: '' })
    const editMissing = await user.call('PUT', '/api/notes', { id: 'not-a-real-id', text: 'x' })
    check(
        editBlank.status === 400 &&
            editMissing.status === 404 &&
            editMissing.json?.code === 'note_not_found',
        '改成空正文 400；改一条不存在的 404（含别人的）',
        `blank=${editBlank.status} missing=${editMissing.status} ${editMissing.json?.code}`,
    )

    // 隔离：另一个账号既看不到、也删不掉
    const otherList = await other.call('GET', `/api/notes${where}`)
    const otherDelete = await other.call('DELETE', `/api/notes?id=${noteId}`)
    const stillThere = await user.call('GET', `/api/notes${where}`)
    check(
        otherList.json?.count === 0 && otherDelete.status === 404 && stillThere.json?.count === 2,
        '换个身份一条也看不到、也删不掉（笔记挂在 owner 上）',
        `other=${otherList.json?.count} delete=${otherDelete.status} mine=${stillThere.json?.count}`,
    )

    // 进备份：导出 → 另一个账号导入 → 读回来
    const exported = await user.call('GET', '/api/backup')
    const file = exported.json
    check(
        file?.version === 2 &&
            file?.counts?.notes === 2 &&
            file?.notes?.[0]?.text === '改过之后的想法',
        '备份 v2 里带上了笔记（正文一字不差）',
        `version=${file?.version} counts=${JSON.stringify(file?.counts)}`,
    )

    const imported = await other.call('POST', '/api/backup', file)
    const back = await other.call('GET', `/api/notes${where}`)
    check(
        imported.status === 200 &&
            imported.json?.imported?.notes === 2 &&
            back.json?.count === 2 &&
            back.json?.notes?.[0]?.text === '改过之后的想法',
        '另一个账号导入后能把笔记读回来',
        `HTTP ${imported.status} imported=${JSON.stringify(imported.json?.imported)} count=${back.json?.count}`,
    )
    const again = await other.call('POST', '/api/backup', file)
    check(
        again.json?.imported?.notes === 0 && again.json?.imported?.notesKept === 2,
        '同一份文件再导一次：一条不多（按 id 去重）',
        JSON.stringify(again.json?.imported),
    )

    // 反方向兼容：v1 的老文件（没有 notes）照常导入
    const { notes: dropped, ...v1 } = file
    void dropped
    const oldImport = await other.call('POST', '/api/backup', { ...v1, version: 1 })
    check(
        oldImport.status === 200 && oldImport.json?.imported?.notes === 0,
        'v1 的老备份照常导入（笔记当成空的，不报错）',
        `HTTP ${oldImport.status} ${JSON.stringify(oldImport.json?.imported)}`,
    )

    const removed = await user.call('DELETE', `/api/notes?id=${noteId}`)
    const afterRemove = await user.call('GET', `/api/notes${where}`)
    const removeAgain = await user.call('DELETE', `/api/notes?id=${noteId}`)
    check(
        removed.status === 200 && afterRemove.json?.count === 1 && removeAgain.status === 404,
        '删掉一条：剩下 1 条，再删同一条是 404',
        `removed=${removed.status} left=${afterRemove.json?.count} again=${removeAgain.status}`,
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
        // 报错文案在「第十轮」改过：拦住它的理由从「asyncify 不支持嵌套挂起」
        // 变成了「会话的串行链只有一个，嵌套会自己等自己」。断言只钉语义（拦住 + 说清原因）
        nestedPer?.ok === false && String(nestedPer?.error ?? '').includes('不能再套 JS'),
        'java.getString 里再套 JS 会明确报错，而不是悄悄挂起',
        JSON.stringify(nestedPer?.error ?? nestedPer?.books?.[0]?.wordCount),
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), '沙箱助手测试源已清理')
}

console.log('\n=== 15b. java.setContent / digestHex / 一批 UI 动作 ===')
{
    /**
     * 这一节补的是「沙箱里缺函数」这一类 —— 它的症状最难查：
     * `xxx is not a function` 会把**整条规则**带走，而书源里这些调用常和取数据写在同一个
     * `try` 里。全量数过之后（`java.xxx(` 的分布）补了这些：
     *
     *   - `java.setContent(content)`：设过之后 `getString` / `getElements` 不带第二个参数
     *     就在这份内容上求值。早先是一条「需要 WebView」的报错，但它根本不需要 WebView。
     *     `⚡📂八一中文网` 的搜索规则靠它（13 源 / 18 处）
     *   - `java.digestHex(str, alg)`：线上用 MD5 与 SHA-256（后者走 WebCrypto 的异步桥）
     *   - 一批 UI/App 动作：openUrl / open / openWeb / openBook / refreshTocUrl /
     *     upLoginData / copyText / sleep / searchBook（24 处引用）
     */
    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '沙箱助手补测源',
                bookSourceUrl: BASE,
                ruleBookInfo: {
                    // setContent 之后，不带第二个参数的 getString 应当在这段内容上求值
                    name: `@js:java.setContent('<div id="sc">换过的内容</div>'); java.getString('#sc@text')`,
                    // 两个算法都要对：MD5 走同步桥，SHA-256 走异步桥
                    author: `@js:java.digestHex('abc', 'MD5') + '|' + java.digestHex('abc', 'SHA-256')`,
                    // 所有 UI/App 动作连着一起来一遍：一个都不能是 not a function
                    intro: `@js:java.toast('x'); java.longToast('x'); java.refreshExplore(); java.refreshTocUrl(); java.upLoginData(); java.openUrl('http://x'); java.open('login'); java.openWeb('http://x'); java.openBook('1'); java.copyText('x'); java.sleep(1); java.searchBook('x', 'y'); java.randomUUID().length === 36 ? 'UI-OK' : 'UI-BAD'`,
                    // 没实现的算法必须**明确报错**，不能静默给空（签名算错更难查）
                    coverUrl: `@js:(function(){try{java.digestHex('abc','SHA-512');return 'NO-ERROR'}catch(e){return String(e.message || e)}})()`,
                },
            },
        ]),
    )

    const book = await getJson(
        `/api/book?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(`${BASE}/fixture/book/1`)}`,
    )
    const info = book.json ?? {}
    check(
        info.name === '换过的内容',
        '`java.setContent` 之后 `getString` 在换过的内容上求值',
        JSON.stringify(info.name),
    )
    check(
        info.author ===
            '900150983cd24fb0d6963f7d28e17f72|ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        '`java.digestHex` 的 MD5 与 SHA-256 都是标准答案',
        JSON.stringify(info.author),
    )
    check(
        info.intro === 'UI-OK',
        '一批 UI/App 动作都不是 not a function',
        JSON.stringify(info.intro),
    )
    // `coverUrl` 是**地址字段**，引擎会把值当地址补全并转义，所以这里要先解码再看内容
    const coverErr = (() => {
        try {
            return decodeURIComponent(String(info.coverUrl ?? ''))
        } catch {
            return String(info.coverUrl ?? '')
        }
    })()
    check(
        coverErr.includes('SHA512') && coverErr.includes('不支持'),
        '`digestHex` 遇到没实现的算法时明确报错（而不是给空值）',
        JSON.stringify(coverErr.slice(0, 120)),
    )

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
}

console.log('\n=== 15c. java.put / java.get(k) 变量表，以及未实现能力的报错 ===')
{
    /**
     * 两条都是**扫全量语料数出来**的（`java.xxx(` 的分布），不是想当然：
     *
     *  1. `java.put(k, v)` 130 处、一参 `java.get(k)` 141 处、二参 `java.get(url, h)` 35 处。
     *     也就是说 Legado 的 `get` 是**同名两个重载**：一参读变量、二参取网。
     *     本引擎以前把 `get` 一律当取网（于是 `if (java.get("单") == '')` 会去请求一个
     *     叫「单」的**地址**），而 `put` 根本不存在（130 处全是 not a function）。
     *  2. 变量必须能**跨求值**：搜索地址的脚本先存，后面的字段规则再读回来 ——
     *     这正是 `SandboxSession.vars` 存在的理由。
     *
     * 还有一条边界：**没实现的成员要报出名字**，而不是让 QuickJS 说一句
     * `TypeError: not a function`（它不说哪一个，几十行的脚本里根本定位不到）。
     */
    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '变量表与报错测试源',
                bookSourceUrl: BASE,
                // 这一步与下面的字段规则是**两次求值**：跨求值没生效的话，author 会是空串
                searchUrl: `@js:java.put('谁', '甲'); java.put('页码', String(page)); '${BASE}/fixture/search?q=' + encodeURIComponent(key) + '&p=' + page`,
                ruleSearch: {
                    bookList: '@css:div.result-item',
                    name: '@css:h3.title@text',
                    bookUrl: '@css:h3.title a@href',
                    author: `@js:java.get('谁') + '/' + java.get('页码')`,
                    // 一参 get 读变量；没存过的变量给空串，**不是**去请求一个叫这个名字的地址
                    kind: `@js:java.get('没存过的') === '' ? 'EMPTY-OK' : 'EMPTY-BAD'`,
                    // 二参 get 仍然是取网（用真能搜到书的词，否则断言自己会假红）
                    lastChapter: `@js:java.get('${BASE}/fixture/api/search?q=' + encodeURIComponent('测试') + '&p=1', {}).indexOf('测试小说') >= 0 ? 'HTTP-OK' : 'HTTP-BAD'`,
                    // 未实现的能力报出名字
                    intro: `@js:(function(){try{java.androidId();return 'NO-ERROR'}catch(e){return String(e.message || e)}})()`,
                },
            },
        ]),
    )

    const search = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const per = search.json?.sources?.[0]
    const authors = (per?.books ?? []).map((b) => b.author)
    check(
        authors.length === 2 && authors.every((a) => a === '甲/1'),
        '`java.put` 存的值能被**另一次求值**的规则读到（搜索脚本先存、字段规则后读）',
        JSON.stringify(authors),
    )
    check(
        (per?.books ?? []).every((b) => b.kind === 'EMPTY-OK'),
        '一参 `java.get(名字)` 读变量：没存过给空串，而不是去请求一个同名地址',
        JSON.stringify((per?.books ?? []).map((b) => b.kind)),
    )
    check(
        (per?.books ?? []).every((b) => b.lastChapter === 'HTTP-OK'),
        '二参 `java.get(url, headers)` 仍然是取网',
        JSON.stringify((per?.books ?? []).map((b) => b.lastChapter)),
    )
    check(
        (per?.books ?? []).every((b) => String(b.intro ?? '').includes('androidId')),
        '未实现的 `java.*` 报出**名字**（而不是「not a function」）',
        JSON.stringify((per?.books ?? [])[0]?.intro ?? ''),
    )

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
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

console.log('\n=== 18. URL 字段里的 JS（searchUrl 的 @js: / <js>） ===')
{
    /**
     * 顶层 URL 字段（`searchUrl`）里可以直接写 JS。线上 816 条源里 `searchUrl`
     * 带 JS 的有 85 条，三种写法都要认（`@js:` 整条 64、`<js>` 整条 17、
     * 「前缀 + `@js:`」4）。认不出来时的表现是**照字面去请求**
     * —— 得到一个 404/403，或者更糟：一个能返回 200 但内容全错的地址。
     *
     * 这里还专门钉住两件容易写反的顺序：
     *   - 请求选项要在**脚本跑完之后**再拆（脚本自己会写 `,{...}`）
     *   - 脚本的 `result` 是**没展开过 `{{}}` 的原文**，展开要放在脚本之后
     */
    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    const base = `${BASE}/fixture/api/search?q={{key}}&p={{page}}`

    // ---- 1. 整条 @js:，且脚本自己拼请求选项 ----
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: 'URL JS 整条测试源',
                bookSourceUrl: BASE,
                searchUrl: `@js:'${base}' + ',{"method":"GET","headers":{"X-Probe":"url-js"}}'`,
                ruleSearch: {
                    bookList: '$.data.list',
                    name: '{{$.name}}',
                    author: '{{$.author}}',
                    bookUrl: '/fixture/book/{{$.id}}',
                },
                ruleToc: {},
                ruleContent: {},
            },
        ]),
    )
    let res = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    let per = res.json?.sources?.[0]
    check(
        (per?.books ?? []).length === 2,
        '整条 @js: 的 searchUrl：脚本跑完、{{key}} 在脚本之后展开、选项在脚本之后拆',
        per?.error ?? `count=${(per?.books ?? []).length}`,
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // ---- 2. 整条 <js> 块 ----
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: 'URL JS 块测试源',
                bookSourceUrl: BASE,
                searchUrl: `<js>\nvar u = '${base}';\nu;\n</js>`,
                ruleSearch: {
                    bookList: '$.data.list',
                    name: '{{$.name}}',
                    bookUrl: '/fixture/book/{{$.id}}',
                },
                ruleToc: {},
                ruleContent: {},
            },
        ]),
    )
    res = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    per = res.json?.sources?.[0]
    check(
        (per?.books ?? []).length === 2,
        '整条 <js> 块的 searchUrl：脚本的收尾表达式就是地址',
        per?.error ?? `count=${(per?.books ?? []).length}`,
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // ---- 3. 「地址 + 请求选项」再跟 @js:：result 是前面那段原文 ----
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: 'URL JS 前缀测试源',
                bookSourceUrl: BASE,
                // 脚本自己先验证 result 的形状：既要带请求选项、又要是没展开的 {{key}}。
                // 形状不对就直接返回一个必然请求失败的地址，好让断言红掉。
                searchUrl: `${base},{"charset":"auto"}\n@js:result.indexOf(',{"charset":"auto"}') > 0 && result.indexOf('{{key}}') > 0 ? result.split(',{')[0] + '&probe=ok' : '${BASE}/fixture/api/broken?got=' + encodeURIComponent(result)`,
                ruleSearch: {
                    bookList: '$.data.list',
                    name: '{{$.name}}',
                    bookUrl: '/fixture/book/{{$.id}}',
                },
                ruleToc: {},
                ruleContent: {},
            },
        ]),
    )
    res = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    per = res.json?.sources?.[0]
    check(
        (per?.books ?? []).length === 2,
        '「地址 + 选项」+ @js: 时，result 是那段原文（含选项、含未展开的 {{key}}），且不会被当成前缀拼回去',
        per?.error ?? `count=${(per?.books ?? []).length}`,
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // ---- 4. 脚本能自己发请求（URL 字段里的 java.ajax 必须可用） ----
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: 'URL JS 取网测试源',
                bookSourceUrl: BASE,
                // 真实书源就是这么干的：先抓一次页面、看内容决定最终地址。
                // 取网能力没注入的话会报「java.ajax 不可用」—— 与书源无关的错。
                //
                // 注意这里取网用的是**不带 `{{}}` 的地址**：沙箱里的 java.ajax 走的是
                // `planFromResolvedUrl`，刻意不做模板展开（否则模板求值要进沙箱，
                // 而沙箱里的取网又回头进模板，绕成递归）。返回的地址仍然用 `{{key}}`，
                // 顺带证明「展开发生在脚本之后」。
                searchUrl: `@js:var body = java.ajax('${BASE}/fixture/api/search?q=' + encodeURIComponent('测试') + '&p=1'); body.indexOf('测试小说') >= 0 ? '${base}' : '${BASE}/fixture/api/nowhere'`,
                ruleSearch: {
                    bookList: '$.data.list',
                    name: '{{$.name}}',
                    bookUrl: '/fixture/book/{{$.id}}',
                },
                ruleToc: {},
                ruleContent: {},
            },
        ]),
    )
    res = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    per = res.json?.sources?.[0]
    check(
        (per?.books ?? []).length === 2,
        'URL 字段里的脚本能用 java.ajax（取网能力必须注入进去）',
        per?.error ?? `count=${(per?.books ?? []).length}`,
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // ---- 5. 脚本出错要显式失败，不能静默变成「搜不到书」 ----
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: 'URL JS 报错测试源',
                bookSourceUrl: BASE,
                searchUrl: `@js:throw new Error('url-js-boom')`,
                ruleSearch: { bookList: '$.data.list', name: '{{$.name}}' },
                ruleToc: {},
                ruleContent: {},
            },
        ]),
    )
    res = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    per = res.json?.sources?.[0]
    check(
        per?.ok === false && String(per?.error ?? '').includes('url-js-boom'),
        'URL 字段里的脚本出错时明确报错，而不是静默 0 条',
        JSON.stringify(per?.error ?? per?.books),
    )
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), 'URL JS 测试源已清理')
}

console.log('\n=== 19. 发现（书源探索）与首页推荐 ===')
{
    /**
     * 「发现」走的是 exploreUrl + ruleExplore：「分类列表 → 某个分类的书」。
     * 分类地址里带 `{{page}}`，所以「有没有下一页」既可能来自 nextPageUrl，
     * 也可能来自模板本身 —— 两条路都要验。
     *
     * 这段用内置的发现源（`<js>` 返回分类数组）跑，完全不依赖第三方站点。
     */
    const exploreId = 'builtin:fixture-explore'
    const user = await sessionUser('smokehome')
    check(user.status === 201, '首页/发现测试用的临时账号已注册', `status=${user.status}`)

    // 书源列表要标出「哪些源能探索」，否则前端只能逐个试
    const sources = (await getJson('/api/sources')).json?.sources ?? []
    const exploreSource = sources.find((s) => s.id === exploreId)
    check(
        exploreSource?.hasExplore === true,
        '/api/sources 标出 hasExplore（前端据此筛出可探索的源）',
        JSON.stringify(exploreSource?.hasExplore),
    )
    check(
        sources.some((s) => s.hasExplore === false),
        '不支持探索的源 hasExplore=false',
        `共 ${sources.length} 条`,
    )

    const categories = await getJson(`/api/explore?sourceId=${encodeURIComponent(exploreId)}`)
    const list = categories.json?.categories ?? []
    check(
        categories.status === 200 && list.length === 3,
        '发现页读出 3 个分类（<js> 返回的分类数组）',
        JSON.stringify(list.map((c) => c.title)),
    )
    check(
        list[0]?.url.includes('{{page}}'),
        '分类地址里的 {{page}} 原样带出来，由请求时展开',
        String(list[0]?.url),
    )

    const categoryUrl = encodeURIComponent(list[0]?.url ?? '')
    const page1 = await getJson(
        `/api/explore/books?sourceId=${encodeURIComponent(exploreId)}&url=${categoryUrl}&page=1`,
    )
    const page2 = await getJson(
        `/api/explore/books?sourceId=${encodeURIComponent(exploreId)}&url=${categoryUrl}&page=2`,
    )
    const names1 = (page1.json?.books ?? []).map((b) => b.name)
    const names2 = (page2.json?.books ?? []).map((b) => b.name)
    check(names1.length === 2, '分类第 1 页取到 2 本', JSON.stringify(names1))
    check(
        names1.join() !== names2.join(),
        '第 2 页换了一批书（分页真的生效，不是每页都一样）',
        `${names1.join('/')} vs ${names2.join('/')}`,
    )
    check(
        page1.json?.hasMore === true && page1.json?.nextUrl !== null,
        '第 1 页给出下一页（nextPageUrl 生效）',
        String(page1.json?.nextUrl),
    )
    // 分类地址带 {{page}} 时，分页是由模板表达的，「还有没有」只能靠内容判断：
    // 翻过头的那一页返回 0 条，前端据此停下 —— 断言这个停止信号，而不是 hasMore
    const pageFar = await getJson(
        `/api/explore/books?sourceId=${encodeURIComponent(exploreId)}&url=${categoryUrl}&page=9`,
    )
    check(
        (pageFar.json?.books ?? []).length === 0,
        '翻过头的那一页返回 0 条（模板分页的停止信号）',
        `count=${(pageFar.json?.books ?? []).length}`,
    )

    // 既没有 {{page}} 也没有 nextPageUrl 的分类：取完就是完，必须明确说「没有更多」
    const single = await getJson(
        `/api/explore/books?sourceId=${encodeURIComponent(exploreId)}&url=${encodeURIComponent('/fixture/explore/single')}&page=1`,
    )
    check(
        (single.json?.books ?? []).length === 2 && single.json?.hasMore === false,
        '既没有 {{page}} 也没有 nextPageUrl 的分类：取完就停（hasMore=false）',
        `count=${(single.json?.books ?? []).length} hasMore=${JSON.stringify(single.json?.hasMore)}`,
    )
    check(
        (page1.json?.books ?? []).every((b) => b.bookUrl.startsWith(BASE)),
        '分类里的相对地址按书源地址补全',
        String(page1.json?.books?.[0]?.bookUrl),
    )

    // 没配发现页的源要明确报错，而不是回一个空分类列表让人以为「这个源没内容」
    const noExplore = await getJson('/api/explore?sourceId=builtin%3Afixture-css')
    check(
        noExplore.status === 502 && String(noExplore.json?.error ?? '').includes('exploreUrl'),
        '没有 exploreUrl 的源给出明确报错（502 且说明缺什么）',
        `status=${noExplore.status} ${noExplore.json?.error ?? ''}`,
    )

    // ---- 首页 ----
    const home = await user.call('GET', '/api/home')
    const sections = home.json?.sections ?? []
    check(
        home.status === 200 && sections.length >= 1,
        '首页推荐位至少有一个栏目（来自发现页的第一个分类）',
        `sections=${sections.length} failures=${JSON.stringify(home.json?.failures ?? []).slice(0, 80)}`,
    )
    check(
        (sections[0]?.books ?? []).length > 0,
        '推荐位里有书',
        `${sections[0]?.sourceName} / ${sections[0]?.category}：${(sections[0]?.books ?? []).length} 本`,
    )
    check(
        (home.json?.continueReading ?? []).length === 0,
        '新账号的「继续阅读」是空的',
        `count=${(home.json?.continueReading ?? []).length}`,
    )

    const bookUrl = `${BASE}/fixture/book/1`
    await user.call('POST', '/api/shelf', {
        sourceId: 'builtin:fixture-css',
        bookUrl,
        name: '测试小说·甲',
        author: '作者甲',
    })
    await user.call('PUT', '/api/progress', {
        sourceId: 'builtin:fixture-css',
        bookUrl,
        chapterUrl: `${BASE}/fixture/chapter/1/2`,
        chapterName: '第二章',
        chapterIndex: 1,
        pageIndex: 4,
    })

    const home2 = await user.call('GET', '/api/home')
    const reading = home2.json?.continueReading ?? []
    check(
        reading.length === 1 && reading[0]?.chapterUrl === `${BASE}/fixture/chapter/1/2`,
        '读过之后出现在「继续阅读」里，且带出章节地址（首页不用再查一次目录）',
        JSON.stringify(reading[0]?.chapterName),
    )
    check(
        reading[0]?.pageIndex === 4,
        '翻页位置一起带出来（翻页模式能接着上次那一页读）',
        JSON.stringify(reading[0]?.pageIndex),
    )

    // 推荐位带缓存：第二次应当命中缓存（builtAt 不变），refresh=1 才重建
    const cached = await user.call('GET', '/api/home')
    check(
        cached.json?.builtAt === home2.json?.builtAt,
        '推荐位走缓存（第二次请求不重建）',
        `${cached.json?.builtAt}`,
    )

    await user.call('POST', '/api/auth/logout', {})
}

console.log('\n=== 20. 节点级助手与对称加解密（java.getElements / createSymmetricCrypto） ===')
{
    /**
     * 这一节验的是**整条链路**：QuickJS 里的 `java.*` → 宿主桥 → 宿主实现。
     * 单测覆盖的是宿主那一侧（算法本身、jsoup 桥的契约）；这里覆盖的是「接上了没有」——
     * 字节数组有没有被当成字符串、hex 是哪种大小写、iv 有没有真的传过去，
     * 都只有走一遍沙箱才看得出来。
     *
     * 加解密那两条用的期望值是**公开的已知答案向量**（FIPS-197 与 DES 的经典样例），
     * 不是本项目自己算出来的：桥的形状只要错一点就对不上。
     */
    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '节点级助手测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/search?q={{key}}`,
                ruleSearch: {
                    bookList: '@css:div.result-item',
                    name: '@css:h3.title@text',
                    author: '@css:span.author@text',
                    bookUrl: '@css:h3.title a@href',
                    // 节点级求值 + Elements 的形状（size / toArray / text 各走一遍）。
                    // 一条规则里只调一次 java.getElements：它是 asyncify 桥，调两次也能跑，
                    // 但没必要让这条断言同时承担两件事
                    kind: "@js:var els = java.getElements('@css:p.intro'); els.size() + '$' + els.toArray()[0].text()",
                    // getElement 是单数那个（线上 9 处），返回 Element 而不是 Elements
                    lastChapter: "@js:java.getElement('@css:h3.title a').text()",
                    // Elements 上的 .html() 给的是**第一个**节点的内部 HTML
                    wordCount: "@js:java.getElements('@css:p.intro').html()",
                },
                ruleBookInfo: {
                    name: '@css:h1.book-name@text',
                    tocUrl: '@css:a.toc-link@href',
                    // 多节点：`.book-info` 下的 4 个孩子，顺带验 tagName()
                    intro: "@js:var els = java.getElements('@css:.book-info *'); els.size() + '$' + els.toArray().map(function (e) { return e.tagName() }).join(',')",
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
    check(books.length === 2, '节点级助手源搜到 2 本书', per?.error ?? `count=${books.length}`)

    if (books.length > 0) {
        const book = books[0]
        check(
            /^1\$.+/.test(String(book.kind)),
            'java.getElements 拿到节点集（size 与 toArray()[0].text() 都对）',
            String(book.kind),
        )
        check(
            book.lastChapter === String(book.name),
            'java.getElement(...).text() 取到单节点文本',
            JSON.stringify({ element: book.lastChapter, name: book.name }),
        )
        check(
            typeof book.wordCount === 'string' && book.wordCount.length > 0,
            'java.getElements(...).html() 取到第一个节点的内部 HTML',
            String(book.wordCount),
        )
    }

    // ---- 书详情页上的多节点求值 ----
    if (books.length > 0) {
        const info = await getJson(
            `/api/book?sourceId=${encodeURIComponent(id)}&url=${encodeURIComponent(books[0].bookUrl)}`,
        )
        check(
            info.json?.intro === '4$h1,span,div,a',
            'java.getElements 在书详情页拿到 4 个并列节点（顺序与 tagName 都对）',
            JSON.stringify(info.json?.intro),
        )
    }

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    // ------------------------------------------------------------ 对称加解密
    //
    // 两个向量都来自公开的标准文档：
    //   - AES：FIPS-197 / NIST SP 800-38A 的 AES-128-CBC 第一块
    //   - DES：经典样例 key=0x0123456789abcdef、明文 "Now is t"
    // 注意密钥与明文都是**字节**，所以用 base64DecodeToByteArray 取原样字节 ——
    // 直接把 "0123456789abcdef" 当字符串传会得到 16 字节，DES 会以「密钥必须是 8 字节」拒绝，
    // 这本身就是一条要守住的边界。
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '对称加解密测试源',
                bookSourceUrl: BASE,
                searchUrl: `${BASE}/fixture/search?q={{key}}`,
                ruleSearch: {
                    bookList: '@css:div.result-item',
                    // AES-128-CBC（NoPadding）加密成十六进制
                    name: "@js:var key = java.base64DecodeToByteArray('K34VFiiu0qar9xWICc9PPA=='); var iv = java.base64DecodeToByteArray('AAECAwQFBgcICQoLDA0ODw=='); var data = java.base64DecodeToByteArray('a8G+4i5An5bpPX4Rc5MXKg=='); java.createSymmetricCrypto('AES/CBC/NoPadding', key, iv).encryptHex(data)",
                    bookUrl: '@css:h3.title a@href',
                    // DES-ECB（NoPadding）：公开样例 → 3fa40e8a984d4815
                    author: "@js:var key = java.base64DecodeToByteArray('ASNFZ4mrze8='); var data = java.base64DecodeToByteArray('Tm93IGlzIHQ='); java.createSymmetricCrypto('DES/ECB/NoPadding', key).encryptHex(data)",
                    // 中文正文的加密再解密（base64ToString 那一对方法）
                    kind: "@js:var c = java.createSymmetricCrypto('AES/CBC/PKCS5Padding', 'Pxga!h*e4@T8xfOm', 'E&z!EHGLd$fli*8R'); var enc = c.encryptBase64ToString('要解出来的正文'); enc.length > 0 && c.decryptBase64ToString(enc) === '要解出来的正文' ? 'roundtrip-ok' : 'roundtrip-bad'",
                    // 字符串形式的 8 字节密钥（线上真实写法）
                    lastChapter:
                        "@js:var c = java.createSymmetricCrypto('DES/CBC/PKCS5Padding', 'KW8Dvm2N', '1ae2c94b'); var enc = c.encryptBase64ToString('正文'); c.decryptBase64ToString(enc)",
                    // aesBase64DecodeToString 是线上出现最多的那一个（18 处）
                    wordCount:
                        "@js:var c = java.createSymmetricCrypto('AES/CBC/PKCS5Padding', 'Pxga!h*e4@T8xfOm', 'E&z!EHGLd$fli*8R'); var enc = c.encryptBase64ToString('另一个片段'); java.aesBase64DecodeToString(enc, 'Pxga!h*e4@T8xfOm', 'AES/CBC/PKCS5Padding', 'E&z!EHGLd$fli*8R')",
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

    const cryptoRes = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const cryptoPer = cryptoRes.json?.sources?.[0]
    const cryptoBooks = cryptoPer?.books ?? []
    check(
        cryptoBooks.length === 2,
        '对称加解密源搜到 2 本书',
        cryptoPer?.error ?? `count=${cryptoBooks.length}`,
    )

    if (cryptoBooks.length > 0) {
        const book = cryptoBooks[0]
        check(
            book.name === '7649abac8119b246cee98e9b12e9197d',
            'AES-128-CBC 在沙箱里加密出官方向量（NIST SP 800-38A）',
            String(book.name),
        )
        check(
            book.author === '3fa40e8a984d4815',
            'DES-ECB 在沙箱里加密出经典样例（0x0123456789abcdef → 3fa40e8a984d4815）',
            String(book.author),
        )
        check(
            book.kind === 'roundtrip-ok',
            'AES 的 encryptBase64ToString / decryptBase64ToString 往返一致（含中文）',
            String(book.kind),
        )
        check(
            book.lastChapter === '正文',
            'DES/CBC/PKCS5Padding 用 8 字节字符串密钥往返一致',
            String(book.lastChapter),
        )
        check(
            book.wordCount === '另一个片段',
            'java.aesBase64DecodeToString 的参数顺序与 Legado 一致',
            String(book.wordCount),
        )
    }

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    /**
     * 错误路径：一条一条单独验
     *
     * 「某个字段的规则抛错」在这个引擎里的表现是**整个源**失败（`ok:false` + `error`），
     * 而不是那一格留空 —— 所以每条必然抛错的规则都得单独开一个源，
     * 否则它会把同一个源里其它字段的断言一起带走（这不是缺陷，是刻意的：
     * 书源报错与「搜不到书」必须能分开看）。
     */
    const expectSourceError = async (name, rules, expected, label) => {
        await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
        await call(
            'POST',
            '/api/sources',
            JSON.stringify([
                {
                    bookSourceName: name,
                    bookSourceUrl: BASE,
                    searchUrl: `${BASE}/fixture/search?q={{key}}`,
                    ruleSearch: {
                        bookList: '@css:div.result-item',
                        name: '@css:h3.title@text',
                        bookUrl: '@css:h3.title a@href',
                        ...rules,
                    },
                    ruleToc: {},
                    ruleContent: {},
                },
            ]),
        )
        const res = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
        const per = res.json?.sources?.[0]
        check(
            per?.ok === false && String(per?.error ?? '').includes(expected),
            label,
            JSON.stringify(per?.error),
        )
        await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    }

    // 16 字节的 key 给 DES：必须明确说长度不对，不能拿前 8 个字节凑合
    await expectSourceError(
        '密钥长度错误测试源',
        {
            author: "@js:java.createSymmetricCrypto('DES/CBC/PKCS5Padding', '0123456789abcdef', '1ae2c94b').encryptHex('x')",
        },
        'DES 密钥必须是 8 字节',
        'DES 密钥长度不对时报清楚（而不是静默取前 8 字节）',
    )

    // 没实现的算法必须明确报错，而不是给一段乱码
    await expectSourceError(
        '未实现算法测试源',
        {
            author: "@js:java.createSymmetricCrypto('DESede/CBC/PKCS5Padding', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbb').encryptHex('a')",
        },
        '不支持 DESEDE',
        '没实现的算法报出名字，而不是给一段乱码',
    )

    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === id), '节点级与加解密测试源已清理')
}

console.log('\n=== 21. 连接式取网（java.connect）与 result.toArray() ===')
{
    /**
     * 两条都是「线上在用、本引擎只会说 `TypeError: not a function`」的老账：
     *
     *   1. `java.connect(url)` 返回的是 Legado 的 `StrResponse` —— 脚本用
     *      `res.code()` / `res.body()` / `res.url()` / `res.raw().request().url()` /
     *      `res.raw().headers(name)` 取东西。22 个源在用，其中 9 个把
     *      `.raw().request().url()` 写进 `searchUrl` 模板（📂八一中文 / ⚡📂三五中文 /
     *      ⚡📂香书小说 / 📂福书小说 …）。
     *   2. `result.toArray()`（jsoup 的 `Elements.toArray()`）—— 20 个源 28 处在用：
     *      📂文学小说 的 `list = result.toArray()` 在 `@js:` 尾巴那条路上，
     *      6 条「海马书屋」形状的目录规则在 `<js>` 块那条路上。
     *
     * 这一节两种取网形态、两条 `toArray` 路径都走一遍 —— 这些只有进真沙箱才跑得出来。
     */
    const id = `user:${BASE}`
    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([
            {
                bookSourceName: '连接式取网与 toArray 测试源',
                bookSourceUrl: BASE,
                // ⚡📂三五中文 那一批的形状：先 connect 拿到站点地址，再拼出真正的搜索地址。
                // 这一段能跑通，就说明「只取地址、不发请求」这条同步桥接上了。
                // 顺带用 `, {` 那个写法（逗号后带空白，407 处 / 31 个源这么写）——
                // 认不出来的话整段选项会被当成 URL 的一部分，请求到一个不存在的页面
                searchUrl: `{{java.connect(source.getKey()).raw().request().url()}}fixture/search?q={{key}}&p={{page}}, { "method": "GET" }`,
                ruleSearch: {
                    bookList: '@css:div.result-item',
                    name: '@css:h3.title@text',
                    bookUrl: '@css:h3.title a@href',
                    // 📂文学小说 的形状（`@js:` 尾巴那条路）
                    author: "@css:h3.title a@js:result.toArray().length + '篇'",
                    // 6 条「海马书屋」形状（`<js>` 块那条路）：块里的 result 必须是**节点**
                    kind: "@css:h3.title a<js>list = result.toArray(); result = 'BLK-' + list.length + '-' + String(list[0].attr('href'))</js>",
                    // StrResponse 的各个形状：url / raw().request().url() / code / body / headers
                    // 其中 body() 连调两次必须**一模一样** —— 测试站点的正文带随机串，
                    // 发两次请求会得到两个不同的串（这就是「同一个响应只发一次」的判据）
                    lastChapter:
                        "@js:(function(){var r = java.connect('" +
                        BASE +
                        "/fixture/connect');var u = r.url(),u2 = r.raw().request().url(),c = r.code(),b1 = r.body(),b2 = r.body(),h = r.raw().headers('Set-Cookie');return [u === u2, c, b1 === b2, (h && h.length) ? h[0] : 'NONE', r.isSuccessful()].join('|')})()",
                    // 非 2xx **不能抛错**：📂天籁小说 整条 searchUrl 就是靠 code()==403 判断换 cookie
                    wordCount:
                        "@js:(function(){var r = java.connect('" +
                        BASE +
                        "/fixture/connect?status=403');return r.code() + '|' + (String(r.body()).indexOf('connect-error-403') >= 0 ? 'ERRBODY' : 'WRONG')})()",
                    // 三件事一起验（都放在 intro 这个**纯文本**字段上 —— coverUrl 会被当相对地址解析）：
                    //   1. `source.getKey()` 必须是**书源地址**（122 个源、206 处都这么用）
                    //   2. `java.get(url, h)` 的返回值当**字符串**用（JSON.parse）
                    //   3. `java.get` / `java.post` 的返回值带**响应方法**（statusCode / code）
                    intro:
                        '@js:(function(){' +
                        "var j = java.get('" +
                        BASE +
                        "/fixture/api/search?q=%E6%B5%8B%E8%AF%95&p=1', {});" +
                        "var p = java.post('" +
                        BASE +
                        "/fixture/search-post', 'q=%E6%B5%8B%E8%AF%95');" +
                        "var e = java.get('" +
                        BASE +
                        "/fixture/connect?status=403', {});" +
                        "return ['KEY-' + (source.getKey() === '" +
                        BASE +
                        "' ? 'OK' : 'BAD')," +
                        ' JSON.parse(j).data.list.length,' +
                        " String(p).indexOf('result-item') >= 0 ? 'P' + p.code() : 'P-BAD'," +
                        " e.statusCode(), String(e.isSuccessful())].join('|')})()",
                },
            },
        ]),
    )

    const search = await call('POST', '/api/search', { keyword: '测试', sourceIds: [id] })
    const per = search.json?.sources?.[0]
    const books = per?.books ?? []
    // 模板里那条 `java.connect(...).raw().request().url()` 拼出来的地址必须真能搜到书
    check(
        books.length === 2,
        '把 `java.connect(...).raw().request().url()` 写进 searchUrl 能搜到书',
        per?.error ?? `count=${books.length}`,
    )

    const kinds = books.map((b) => String(b.kind ?? ''))
    // 每本书取到的是**它自己**那条链接，所以这里断的是形状而不是固定值
    check(
        kinds.length === 2 && kinds.every((k) => /^BLK-1-\/fixture\/book\/\d+$/.test(k)),
        '`<js>` 块里 `result.toArray()` 拿到节点、`list[0].attr(...)` 取到地址',
        JSON.stringify(kinds),
    )
    const authors = books.map((b) => String(b.author ?? ''))
    check(
        authors.every((a) => a === '1篇'),
        '`@js:` 尾巴里 `result.toArray()` 同样可用（📂文学小说 的形状）',
        JSON.stringify(authors),
    )

    const last = books.map((b) => String(b.lastChapter ?? ''))
    check(
        last.length > 0 &&
            last.every((v) => v.startsWith('true|200|true|rc_connect=fake; Path=/|true')),
        '`url()`/`raw().request().url()`/`code()`/`isSuccessful()` 与响应头都对，且同一个响应只发一次请求',
        JSON.stringify(last[0] ?? ''),
    )
    const words = books.map((b) => String(b.wordCount ?? ''))
    check(
        words.length > 0 && words.every((v) => v === '403|ERRBODY'),
        'HTTP 403 时 `java.connect` **不抛错**，`code()` 给 403、`body()` 给错误页',
        JSON.stringify(words),
    )
    const intros = books.map((b) => String(b.intro ?? ''))
    check(
        intros.length > 0 && intros.every((v) => v === 'KEY-OK|2|P200|403|false'),
        '`source.getKey()` 是书源地址；`java.get`/`java.post` 的返回值既能当字符串（JSON.parse）用，又带 statusCode / code',
        JSON.stringify(intros[0] ?? ''),
    )

    await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
}

console.log('\n=== 22. 书源变量跟着书源走（source.getVariable / setVariable） ===')
{
    /**
     * Legado 的 `source.getVariable()` / `setVariable(整串)` 读写的是**书源自己的
     * `variable` 字段** —— 一张书源自己填的便签（备用域名、线路序号、设备号）。
     * 线上 29 个源 126 处在读、24 个源 76 处在写，其中 24 个是「读配置 → 改配置 → 写回」
     * 的配置型用法。
     *
     * 以前引擎把它和「本次请求的变量表」（`java.put` / `java.get(k)`）混成了一张表：
     * 一次请求内读写是对的，**跨请求不落库** —— 于是那些源每次进来都要重新初始化，
     * 而症状只是「设置好像没保存」，很难往引擎上想。
     *
     * 这一段的断言是**跨请求**的：三次 search 是三个独立的 Worker 请求，
     * 中间那次设置的值必须在第三次还读得到。只测「同一个请求内设了能读」是不够的
     * —— 那正是旧实现也能过的情况。
     */
    // 两个源的 id 由**站点地址**派生（`user:<bookSourceUrl>`），所以 B 得换个地址；
    // 它的搜索地址是绝对的，照样打到测试站点上
    const urlA = BASE
    const urlB = `${BASE}/b`
    const idA = `user:${urlA}`
    const idB = `user:${urlB}`
    for (const id of [idA, idB]) await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)

    /** 搜索 URL 的脚本：**只有**用 `作者甲` 这个关键词时才写变量 */
    const searchUrl =
        `@js:(function(){ if (key === '作者甲') { source.setVariable('PERSIST-OK') } ` +
        `return '${BASE}/fixture/search?q=' + encodeURIComponent(key) + '&p=' + page })()`

    const makeSource = (name, url, urlRule = searchUrl) => ({
        bookSourceName: name,
        bookSourceUrl: url,
        searchUrl: urlRule,
        ruleSearch: {
            bookList: '@css:div.result-item',
            name: '@css:h3.title@text',
            bookUrl: '@css:h3.title a@href',
            // 读的就是书源变量本身
            author: '@js:source.getVariable()',
        },
    })

    await call(
        'POST',
        '/api/sources',
        JSON.stringify([makeSource('变量测试源 A', urlA), makeSource('变量测试源 B', urlB)]),
    )

    const authorOf = async (id, keyword) => {
        const res = await call('POST', '/api/search', { keyword, sourceIds: [id] })
        const per = res.json?.sources?.[0]
        if (!per || per.ok === false) return { books: 0, authors: [], error: per?.error }
        return { books: per.books?.length ?? 0, authors: (per.books ?? []).map((b) => b.author) }
    }

    // ① 还没设置过：起点是**空串**（816 条源里没有一条自带 variable）
    const first = await authorOf(idA, '测试')
    check(
        first.books === 2 && first.authors.every((a) => a === ''),
        '没设置过时 `source.getVariable()` 是空串（而不是变量表的 JSON）',
        JSON.stringify(first.authors),
    )

    // ② 另一个源读到的也是空串 —— 变量挂在**书源**上，不是全局
    const other = await authorOf(idB, '测试')
    check(
        other.books === 2 && other.authors.every((a) => a === ''),
        '另一个书源读不到别人的变量（挂在书源上，不是全局）',
        JSON.stringify(other.authors),
    )

    // ③ 设置：搜索地址的脚本先写，同一个请求里的字段规则立刻读得到
    const set = await authorOf(idA, '作者甲')
    check(
        set.books === 1 && set.authors.every((a) => a === 'PERSIST-OK'),
        '`setVariable` 之后同一个请求里的规则立刻读得到',
        JSON.stringify(set.authors),
    )

    // ④ **换一个请求**再读：这一步才是「落库」的证明
    const again = await authorOf(idA, '测试')
    check(
        again.books === 2 && again.authors.every((a) => a === 'PERSIST-OK'),
        '下一次请求仍然读得到（书源变量真的落库了，不是只活在请求里）',
        JSON.stringify(again.authors),
    )

    // ⑤ 清空也是合法操作：空串要与「没设置过」区分开
    const clearRule =
        `@js:(function(){ source.setVariable(''); ` +
        `return '${BASE}/fixture/search?q=' + encodeURIComponent(key) + '&p=' + page })()`
    await call(
        'POST',
        '/api/sources',
        JSON.stringify([makeSource('变量测试源 A', urlA, clearRule)]),
    )
    const cleared = await authorOf(idA, '测试')
    check(
        cleared.books === 2 && cleared.authors.every((a) => a === ''),
        "`setVariable('')` 能把变量清空（空串不被当成「没动过」）",
        JSON.stringify(cleared.authors),
    )

    for (const id of [idA, idB]) await call('DELETE', `/api/sources?id=${encodeURIComponent(id)}`)
    const left = (await getJson('/api/sources')).json?.sources ?? []
    check(!left.some((s) => s.id === idA || s.id === idB), '书源变量测试源已清理')
}

console.log('\n=== 结果 ===')
if (failures.length === 0) {
    console.log(
        `全部通过：搜索 → 详情 → 目录 → 正文，${succeeded.length} 个书源（CSS / XPath / JS / JSON / @js:result / 字段模板 / 选择器@js:）结果一致，` +
            '图片/音频/文件源各自取回对应形态，媒体代取与签名保护正常',
    )
} else {
    console.log(`失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
}
