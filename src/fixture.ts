/**
 * 内置的测试站点
 *
 * 为什么自己造一个而不是直接拿网上的书源来测
 * ----------------------------------------
 * 两个理由，都不是洁癖：
 *
 *   1. **可回归**。第三方站点会改版、会挂、会在 CI 机房被墙。
 *      拿它做验证，今天绿明天红，却又说不清是引擎坏了还是站点没了。
 *      自建站点是确定的：HTML 结构固定，断言才有意义。
 *   2. **书源本身不该由这个项目分发**。规则引擎是中立的工具，
 *      具体指向哪个站、抓什么内容，是使用者自己决定并自负其责的事
 *      （Legado、any-reader 这些项目也都是这么划线的：软件不带源）。
 *
 * 这个站点在环境变量 ENABLE_FIXTURE=true 时才挂载，默认关闭。
 */

const BOOKS = [
    {
        id: '1',
        name: '测试小说·甲',
        author: '作者甲',
        intro: '这是一本用于验证链路的小说。',
        chapters: [
            { id: '1', name: '第一章 起风了' },
            { id: '2', name: '第二章 雨落下来' },
            { id: '3', name: '第三章 天晴了' },
        ],
    },
    {
        id: '2',
        name: '测试小说·乙',
        author: '作者乙',
        intro: '另一本用于验证链路的小说。',
        chapters: [
            { id: '1', name: '第一章 开端' },
            // 第二章刻意写成长文，见下方 chapterParagraphs
            { id: '2', name: '第二章 长夜' },
        ],
    },
    // 下面三本专供媒体类型验证。搜索页与目录页是通用的，可以照常复用；
    // 只有**正文页**各走各的路径 —— 「正文页长什么样」正是各类型的分水岭。
    //
    // 名字刻意不含「测试」二字：冒烟里好几处用「测试」当关键词断言「搜到 2 本」，
    // 这几本混进去会把那些与媒体无关的断言一起改掉，耦合得没必要。
    {
        id: 'img1',
        name: '多页漫画·丙',
        author: '作者丙',
        intro: '用来验证图片源。',
        chapters: [
            { id: '1', name: '第 1 话' },
            { id: '2', name: '第 2 话' },
        ],
    },
    {
        id: 'aud1',
        name: '有声书·丁',
        author: '作者丁',
        intro: '用来验证音频源。',
        chapters: [{ id: '1', name: '第 1 集' }],
    },
    {
        id: 'file1',
        name: '下载文件·戊',
        author: '作者戊',
        intro: '用来验证文件源。',
        // 文件源没有目录：下载地址挂在详情页上
        chapters: [],
    },
]

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>${body}</body></html>`
}

/**
 * 请求里带没带某一对 cookie（`名字=值`）
 *
 * 只比一对完整的 `k=v`，不解析属性也不比键名 —— 靶子要判的是「这个会话带过来了没有」，
 * 而按键名判会把 `rc55=` 这种空值也算成带上了。
 */
function hasCookie(request: Request, pair: string): boolean {
    return (request.headers.get('cookie') ?? '').split(';').some((part) => part.trim() === pair)
}

export function fixtureSearchPage(keyword: string, pageNo: number, extra = 0): string {
    const hits = BOOKS.filter(
        (b) => keyword === '' || b.name.includes(keyword) || b.author.includes(keyword),
    )
    const items = hits
        .map(
            (b) => `<div class="result-item">
        <h3 class="title"><a href="/fixture/book/${b.id}">${escapeHtml(b.name)}</a></h3>
        <span class="author">${escapeHtml(b.author)}</span>
        <span class="kind">玄幻</span>
        <p class="intro">${escapeHtml(b.intro)}</p>
        <p class="latest">最新：<a href="/fixture/chapter/${b.id}/${b.chapters[b.chapters.length - 1]?.id ?? '1'}">${escapeHtml(b.chapters[b.chapters.length - 1]?.name ?? '')}</a></p>
    </div>`,
        )
        .join('\n')

    /**
     * `?n=` 追加的填充条目（第六十一轮）
     *
     * 给「搜索里逐条字段走沙箱」当靶子：一页里书越多，`@js:` 逐条字段的求值次数越多，
     * 而搜索这一趟的预算只有 6 秒（见 `SEARCH_TIMEOUT_MS`）。名字/作者/简介都带序号，
     * 字段规则逐条判得出对不对（不是只看条数）。
     */
    const filler: string[] = []
    for (let i = 1; i <= extra; i += 1) {
        filler.push(`<div class="result-item">
        <h3 class="title"><a href="/fixture/book/fill${i}">填充书·${i}</a></h3>
        <span class="author">填充作者·${i}</span>
        <span class="kind">玄幻</span>
        <p class="intro">填充简介·${i}</p>
    </div>`)
    }

    const all =
        items === '' ? filler.join('\n') : items + (filler.length ? '\n' + filler.join('\n') : '')

    return page(
        `搜索：${keyword}`,
        `<h1>搜索结果</h1>
<div class="search-meta" data-keyword="${escapeHtml(keyword)}" data-page="${pageNo}">共 ${hits.length + extra} 条</div>
<div class="result-list">
${all}
</div>`,
    )
}

/**
 * **单斜杠 XPath** 的靶子：结构照搬 `⚡📂飘天文学` / `📂飘天文学手机版`
 *
 * 那两家的搜索结果里，条目是 `<div class="hot_sale"><a><img><p>…</p></a></div>`，
 * 而字段规则写的是 `/a/p[1]/text()` / `/a/@href` 这种**单斜杠**路径 ——
 * 意思是「**这一条里的** a」，不是「文档根下的 a」。早先单斜杠没被认成 XPath，
 * 整条规则落到 CSS 上、cheerio 抛「CSS 选择器无效」→ 整条源一本书都搜不到
 * （见 scripts/smoke.mjs §34）。
 *
 * 页面里**故意**在列表外再放一个文档层级的 `<a href="/NOPE">`：若单斜杠被当成
 * 文档级路径，就会先撞上它 —— 用例能因此区分「取到这一条」与「取到整页第一个」。
 */
export function fixtureSlashXPathPage(): string {
    const items = BOOKS.map(
        (b) => `<div class="hot_sale">
    <a href="/fixture/book/${b.id}"><img src="/fixture/media/page-1.png"><p>${escapeHtml(b.name)}</p><p>作 者 ：${escapeHtml(b.author)}</p><p>简介：${escapeHtml(b.intro)}</p></a>
</div>`,
    ).join('\n')

    return page(
        '搜索结果',
        `<a href="/NOPE" id="doc-level"><p>整页第一个 a</p></a>
