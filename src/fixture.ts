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

export function fixtureSearchPage(keyword: string, pageNo: number): string {
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

    return page(
        `搜索：${keyword}`,
        `<h1>搜索结果</h1>
<div class="search-meta" data-keyword="${escapeHtml(keyword)}" data-page="${pageNo}">共 ${hits.length} 条</div>
<div class="result-list">
${items}
</div>`,
    )
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
            ),
        )
    }

    // POST 表单搜索：照 PHP 的行为写，见 formSearchPage 的说明
    if (pathname === '/fixture/search-post') return html(await formSearchPage(request))

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

    const media = MEDIA_FILES[pathname]
    if (media) return mediaResponse(media.body, media.type, request.headers.get('range'))

    return new Response('not found', { status: 404 })
}
