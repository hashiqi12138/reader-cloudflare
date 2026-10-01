/**
 * 端到端冒烟：搜索 → 详情 → 目录 → 正文
 *
 * 需要本地 dev server 已在跑（npm run dev，且 ENABLE_FIXTURE=true）。
 * 它打的是**真实 HTTP**，走完整条链路，因此能抓到单测覆盖不到的问题：
 * 路由没挂上、绑定缺失、asset 与 Worker 的先后顺序不对等等。
 *
 *   npm run dev          # 另开一个终端
 *   node scripts/smoke.mjs
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
const source = sources.json?.sources?.[0]
check(Boolean(source), '至少有一个可用书源', JSON.stringify(sources.json))
if (!source) {
  console.error(
    '\n没有可用书源，后续链路无法继续。是否忘记在 .dev.vars 里设置 ENABLE_FIXTURE=true？',
  )
  process.exit(1)
}

console.log('\n=== 3. 搜索 ===')
const searchResponse = await fetch(`${BASE}/api/search`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ keyword: '测试' }),
})
const searchJson = await searchResponse.json()
check(searchResponse.status === 200, 'POST /api/search 返回 200', `status=${searchResponse.status}`)

const perSource = searchJson.sources?.[0]
check(perSource?.ok === true, '书源搜索未报错', perSource?.error ?? '')
check((perSource?.count ?? 0) > 0, '搜到书籍', `count=${perSource?.count}`)

const book = perSource?.books?.[0]
check(Boolean(book?.name), '书籍有书名', book?.name ?? '')
check(Boolean(book?.author), '书籍有作者', book?.author ?? '')
check(Boolean(book?.bookUrl), '书籍有详情地址', book?.bookUrl ?? '')
if (!book) {
  console.error('\n搜索没有结果，链路到此中断。')
  process.exit(1)
}

console.log('\n=== 4. 详情页 ===')
const info = await getJson(
  `/api/book?sourceId=${encodeURIComponent(source.id)}&url=${encodeURIComponent(book.bookUrl)}`,
)
check(info.status === 200, 'GET /api/book 返回 200', `status=${info.status}`)
check(Boolean(info.json?.tocUrl), '拿到目录地址', info.json?.tocUrl ?? info.json?.error ?? '')

console.log('\n=== 5. 目录 ===')
const toc = await getJson(
  `/api/toc?sourceId=${encodeURIComponent(source.id)}&url=${encodeURIComponent(info.json.tocUrl)}`,
)
check(toc.status === 200, 'GET /api/toc 返回 200', `status=${toc.status}`)
check((toc.json?.chapters?.length ?? 0) > 0, '拿到章节列表', `count=${toc.json?.count}`)

const chapter = toc.json?.chapters?.[0]
if (!chapter) {
  console.error('\n目录为空，链路到此中断。')
  process.exit(1)
}

console.log('\n=== 6. 正文 ===')
const content = await getJson(
  `/api/content?sourceId=${encodeURIComponent(source.id)}&url=${encodeURIComponent(chapter.url)}`,
)
check(content.status === 200, 'GET /api/content 返回 200', `status=${content.status}`)
check((content.json?.length ?? 0) > 0, '正文非空', `length=${content.json?.length}`)
check(
  typeof content.json?.content === 'string' && content.json.content.includes('正文第一段'),
  '@textNodes 提取出了段落',
)
console.log(
  String(content.json?.content ?? '')
    .split('\n')
    .map((line) => '        ' + line)
    .join('\n'),
)

console.log('\n=== 结果 ===')
if (failures.length === 0) {
  console.log('全部通过：搜索 → 详情 → 目录 → 正文 链路已打通')
} else {
  console.log(`失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`)
  process.exitCode = 1
}