<div class="hot_sale-list">
${items}
</div>`,
    )
}

/**
 * **防盗链封面**的列表页：条目里的 `<img>` 指向一个「没有 Referer 就 403」的地址
 *
 * 专供 `scripts/smoke.mjs` §35：线上 `📂品书斋` / `🎨楠楠漫画` / `🎨咚漫` 的封面就是
 * 「书源给 `coverUrl` 写了 `,{"headers":{"Referer":…}}`」这一形态 —— 浏览器 `<img>`
 * 直接加载必然 403，必须由 `/api/media` 代取。与 `fixtureSearchPage` 分开写，
 * 免得调这个形状时牵动别的段落。
 */
export function fixtureGuardedCoverPage(): string {
    const items = BOOKS.slice(0, 2)
        .map(
            (b) => `<div class="gc-item">
    <a href="/fixture/book/${b.id}"><img src="/fixture/cover-guarded" alt=""><span class="gc-name">${escapeHtml(b.name)}</span></a>
</div>`,
        )
        .join('\n')

    return page('防盗链封面', `<div class="gc-list">\n${items}\n</div>`)
}

/**
 * **目录写在 `<script>` 里**的靶子：照 `🎨51漫画` 的详情页形状写
 *
 * 那家的目录规则是 `<js>Array.from(java.getElement("script")).filter(…)` ——
 * 先选 `<script>`、再读它的 JSON。而 domhandler 把 `<script>` 的 `type` 记成
 * `'script'`（不是 `'tag'`），桥里按 `type === 'tag'` 过滤的 `isElement`
 * 把它整类丢掉了 → `getElement("script")` 给 `null` → `Array.from(null)` 抛错
 * → **整本书打不开**（第四十九轮修的就是这个）。
 *
 * 页面里同时给一个 `.btn-read`（那条规则取不到脚本时的**兜底**分支用它），
 * 于是冒烟 §37 能同时钉住「脚本取得到」与「兜底也在」。
 */
export function fixtureScriptTocPage(): string {
    const json = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: '目录',
        itemListElement: [
            { '@type': 'ListItem', name: '第一话', url: '/fixture/chapter/1/1' },
            { '@type': 'ListItem', name: '第二话', url: '/fixture/chapter/1/2' },
        ],
    })

    return page(
        '测试漫画',
        `<!-- 目录写在 script 里 -->
<script type="application/ld+json">${json}</script>
<div class="comic-content">
    <h1 class="text-primary">测试漫画</h1>
    <a class="btn-read" href="/fixture/chapter/1/1">开始阅读</a>
</div>`,
    )
}

/**
 * **两个类名**的靶子：`class.A B` 的意思是「这两个类都要有」
 *
 * jsoup 的 `getElementsByClass(名字)` 把参数按空白拆开、要求**每一个**都命中（AND），
 * 所以 `class.tags text-truncate` 等于 CSS 的 `.tags.text-truncate`。
 * 线上这个形状共 **151 处 / 71 源**（`class.comics-card__title text-truncate`、
 * `class.playlist clearfix` 这类「主类 + 工具类」）。以前整段被当成**一个**类名去转义
 * （`.tags\ text-truncate`），cheerio 不报错、**静默返回 0 条**（第五十轮）。
 *
 * 页面刻意给三块：两个类都有的、只有主类的、只有工具类的 —— 于是冒烟 §38 能同时钉住
 * 「命中 1 个」与「不是 OR、也不是后代」。
 */
export function fixtureTwoClassPage(): string {
    const rows: Array<[string, string, string]> = [
        ['comics-card__title text-truncate', '甲', '1'],
        ['comics-card__title', '乙', '2'],
        ['text-truncate', '丙', '3'],
    ]
    const items = rows
        .map(
            ([cls, name, id]) =>
                `<div class="${cls}"><a href="/fixture/book/${id}">${name}</a></div>`,
        )
        .join('\n')

    return page('两个类名', `<div class="list">\n${items}\n</div>`)
}

/**
 * **POST 表单搜索**：专门守住「带请求体必须声明 Content-Type」这一条
 *
 * 真实站点绝大多数是 PHP，而 PHP 只在 `application/x-www-form-urlencoded`（或
 * multipart）下才把请求体填进 `$_POST`；`fetch` 对字符串 body 默认补的是
 * `text/plain;charset=UTF-8`，于是站点收到的是「没有关键字」，返回一个**空结果页** ——
 * 引擎那侧的表现是「搜索成功、0 条、不报错」，用户看到的是「这个源搜不到书」。
 *
 * 这不是推理出来的：`curl -X POST -H 'Content-Type: text/plain' -d 'a=1&b=2'
 * https://httpbin.org/post` 回的是 `"form": {}`，换成表单类型才有 `"form": {...}`。
 * 线上 320 个源（39%）用的是 POST 搜索，其中只有 4 个自己声明了 Content-Type。
 *
 * 所以这个端点**刻意照 PHP 的样子写**：不是表单类型就当作没有参数，返回空列表 ——
 * 而不是宽容地拿原始 body 去解析。少了这个「不宽容」，用例就守不住这个坑。
 */
async function formSearchPage(request: Request): Promise<string> {
    const contentType = (request.headers.get('content-type') ?? '').toLowerCase()
    const isForm = contentType.startsWith('application/x-www-form-urlencoded')

    if (!isForm) {
        // 没收到参数时的样子：页面结构完整、结果列表为空
        return page(
            '搜索：',
            `<h1>搜索结果</h1>
<div class="search-meta" data-keyword="" data-page="1">共 0 条</div>
<div class="result-list">
</div>`,
        )
    }

    const keyword = new URLSearchParams(await request.text()).get('q') ?? ''
    return fixtureSearchPage(keyword, 1)
}

/**
 * 发现页（探索）
 *
 * 每个分类是一页书目：第 1 页底部有「下一页」，翻到最后一页就没有 ——
 * 正好用来验证「有 nextPageUrl 就继续翻、没有就停」。
 * 两个分类的每页条数特意不同（2 与 3），这样「翻到第 2 页有没有换内容」
 * 是能看出来的，不会被「每页都一样」蒙混过去。
 */
export function fixtureExplorePage(category: string, pageNo: number): string {
    const books = BOOKS.filter((b) => b.chapters.length > 0)
    // 三个分类分别对应三种「还有没有下一页」：
    //   hot    每页 2 本、还有后续 → 有「下一页」链接
    //   new    每页 3 本、倒序     → 第 2 页就到底
    //   single 只有一页、没有链接   → nextPageUrl 取不到，靠内容长度判断
    const list =
        category === 'new'
            ? [...books].reverse()
            : category === 'single'
              ? books.slice(0, 2)
              : books
    const perPage = category === 'new' ? 3 : 2
    const start = Math.max(0, (pageNo - 1) * perPage)
    const slice = list.slice(start, start + perPage)

    const items = slice
        .map(
            (b) => `<div class="result-item">
        <h3 class="title"><a href="/fixture/book/${b.id}">${escapeHtml(b.name)}</a></h3>
        <span class="author">${escapeHtml(b.author)}</span>
        <span class="kind">玄幻</span>
    </div>`,
        )
        .join('\n')

    const hasNext = start + perPage < list.length
    const pager = hasNext
        ? `<div class="pager"><a class="next-page" href="/fixture/explore/${encodeURIComponent(category)}?p=${pageNo + 1}">下一页</a></div>`
        : '<div class="pager"></div>'

    return page(
        `发现：${category}`,
        `<h1>发现 · ${escapeHtml(category)}</h1>
<div class="explore-meta" data-category="${escapeHtml(category)}" data-page="${pageNo}">共 ${list.length} 条</div>
<div class="result-list">
${items}
</div>
${pager}`,
    )
}

