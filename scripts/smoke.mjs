/**
 * 端到端冒烟：搜索 → 详情 → 目录 → 正文
 *
 * 需要本地 dev server 已在跑（npm run dev，且 ENABLE_FIXTURE=true）。
 * 打的是**真实 HTTP**，走完整条链路，因此能抓到单测覆盖不到的问题：
 * 路由没挂上、asset 与 Worker 的先后顺序不对、字符集解码出错等等。
 *
 * 除了逐源跑通，还会**对照两种规则方言**（CSS 与 XPath）在同一个页面上的
 * 提取结果 —— 只测一套的话，另一条路径上的问题会被掩盖。
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

async function getJson(path) {
  const response = await fetch(BASE + path)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 时留给调用方判定 */
  }
  return { status: response.status, json, text }
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
check(list.length >= 2, '至少有两个测试书源（CSS 与 XPath 各一）', `count=${list.length}`)
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

  check(searchResponse.status === 200, `[${label}] 搜索返回 200`, `status=${searchResponse.status}`)
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
  check(chapters.length > 0, `[${label}] 拿到章节列表`, `count=${chapters.length}`)
  if (chapters.length === 0) return null

  const content = await getJson(
    `/api/content?sourceId=${encodeURIComponent(source.id)}&url=${encodeURIComponent(chapters[0].url)}`,
  )
  const text = String(content.json?.content ?? '')
  check(text.length > 0, `[${label}] 正文非空`, `length=${text.length}`)
  check(text.includes('正文第一段'), `[${label}] 正文内容符合预期`)

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

console.log('\n=== 4. 对照两种规则方言 ===')
const css = results['builtin:fixture-css']
const xpath = results['builtin:fixture-xpath']
if (!css || !xpath) {
  check(false, '两个测试源都跑通了（对照的前提）', '至少一个没跑通，跳过对照')
} else {
  check(
    JSON.stringify(css.bookNames) === JSON.stringify(xpath.bookNames),
    'CSS 与 XPath 提取的书名一致',
    JSON.stringify(xpath.bookNames),
  )
  check(
    JSON.stringify(css.authors) === JSON.stringify(xpath.authors),
    'CSS 与 XPath 提取的作者一致',
    JSON.stringify(xpath.authors),
  )
  check(
    JSON.stringify(css.chapterNames) === JSON.stringify(xpath.chapterNames),
    'CSS 与 XPath 提取的章节名一致',
    JSON.stringify(xpath.chapterNames),
  )
  check(css.content === xpath.content, 'CSS 与 XPath 提取的正文逐字一致')
  if (css.content !== xpath.content) {
    console.log('  CSS  :', JSON.stringify(css.content.slice(0, 200)))
    console.log('  XPath:', JSON.stringify(xpath.content.slice(0, 200)))
  }
  console.log('\n  正文预览（任取一套）:')
  console.log(
    css.content
      .split('\n')
      .map((line) => '        ' + line)
      .join('\n'),
  )
}

console.log('\n=== 结果 ===')
if (failures.length === 0) {
  console.log('全部通过：搜索 → 详情 → 目录 → 正文，且 CSS / XPath 两套规则结果一致')
} else {
  console.log(`失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`)
  process.exitCode = 1
}
