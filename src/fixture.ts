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
    chapters: [{ id: '1', name: '第一章 开端' }],
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

export function fixtureBookPage(bookId: string): string {
  const book = BOOKS.find((b) => b.id === bookId)
  if (!book) return page('未找到', '<p class="empty">没有这本书</p>')
  return page(
    book.name,
    `<div class="book-info">
    <h1 class="book-name">${escapeHtml(book.name)}</h1>
    <span class="book-author">${escapeHtml(book.author)}</span>
    <div class="book-intro">${escapeHtml(book.intro)}</div>
    <a class="toc-link" href="/fixture/toc/${book.id}">查看目录</a>
</div>`,
  )
}

export function fixtureTocPage(bookId: string): string {
  const book = BOOKS.find((b) => b.id === bookId)
  if (!book) return page('未找到', '<p class="empty">没有这本书</p>')
  const lis = book.chapters
    .map(
      (ch) => `<li><a href="/fixture/chapter/${book.id}/${ch.id}">${escapeHtml(ch.name)}</a></li>`,
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

export function fixtureChapterPage(bookId: string, chapterId: string): string {
  const book = BOOKS.find((b) => b.id === bookId)
  const chapter = book?.chapters.find((c) => c.id === chapterId)
  if (!book || !chapter) return page('未找到', '<p class="empty">没有这一章</p>')

  // 刻意写成多个文本节点，用来验证 @textNodes 会把它们按段落取出来
  return page(
    `${book.name} ${chapter.name}`,
    `<div class="reader">
    <h1 class="chapter-title">${escapeHtml(chapter.name)}</h1>
    <div id="content">
        <p>这是《${escapeHtml(book.name)}》${escapeHtml(chapter.name)}的正文第一段。</p>
        <p>第二段用来确认多段落的提取与拼接是否正确。</p>
        <p>第三段收尾。</p>
    </div>
</div>`,
  )
}

/** 路由分派；返回 null 表示不是本站点的路径 */
export function handleFixture(pathname: string, url: URL): Response | null {
  if (!pathname.startsWith('/fixture/')) return null

  const html = (body: string) =>
    new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })

  if (pathname === '/fixture/search') {
    return html(
      fixtureSearchPage(url.searchParams.get('q') ?? '', Number(url.searchParams.get('p') ?? '1')),
    )
  }

  const book = /^\/fixture\/book\/(\w+)$/.exec(pathname)
  if (book) return html(fixtureBookPage(book[1]!))

  const toc = /^\/fixture\/toc\/(\w+)$/.exec(pathname)
  if (toc) return html(fixtureTocPage(toc[1]!))

  const chapter = /^\/fixture\/chapter\/(\w+)\/(\w+)$/.exec(pathname)
  if (chapter) return html(fixtureChapterPage(chapter[1]!, chapter[2]!))

  return new Response('not found', { status: 404 })
}