export function fixtureBookPage(bookId: string): string {
    const book = BOOKS.find((b) => b.id === bookId)
    if (!book) return page('未找到', '<p class="empty">没有这本书</p>')

    // 没有章节的书就是「文件类」：它没有目录，取而代之的是一个下载入口 ——
    // 与真实文件源（bookSourceType=3）的形态一致
    const tail =
        book.chapters.length === 0
            ? `<p class="size">大小：1.2 MB</p>
    <a class="download-link" href="/fixture/media/book.txt">下载地址</a>`
            : `<a class="toc-link" href="/fixture/toc/${book.id}">查看目录</a>`

    return page(
        book.name,
        `<div class="book-info">
    <h1 class="book-name">${escapeHtml(book.name)}</h1>
    <span class="book-author">${escapeHtml(book.author)}</span>
    <div class="book-intro">${escapeHtml(book.intro)}</div>
    ${tail}
</div>`,
    )
}

export function fixtureTocPage(bookId: string): string {
    const book = BOOKS.find((b) => b.id === bookId)
    if (!book) return page('未找到', '<p class="empty">没有这本书</p>')
    const lis = book.chapters
        .map(
            (ch) =>
                `<li><a href="/fixture/chapter/${book.id}/${ch.id}">${escapeHtml(ch.name)}</a></li>`,
        )
        .join('\n')
    return page(
        `${book.name} 目录`,
        `<h1 class="book-name">${escapeHtml(book.name)}</h1>
<ul class="chapter-list">
${lis}
</ul>`,
    )
}

/**
 * **分页目录**，专供验证 `nextTocUrl`
 *
 * 单页目录测不出翻页：真实站点（比如精华书阁 2226 章的书）目录是每页 20 章的多页结构，
 * 只取第一页会让长书只能读开头几十章。这里造一份确定的两页目录。
 *
 * 第 1 页只放第 1 章并给出「下一页」；第 2 页放剩下的章节且不再有下一页。
 * 两页之间靠 `<a>下一页</a>` 串起来，规则写法与真实书源一致（按文字找链接）。
 */
export function fixturePagedTocPage(bookId: string, pageNo: number): string {
    const book = BOOKS.find((b) => b.id === bookId)
    if (!book) return page('未找到', '<p class="empty">没有这本书</p>')

    // 固定切成两页：第 1 页取第 1 章，第 2 页取其余
    const slice = pageNo <= 1 ? book.chapters.slice(0, 1) : book.chapters.slice(1)
    if (slice.length === 0) return page('目录', '<p class="empty">没有更多章节</p>')

    const lis = slice
        .map(
            (ch) =>
                `<li><a href="/fixture/chapter/${book.id}/${ch.id}">${escapeHtml(ch.name)}</a></li>`,
        )
        .join('\n')

    // 第 1 页才有「下一页」
    const nextLink =
        pageNo <= 1
            ? `<div class="pager"><a href="/fixture/paged-toc/${book.id}/2">下一页</a></div>`
            : ''

    return page(
        `${book.name} 分页目录 第 ${pageNo} 页`,
        `<h1 class="book-name">${escapeHtml(book.name)}</h1>
<ul class="chapter-list">
${lis}
</ul>
${nextLink}`,
    )
}

/** 章节正文的段落。HTML 版与 JSON 版共用同一份，避免两处内容漂移导致对照失败 */
function chapterParagraphs(bookName: string, chapterName: string): string[] {
    /**
     * 长文特例：翻页模式唯一的验证素材
     *
     * 其余章节都只有三句话，一屏都占不满 —— 而**只有一页就测不出分页**：
     * 页数永远是 1，翻页位移对不对根本看不出来（这正是「翻页位置不对」被漏掉的原因）。
     * 这一段固定生成足够长的正文，让「一页放不下」成为常态。
     *
     * 内容刻意逐段不同（带上序号），这样「翻到的第 2 页到底是不是接着第 1 页」
     * 一眼能看出来，而不是靠「反正都是同一段字」蒙混过去。
     */
    if (chapterName.includes('长夜')) {
        const paragraph = (n: number) =>
            `第${n}段。${'夜里的风从窗缝里钻进来，带着远处河面的湿气，把桌上的纸页吹得沙沙作响。'.repeat(2)}` +
            `他停下手里的笔，数了数窗外那盏路灯下的影子，这已经是第${n}次了。`
        return Array.from({ length: 60 }, (_, i) => paragraph(i + 1))
    }

    return [
        `这是《${bookName}》${chapterName}的正文第一段。`,
        '第二段用来确认多段落的提取与拼接是否正确。',
        '第三段收尾。',
    ]
}

export function fixtureChapterPage(bookId: string, chapterId: string): string {
    const book = BOOKS.find((b) => b.id === bookId)
    const chapter = book?.chapters.find((c) => c.id === chapterId)
    if (!book || !chapter) return page('未找到', '<p class="empty">没有这一章</p>')

    // 刻意写成多个文本节点，用来验证 @textNodes 会把它们按段落取出来
    const paragraphs = chapterParagraphs(book.name, chapter.name)
        .map((text) => `<p>${escapeHtml(text)}</p>`)
        .join('\n        ')

    return page(
        `${book.name} ${chapter.name}`,
        `<div class="reader">
    <h1 class="chapter-title">${escapeHtml(chapter.name)}</h1>
    <div id="content">
        ${paragraphs}
    </div>
</div>`,
    )
}

/**
 * **`<br>` 版的章节页** —— 模拟笔趣阁那一族「正文 div 里全是 `<br>`」的写法
 *
 * README 第二轮记过这个站点：`#nr1` 的 HTML 有 2821 字符却**一个换行都没有**，
 * 全靠 100 个 `<br>` 分段。这一族的正文规则几乎都写成 `#nr1@html`，
 * 于是取回来的是**原样的 HTML** —— 阅读界面把正文当纯文本渲染，
 * 用户看到的就是字面的 `<p>` / `<br>`，段落还全糊在一起。
 *
 * 这个页面钉住四件事（冒烟里逐条断言）：
 *
 *   1. 标签不能在正文里露出来；
 *   2. 段落数与写进去的一致（`<br>` 真的变成了换行）；
 *   3. 不能有字面的 `<br>`；
 *   4. 挂在 `div` 里的 `<script>` **不能**被读进正文。
 *      （cheerio 的 `.text()` 会把 script 里的字也算进来，线上真有源的正文 div
 *      里挂着 `<script>read_top()</script>`。）
 *
 * 「`↑返回顶部↑` + 净化正则 `##↑返回顶部↑##`」是照线上 `📂梦芳小说`
 * （`id.rtext@html##↑返回顶部↑`）抄的：正则删掉了文字，却留下一具
 * `<a href="javascript:...">` 的空壳 —— 摊平那一步要把它一起带走。
 */
export function fixtureBrChapterPage(bookId: string, chapterId: string): string {
    const book = BOOKS.find((b) => b.id === bookId)
    const chapter = book?.chapters.find((c) => c.id === chapterId)
    if (!book || !chapter) return page('未找到', '<p class="empty">没有这一章</p>')

    // 段落之间**只有 `<br>`**，整段 HTML 一行到底 —— 与线上那个站点一样
    const body = chapterParagraphs(book.name, chapter.name).map(escapeHtml).join('<br>')

    return page(
        `${book.name} ${chapter.name}`,
        `<div class="reader"><h1 class="chapter-title">${escapeHtml(chapter.name)}</h1>` +
            `<div id="nr1"><script>read_top()</script>${body}<br><br>` +
            `<a href="javascript:top()">↑返回顶部↑</a></div></div>`,
    )
}

/**
 * **jsoup 链式调用**版的目录页
 *
 * 模拟的是这一族真实书源（线上 86 条源用 `org.jsoup.Jsoup.parse`，10.5%）：
 *
 *   - 📂少年小说网：`Jsoup.parse(result).select("style").first().data()` ——
 *     把 `<style>` 里的隐藏规则读出来当选择器。以前**桥里根本没有 `data` 这个 op**，
 *     调用在沙箱那一侧就炸成 `TypeError: not a function`。
 *   - 🎨漫画搬运：`Jsoup.parse(k).select("a")[0].attr("href")` ——
 *     `select()` 的结果要能**下标**。以前 `Jsoup.parse()` 给的是裸 `JsoupElements`，
 *     `[0]` 恒为 undefined，接着 `.attr(...)` 就报在 undefined 上。
 *   - `select(...).remove()` —— 站点用它藏起来的那条要被**真删**（第七十三轮之前是空操作）。
 *
 * 页面按真实站点的写法搭：真正的列表容器是普通 class（`div.tocBox`），
 * 而 `<style>` 藏起来的是列表**里面**的一条「最新章」—— 书源读 `data()` 拿到那个选择器、
 * 把它删掉，剩下的才是这一页真正的章节。
 *
 * 两条判据都能数出来：
 *   - `data()` 读不到 → 选择器是空的 → 那条藏起来的条目**删不掉** → 章节数多一条
 *   - `remove()` 是空操作 → 同上（第七十三轮之前就是这个症状）
 */
export function fixtureJsoupTocPage(bookId: string): string {
    const book = BOOKS.find((b) => b.id === bookId)
    if (!book) return page('未找到', '<p class="empty">没有这本书</p>')

    const items = book.chapters
        .map(
            (ch) =>
                `<li><a href="/fixture/chapter/${book.id}/${ch.id}">${escapeHtml(ch.name)}</a></li>`,
        )
        .join('\n        ')

    return page(
        `${book.name} 目录（jsoup 链式）`,
        // 整条 `<style>` 一行写完：书源会把 `{display:none}` 换成逗号、再去掉尾逗号当选择器
        `<style>.chapter-list>li:nth-child(1){display:none}</style>
<div class="tocBox">
    <ul class="chapter-list">
        <li><a href="/fixture/chapter/${book.id}/hidden">第九十九章 藏起来的</a></li>
        ${items}
    </ul>
</div>`,
    )
}

/**
 * **详情页**（跨请求变量版）：前几章藏在 `.book_list` 里，另给一个「全部目录」的链
 *
 * 抄的是 📂少年小说网 的详情页，它的 `ruleBookInfo.tocUrl` 是这么写的：
 *
 *   text.全部目录@href
 *   @js:
 *   java.put("html", java.getString("h2:contains(全部章节目录)+.book_list@html"))
 *   result
 *
 * 也就是：**目录地址**取自「全部目录」那个链接，同时把详情页上那份「全部章节目录」
 * 存进会话变量 `html`。目录那趟请求再 `java.get("html")` 把它拼到自己列表的前面 ——
 * 而**详情与目录是两次请求**，会话变量只活一次请求，这一条只能靠「书的变量」穿过去。
 *
 * 断不出来这一层的话，症状是「目录能出、但开头几十章整段没了」：不报错，
 * 书源也不会走到别的分支（详见 README 第七十三轮）。
 */
export function fixtureCrossVarBookPage(bookId: string): string {
    const book = BOOKS.find((b) => b.id === bookId)
    if (!book) return page('未找到', '<p class="empty">没有这本书</p>')

    const head = book.chapters
        .slice(0, 2)
        .map(
            (ch) =>
                `<li><a href="/fixture/chapter/${book.id}/${ch.id}">${escapeHtml(ch.name)}</a></li>`,
        )
        .join('\n        ')

    return page(
        `${book.name} 详情（跨请求变量）`,
        `<h1>${escapeHtml(book.name)}</h1>
<h2 class="title">《${escapeHtml(book.name)}》全部章节目录</h2>
<div class="book_list">
    <ul class="row">
        ${head}
    </ul>
</div>
<a class="page-link" href="/fixture/cross-toc/${book.id}/1/">全部目录</a>`,
    )
}

/**
 * **目录页**（跨请求变量版）：真正的章节旁边混着一条「藏起来的」条目
 *
 * 与 `fixtureJsoupTocPage` 同一族的写法，但更贴近 📂少年小说网 的真实页面：
 * 站点把「最新章」塞在同一个 `ul` 的开头，再用 `<style>` 里的 `{display:none}`
 * 藏起来；书源的规则读 `data()` 拿到那些选择器、`remove()` 掉它们，
 * 剩下的 `ul.row li a` 才是这一页真正的章节。
 *
 * 那条被藏起来的条目指向一个**不存在的章节**：`remove()` 还是空操作的话，
 * 它就混进目录里，数得出来（多一章）。
 *
 * 地址末尾的 `/1/` 是必需的：📂少年小说网 的目录规则里有
 * `w = result.includes("第1页") || !baseUrl.includes("/1/")`，非第一页才拼前缀 ——
 * 少了这一段，规则会走「不拼」那条分支，跨请求变量就测不到了。
 */
export function fixtureCrossVarTocPage(bookId: string): string {
    const book = BOOKS.find((b) => b.id === bookId)
    if (!book) return page('未找到', '<p class="empty">没有这本书</p>')

    const tail = book.chapters
        .slice(2)
        .map(
            (ch) =>
                `<li><a href="/fixture/chapter/${book.id}/${ch.id}">${escapeHtml(ch.name)}</a></li>`,
        )
        .join('\n        ')

    return page(
        `${book.name} 目录（跨请求变量）`,
        // 整条 `<style>` 一行写完：书源会把 `{display:none}` 换成逗号、再去掉尾逗号当选择器
        `<style>.section-list>li:nth-child(1){display:none}</style>
<ul class="section-list row">
    <li><a href="/fixture/chapter/${book.id}/hidden">第九十九章 藏起来的</a></li>
        ${tail}
</ul>`,
    )
}

/**
 * **目录页：选择器取到几「卷」，脚本按标记分卷并返回对象数组**（第七十四轮）
 *
 * 抄的是 🎨漫画搬运 的形状：它的 `chapterList` 是一句选择器加一段 `@js:`，脚本
 *
 *   - `Array.from(result).filter(n => String(n).includes('<h3'))` 认卷标题
 *   - `Array.from(result).filter(n => String(n).includes('<ul'))` 认每卷的章节块
 *   - 逐个块 `Jsoup.parse(块).select(".muludiv")` 取章节，`list.push({href, text, volume})`
 *
 * 于是后续字段规则写的就是 `text` / `href` / `volume` 这三个**键名**。
 *
 * 这一段同时钉住两件事，缺一个就静默变空：
 *   1. 选择器那一段必须给**HTML**。给它文本的话两个 `filter` 恒为空（`'<h3'` 在纯文本里
 *      永远找不到），脚本于是返回空数组 —— 目录 **0 章且不报错**。
 *   2. 脚本返回的对象数组要能被 `text` / `href` / `volume` 当键读出来
 *      （引擎那边靠 `bareJsonField` 把裸词当 `$.键`）。
 */
export function fixtureMapTocPage(bookId: string): string {
    const book = BOOKS.find((b) => b.id === bookId)
    if (!book) return page('未找到', '<p class="empty">没有这本书</p>')

    // 两卷：第一卷装前两章、第二卷装剩下那一章（BOOKS 里正好三章）
    const blocks = [
        { title: '卷一 起风', chapters: book.chapters.slice(0, 2) },
        { title: '卷二 天晴', chapters: book.chapters.slice(2) },
    ]

    const body = blocks
        .map(
            (block) => `<div class="map-block">
    <h3>${escapeHtml(block.title)}</h3>
    <ul class="muludiv-list">
        ${block.chapters
            .map(
                (ch) =>
                    `<li class="muludiv"><a href="/fixture/chapter/${book.id}/${ch.id}">${escapeHtml(ch.name)}</a></li>`,
            )
            .join('\n        ')}
    </ul>
</div>`,
        )
        .join('\n')

    return page(`${book.name} 目录（脚本返回对象数组）`, body)
}

/**
 * **分页正文**，专供验证 `nextContentUrl`
 *
 * 不少站点把一章切成好几页，每页结尾挂着「本章未完，请点击下一页继续阅读」。
 * 只取第一页的话读到的就是半截内容，而「内容不全」比「报错」更难察觉 ——
 * 页面看起来完全正常，只是少了一半。
 *
 * 两页合起来的内容与 fixtureChapterPage 必须**逐字相同**，这样才能断言
 * 「翻页拼出来的正文 == 单页正文」，而不是只看「有那么几百字」。
 */
export function fixturePagedChapterPage(bookId: string, chapterId: string, pageNo: number): string {
    const book = BOOKS.find((b) => b.id === bookId)
    const chapter = book?.chapters.find((c) => c.id === chapterId)
    if (!book || !chapter) return page('未找到', '<p class="empty">没有这一章</p>')

    const all = chapterParagraphs(book.name, chapter.name)
    // 固定两页：第 1 页前两段，第 2 页最后一段
    const slice = pageNo <= 1 ? all.slice(0, 2) : all.slice(2)
    if (slice.length === 0) return page('正文', '<p class="empty">没有更多内容</p>')

    const paragraphs = slice.map((text) => `<p>${escapeHtml(text)}</p>`).join('\n        ')

    // 与真实站点一致：非最后一页在正文末尾挂「下一页」，并给出一句未完结提示
    const tail =
        pageNo <= 1
            ? `<div class="pager"><a href="/fixture/paged-chapter/${book.id}/${chapter.id}/2">下一页</a></div>
    <p class="hint">本章未完，请点击下一页继续阅读</p>`
            : ''

    // 最后一页模仿真实站点的**陷阱**：它把「下一章」也写成同一个 id（pb_next）。
    // 于是 `nextContentUrl: "id.pb_next@href"` 会跨章抓取，把后面几章的内容拼进当前章 ——
    // 这比「内容不全」更糟，因为读到的根本不是这一章。
    // 正确写法是按文字取：`text.下一页@href`，最后一页那个按钮写的是「下一章」，自然不匹配。
    const nextChapter =
        pageNo <= 1
            ? ''
            : `<div class="pager"><a id="pb_next" href="/fixture/paged-chapter/2/1/1">下一章</a></div>`

    return page(
        `${book.name} ${chapter.name} 第 ${pageNo} 页`,
        `<div class="reader">
    <h1 class="chapter-title">${escapeHtml(chapter.name)}</h1>
    <div id="content">
        ${paragraphs}
    </div>
    ${tail}
    ${nextChapter}
</div>`,
    )
}

/**
 * 章节正文的 JSON 版本
 *
 * 用来模拟「正文不在网页里、要走独立接口再取一次」的站点 —— 真实书源里
 * 这种两段式取数非常常见，也正是书源脚本里 `java.ajax` 的典型用武之地。
 * 内容与 HTML 版共用 chapterParagraphs，保证对照验证时两边必须逐字一致。
 */
export function fixtureChapterJson(bookId: string, chapterId: string): string {
    const book = BOOKS.find((b) => b.id === bookId)
    const chapter = book?.chapters.find((c) => c.id === chapterId)
    if (!book || !chapter) return JSON.stringify({ error: 'not found' })

    return JSON.stringify({
        book: book.name,
        chapter: chapter.name,
        paragraphs: chapterParagraphs(book.name, chapter.name),
    })
}

/**
 * 图片源正文：真地址写在 `data-src` 上，`src` 放一张占位图
 *
 * 这是真实漫画站的标准写法（也是为了省流量），刻意照搬过来：
 * 规则引擎只要分不清这两者，结果就是整章图片全变成同一张空白图，
 * 而且**看起来像加载成功**。分两页还顺带覆盖 nextContentUrl。
 */
export function fixtureImageChapterPage(bookId: string, chapterId: string, pageNo: number): string {
    const book = BOOKS.find((b) => b.id === bookId)
    const chapter = book?.chapters.find((c) => c.id === chapterId)
    if (!book || !chapter) return page('未找到', '<p class="empty">没有这一话</p>')

    const pages = pageNo <= 1 ? [1, 2] : [3]
    const imgs = pages
        .map(
            (n) =>
                `<img src="/fixture/media/placeholder.gif" data-src="/fixture/media/page-${n}.png" alt="第 ${n} 页">`,
        )
        .join('\n    ')

    // 第 2 页多挂一个「其实是 HTML 的图片地址」：书源指向什么都有可能，
    // 代取接口必须把非媒体类型降级成附件下载，不能以 text/html 在同源下执行。
    const trap =
        pageNo <= 1
            ? ''
            : `\n    <img src="/fixture/media/placeholder.gif" data-src="/fixture/media/not-really.png" alt="陷阱">`

    const next =
        pageNo <= 1
            ? `<div class="pager"><a href="/fixture/image-chapter/${bookId}/${chapterId}/2">下一页</a></div>`
            : ''

    return page(
        `${book.name} ${chapter.name} 第 ${pageNo} 页`,
        `<div class="comic" id="cp_img">
    ${imgs}${trap}
</div>
${next}`,
    )
}

/** 音频源正文：页面里挂一个 `<audio>`，规则取它的 src —— 旧版 `ruleBookContent: "$id.jp_audio_0@src"` 的等价写法 */
export function fixtureAudioChapterPage(bookId: string, chapterId: string): string {
    const book = BOOKS.find((b) => b.id === bookId)
    const chapter = book?.chapters.find((c) => c.id === chapterId)
    if (!book || !chapter) return page('未找到', '<p class="empty">没有这一集</p>')

    return page(
        `${book.name} ${chapter.name}`,
        `<div class="player">
    <audio id="jp_audio_0" src="/fixture/media/tone.mp3" preload="none"></audio>
    <span class="track-title">${escapeHtml(chapter.name)}</span>
</div>`,
    )
}

function bytesFromBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
}

/** 确定性的伪随机字节，用来当音频内容 —— 是不是合法 mp3 与验证无关，测的是转发链路 */
function pseudoBytes(size: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) % 256
    return bytes
}

const GIF_1PX = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** 测试站点提供的媒体文件。占位图也在其中，好让「误取占位图」能被断言抓到 */
const MEDIA_FILES: Record<string, { type: string; body: Uint8Array<ArrayBuffer> }> = {
    '/fixture/media/tone.mp3': { type: 'audio/mpeg', body: pseudoBytes(4096) },
    '/fixture/media/book.txt': {
        type: 'text/plain; charset=utf-8',
        body: new TextEncoder().encode('这是下载文件的内容。\n第二行。\n'),
    },
    '/fixture/media/placeholder.gif': { type: 'image/gif', body: bytesFromBase64(GIF_1PX) },
    '/fixture/media/page-1.png': { type: 'image/png', body: bytesFromBase64(PNG_1PX) },
    '/fixture/media/page-2.png': { type: 'image/png', body: bytesFromBase64(PNG_1PX) },
    '/fixture/media/page-3.png': { type: 'image/png', body: bytesFromBase64(PNG_1PX) },
    // 名字像图片、内容却是 HTML：用来验证代取接口不会把别人的脚本
    // 以 text/html 在同源下执行（同源脚本能读到 localStorage 里的身份令牌）
    '/fixture/media/not-really.png': {
        type: 'text/html; charset=utf-8',
        body: new TextEncoder().encode('<script>document.title="pwned"</script>'),
    },
}

/**
 * 带 Range 支持地返回一段字节
 *
 * 真实音频 CDN 都支持 Range（拖动进度条要用），所以冒烟必须能验到 206 ——
 * 只测 200 的话，「Range 到底有没有透传」这件事根本没被验证。
 */
function mediaResponse(
    body: Uint8Array<ArrayBuffer>,
    type: string,
    range: string | null,
): Response {
    const total = body.byteLength

    if (!range) {
        return new Response(body, {
            headers: {
                'Content-Type': type,
                'Accept-Ranges': 'bytes',
                'Content-Length': String(total),
            },
        })
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!m) return new Response('bad range', { status: 416 })

    const start = m[1] === '' ? 0 : Number(m[1])
    const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)

    if (start > end || start >= total) {
        return new Response('range not satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${total}` },
        })
    }

    const slice = body.slice(start, end + 1)
    return new Response(slice, {
        status: 206,
        headers: {
            'Content-Type': type,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(slice.byteLength),
        },
    })
}

/**
 * 搜索的 JSON 接口
 *
 * 结构刻意照着真实**接口型**站点做（喜马拉雅、猫耳听书都是这个形状）：
 * 书籍列表藏在一个**数组字段**里（`$.data.list`），条目字段平铺。
 *
 * 这是 JSON 列表规则最容易踩坑的形态，两个坑都会让整个源「搜不到书」且不报错：
 *   1. 列表规则写成 `$.data.list` 时命中的是**整个数组**，不摊平就只有 1 个条目；
 *   2. 条目若沿用整页的 source，按 `$.name` 取字段就等于在整页根节点上取键，必然全空。
 */
export function fixtureSearchJson(keyword: string, pageNo: number): string {
    const hits = BOOKS.filter(
        (b) => keyword === '' || b.name.includes(keyword) || b.author.includes(keyword),
    )
    return JSON.stringify({
        code: 0,
        data: {
            list: hits.map((b) => ({
                id: b.id,
                name: b.name,
                author: b.author,
                kind: '玄幻',
                intro: b.intro,
                url: `/fixture/book/${b.id}`,
            })),
            page: pageNo,
        },
    })
}

/** 路由分派；返回 null 表示不是本站点的路径 */
export async function handleFixture(request: Request, url: URL): Promise<Response | null> {
    const pathname = url.pathname
    if (!pathname.startsWith('/fixture/')) return null

    const html = (body: string) =>
        new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })

    if (pathname === '/fixture/search') {
        return html(
            fixtureSearchPage(
                url.searchParams.get('q') ?? '',
                Number(url.searchParams.get('p') ?? '1'),
                // `?n=` 追加填充条目（第六十一轮）：把「一页几百本书」这种规模量出来
                Math.max(0, Math.min(600, Number(url.searchParams.get('n') ?? '0') || 0)),
            ),
        )
    }

    // POST 表单搜索：照 PHP 的行为写，见 formSearchPage 的说明
    if (pathname === '/fixture/search-post') return html(await formSearchPage(request))

    // 单斜杠 XPath 的靶子（见 fixtureSlashXPathPage 的说明）
    if (pathname === '/fixture/slash-xpath') return html(fixtureSlashXPathPage())

    // 防盗链封面的列表页（见 fixtureGuardedCoverPage 的说明）
    if (pathname === '/fixture/guarded-cover-page') return html(fixtureGuardedCoverPage())

    // 目录写在 <script> 里的靶子（见 fixtureScriptTocPage 的说明）
    if (pathname === '/fixture/script-toc') return html(fixtureScriptTocPage())

    // 两个类名的靶子（见 fixtureTwoClassPage 的说明）
    if (pathname === '/fixture/two-class') return html(fixtureTwoClassPage())

    /**
     * cookie 罐的两个靶子（第五十四轮）
     *
     * `/fixture/cookie-set` 下发一个会话 cookie 并给出**一页书目**（条目照常指向书籍详情页）；
     * `/fixture/cookie-need` 只在请求**带着**这个 cookie 时才回 200，否则 403。
     *
     * 这是站点最常见的那个形态：搜索那一趟拿到会话 cookie，点进详情那一趟必须带上。
     * 在我们这里那是**两次互不相干的 HTTP 请求**，所以这一对靶子同时钉住三件事 ——
     * 收（响应的 Set-Cookie 进罐）、发（下一个请求带 Cookie 头）、**跨请求落库**。
     * 少了第三件，症状是「搜得到书、点进去 403」，而且不报任何错。
     */
    if (pathname === '/fixture/cookie-set') {
        return new Response(fixtureSearchPage('测试', 1), {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Set-Cookie': 'rc54=1; Path=/',
            },
        })
    }
    if (pathname === '/fixture/cookie-need') {
        if (!hasCookie(request, 'rc54=1')) {
            return new Response('需要会话 cookie（rc54）', { status: 403 })
        }
        return html(fixtureBookPage('1'))
    }

    /**
     * 重定向的三个靶子（第五十五轮）
     *
     * `/fixture/redirect-set` 用 **302** 下发 `rc55=1`，并把 `Location` 指向下一页；
     * `/fixture/redirect-land` 只在请求**带着** `rc55=1` 时才回 200（否则 403），
     * 页面是一页书目（条目指向 `/fixture/redirect-need`，同样要 cookie）。
     *
     * 一次搜索就能验三件事，缺一件结论都不成立：
     *   1. **跟了重定向**（拿到的是落地页，不是那句「去下一页」）
     *   2. **302 上那个 `Set-Cookie` 进了罐** —— 第二跳正是带着它才拿到 200 的
     *   3. **`Location` 本身交得回去**（书源那侧 `java.post(...).header('location')`
     *      要的地址就是它；线上 11 个源的 searchUrl 全是这个写法）
     */
    if (pathname === '/fixture/redirect-set') {
        return new Response('去下一页', {
            status: 302,
            headers: { Location: '/fixture/redirect-land', 'Set-Cookie': 'rc55=1; Path=/' },
        })
    }
    if (pathname === '/fixture/redirect-land') {
        if (!hasCookie(request, 'rc55=1')) return new Response('需要 rc55', { status: 403 })
        return html(fixtureSearchPage('测试', 1))
    }
    if (pathname === '/fixture/redirect-need') {
        if (!hasCookie(request, 'rc55=1')) return new Response('需要 rc55', { status: 403 })
        return html(fixtureBookPage('1'))
    }

    /**
     * 登录的两个靶子（第五十七轮）
     *
     * `/fixture/login` 收账号密码、回一个 token（书源脚本拿它 `putLoginHeader`）；
     * `/fixture/need-login` **只在带着那个 token 头时**才回 200（否则 403）。
     *
     * 于是「登录一次、之后每趟请求都带着」这件事能被一次链路完整验出来：
     * 调登录接口 → 落库 → **另一趟请求**（`/api/content`）带上了。
     */
    if (pathname === '/fixture/login') {
        const params = new URLSearchParams(await request.text())
        const user = params.get('username') ?? ''
        const password = params.get('password') ?? ''
        const body =
            user === 'u1' && password === 'p1'
                ? { token: 'TK-RC-1', user }
                : { error: '账号或密码不对' }
        return new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
    }
    if (pathname === '/fixture/need-login') {
        if (request.headers.get('x-rc-token') !== 'TK-RC-1') {
            return new Response('需要登录（X-RC-Token）', { status: 403 })
        }
        return html(fixtureBookPage('1'))
    }

    /**
     * **防盗链封面**本身：没有 `Referer` 就 403
     *
     * 照线上那几家的规矩写，**不宽容**：少了 `Referer` 就是 403。
     * 宽容的话（比如「没 Referer 也放行」）用例就守不住「代取到底有没有真的
     * 把 `Referer` 发出去」——那正是这一段要验的东西（§35）。
     */
    if (pathname === '/fixture/cover-guarded') {
        if ((request.headers.get('referer') ?? '') === '') {
            return new Response('forbidden', { status: 403 })
        }
        const cover = MEDIA_FILES['/fixture/media/page-1.png']!
        return mediaResponse(cover.body, cover.type, null)
    }

    /**
     * `java.connect` 的靶子：一个**能被断言状态码与响应头**的端点
     *
     * 书源拿 connect 的返回值做 `res.code() == 403`、`res.raw().headers('Set-Cookie')`
     * 这类判断，所以这里必须能演一出「非 2xx + 带 Set-Cookie」——
     * 只用 200 的端点，`code()` 与 `headers()` 两条路都测不到。
     */
    if (pathname === '/fixture/connect') {
        const status = Number(url.searchParams.get('status') ?? '200')
        /**
         * 正文里带一个**每次请求都不同**的随机串：这是「同一个响应对象只发一次请求」的判据
         *
         * 光断言 `code()` 与 `body()` 都能取到值，证明不了两者来自同一次请求 ——
         * 发两次请求也同样能过。带上随机串之后，`r.body() === r.body()` 是同一份缓存，
         * 而「请求了两次」会得到两个不同的串。
         */
        const nonce = crypto.randomUUID()
        return new Response(
            status >= 400 ? `connect-error-${status}:${nonce}` : `connect-ok:${nonce}`,
            {
                status,
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Set-Cookie': 'rc_connect=fake; Path=/',
                    'X-Fixture': 'connect',
                },
            },
        )
    }

    /**
     * 把**实际请求到的地址**回显成页面内容
     *
     * `searchUrl` 里那一堆 `{{}}` / `@js:` 拼到最后到底是哪个地址，从外面看不见 ——
     * 而拼错的后果往往只是「搜到 0 条、不报错」。所以给一个能把地址读出来的靶子，
     * 断言就能直接对着**最终地址**下结论，而不是对着「搜到没搜到」猜。
     */
    if (pathname === '/fixture/echo-url') {
        return html(`<html><body><div id="echo">${escapeHtml(url.href)}</div></body></html>`)
    }

    /**
     * 把**这次请求是怎么发的**回显成页面：方法、几个关心的请求头、请求体
     *
     * 书源给一条地址写 `,{"method":"POST","headers":{…},"body":…}` 时，从外面看不见这些
     * 选项有没有真的生效 —— 而失效的后果只是「取回一个别的页面」，不报错。有了这个靶子，
     * 冒烟就能对着「请求本身」下结论（§31 / §32）。
     */
    if (pathname === '/fixture/echo-request') {
        const rawBody = await request.text()
        return html(
            `<html><body>` +
                `<div id="method">${escapeHtml(request.method)}</div>` +
                `<div id="probe">${escapeHtml(request.headers.get('X-RC-Probe') ?? '')}</div>` +
                `<div id="referer">${escapeHtml(request.headers.get('Referer') ?? '')}</div>` +
                `<div id="ctype">${escapeHtml(request.headers.get('content-type') ?? '')}</div>` +
                `<div id="rawbody">${escapeHtml(rawBody)}</div>` +
                `<div id="url">${escapeHtml(url.href)}</div>` +
                `</body></html>`,
        )
    }

    const book = /^\/fixture\/book\/(\w+)$/.exec(pathname)
    if (book) return html(fixtureBookPage(book[1]!))

    /**
     * 书籍详情的 **JSON** 接口，形状照抄真实的接口型源
     *
     * 那几家（⚡📂米读小说 的 `init: $.data`、⚡📂茄子免费小说 的 `$.data.book`）都把书
     * 包在 `{code:0, data:{…}}` 里，而 `ruleBookInfo` 的字段写成**相对** `data` 的路径
     * （`$.title` / `$.author`）—— 这正是 `init`「换根」要解决的那件事。
     * 没有这个靶子，「换根」就只能靠线上源去验，本地冒烟看不见。
     */
    const jsonBook = /^\/fixture\/api\/book\/(\w+)$/.exec(pathname)
    if (jsonBook) {
        const one = BOOKS.find((x) => x.id === jsonBook[1])
        return new Response(
            JSON.stringify({
                code: 0,
                data: one
                    ? {
                          title: one.name,
                          author: one.author,
                          intro: one.intro,
                          cover: `/fixture/cover/${one.id}.jpg`,
                      }
                    : {},
            }),
            { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        )
    }

    const explore = /^\/fixture\/explore\/([\w-]+)$/.exec(pathname)
    if (explore) {
        return html(fixtureExplorePage(explore[1]!, Number(url.searchParams.get('p') ?? '1')))
    }

    const toc = /^\/fixture\/toc\/(\w+)$/.exec(pathname)
    if (toc) return html(fixtureTocPage(toc[1]!))

    // jsoup 链式调用版的目录页（见 fixtureJsoupTocPage 的说明）
    const jsoupToc = /^\/fixture\/jsoup-toc\/(\w+)$/.exec(pathname)
    if (jsoupToc) return html(fixtureJsoupTocPage(jsoupToc[1]!))

    // 跨请求变量版的详情页 / 目录页（见 fixtureCrossVarBookPage 的说明）
    const crossBook = /^\/fixture\/cross-book\/(\w+)$/.exec(pathname)
    if (crossBook) return html(fixtureCrossVarBookPage(crossBook[1]!))

    // 脚本返回对象数组版的目录页（见 fixtureMapTocPage 的说明）
    const mapToc = /^\/fixture\/map-toc\/(\w+)$/.exec(pathname)
    if (mapToc) return html(fixtureMapTocPage(mapToc[1]!))

    // 末尾的 `/1/` 不能省：目录规则靠 `baseUrl.includes("/1/")` 判断「是不是第一页」
    const crossToc = /^\/fixture\/cross-toc\/(\w+)\/(\d+)\/?$/.exec(pathname)
    if (crossToc) return html(fixtureCrossVarTocPage(crossToc[1]!))

    const pagedToc = /^\/fixture\/paged-toc\/(\w+)\/(\d+)$/.exec(pathname)
    if (pagedToc) return html(fixturePagedTocPage(pagedToc[1]!, Number(pagedToc[2])))

    const pagedChapter = /^\/fixture\/paged-chapter\/(\w+)\/(\w+)\/(\d+)$/.exec(pathname)
    if (pagedChapter) {
        return html(
            fixturePagedChapterPage(pagedChapter[1]!, pagedChapter[2]!, Number(pagedChapter[3])),
        )
    }

    const chapter = /^\/fixture\/chapter\/(\w+)\/(\w+)$/.exec(pathname)
    if (chapter) return html(fixtureChapterPage(chapter[1]!, chapter[2]!))

    // `<br>` 版的章节页（见 fixtureBrChapterPage 的说明）
    const brChapter = /^\/fixture\/br-chapter\/(\w+)\/(\w+)$/.exec(pathname)
    if (brChapter) return html(fixtureBrChapterPage(brChapter[1]!, brChapter[2]!))

    const imageChapter = /^\/fixture\/image-chapter\/(\w+)\/(\w+)\/(\d+)$/.exec(pathname)
    if (imageChapter) {
        return html(
            fixtureImageChapterPage(imageChapter[1]!, imageChapter[2]!, Number(imageChapter[3])),
        )
    }

    const audioChapter = /^\/fixture\/audio-chapter\/(\w+)\/(\w+)$/.exec(pathname)
    if (audioChapter) return html(fixtureAudioChapterPage(audioChapter[1]!, audioChapter[2]!))

    // 正文的 JSON 接口：供书源脚本用 java.ajax 二次取数
    const api = /^\/fixture\/api\/chapter\/(\w+)\/(\w+)$/.exec(pathname)
    if (api) {
        return new Response(fixtureChapterJson(api[1]!, api[2]!), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
    }

    // 搜索的 JSON 接口：供 JSONPath 列表规则用
    if (pathname === '/fixture/api/search') {
        return new Response(
            fixtureSearchJson(
                url.searchParams.get('q') ?? '',
                Number(url.searchParams.get('p') ?? '1'),
            ),
            { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        )
    }

    /**
     * 一个「很慢才把正文吐出来」的端点（第六十轮）
     *
     * 给「沙箱里的取网必须跟着这次求值的预算走」那条断言当靶子：书源脚本里一句
     * `java.ajax('/fixture/slow?ms=12000')` 以前会用取网层的默认 20 秒，
     * 于是一次搜索能被拖到 20 秒以上（体检抽到的两个真源就是这么慢的）。
     *
     * 用**流**而不是 `await sleep` 是因为这个处理函数是同步的 —— 而这样也
     * 更贴近真实情形：上游把头也压着不发。
     */
    if (pathname === '/fixture/slow') {
        const ms = Math.max(
            1,
            Math.min(15_000, Number(url.searchParams.get('ms') ?? '1000') || 1000),
        )
        return new Response(
            new ReadableStream({
                start(controller) {
                    setTimeout(() => {
                        controller.enqueue(new TextEncoder().encode('slow-ok'))
                        controller.close()
                    }, ms)
                },
            }),
            { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        )
    }

    /**
     * 目录的 JSON 接口（第五十六轮）：每条带 `isVip` / `isPay` / `isVolume` / `time`
     *
     * 这几个字段是 `ruleToc` 里与 `chapterName` 同层的**逐条规则**，引擎以前整片丢掉。
     * 靶子的形状照着接口型书源写（`chapterList: "$.chapters"`、字段用 `$.名字`）：
     *   第 3 条是**卷标题**（`url` 是空串、`isVolume` 为真）
     *   每 3 条里有一条 `isVip`；其中每 6 条里有一条 `isPay`（已购）
     *   `time` 一律有值，用来验更新时间的展示
     *
     * `?n=` 控制条数 —— 冒烟那边既用它验字段，也用它量「逐条字段要走沙箱时」的代价。
     * 上限从 500 抬到 1600 是第五十九轮的事：那一轮要验「逐条标注的上限 1200」这道边界，
     * 而边界本身在 1200 条上。
     */
    if (pathname === '/fixture/api/toc') {
        const n = Math.max(1, Math.min(1600, Number(url.searchParams.get('n') ?? '5') || 5))
        const chapters: Record<string, unknown>[] = []
        for (let i = 1; i <= n; i++) {
            if (i === 3) {
                chapters.push({ name: `第 ${i} 卷 · 上卷`, url: '', isVolume: true })
                continue
            }
            chapters.push({
                name: `第 ${i} 章`,
                url: `/fixture/chapter/1/${i}`,
                isVip: i % 3 === 0,
                isPay: i % 6 === 0,
                time: `2024-05-1${i % 10}`,
            })
        }
        return new Response(JSON.stringify({ chapters }), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
    }

    const media = MEDIA_FILES[pathname]
    if (media) return mediaResponse(media.body, media.type, request.headers.get('range'))

    return new Response('not found', { status: 404 })
}
