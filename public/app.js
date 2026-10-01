/*
 * 阅读器前端
 *
 * 纯手写、零依赖、无构建步骤：直接从 Worker 的静态资源里发出来。
 *
 * 两条硬规矩：
 * 1. **一律不拼 HTML 字符串**。书名、作者、正文全来自第三方站点，用 innerHTML
 *    等于把外部内容当代码执行。所有外部文本都走 textContent（见 el()）。
 * 2. 路由用 hash 而不是 History API：hash 不需要服务端配合回退，
 *    少一处「刷新页面 404」的坑，也省掉一份 SPA 回退配置的维护。
 */

// ---------------------------------------------------------------- 基础设施

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
        else node.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue
        node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
}

/**
 * 本机身份
 *
 * 书架与阅读进度按身份隔离，服务端要求每个请求带上这个头。
 * 头名必须与 src/lib/identity.ts 里的 USER_HEADER 一致 —— 两边各写一份是没办法的事
 * （前端不能用那个模块），所以改动时记得同时改。
 *
 * token 首次访问时生成、存在 localStorage 里。由此带来两个必须让使用者知道的事实：
 *   1. 换浏览器/设备、或清了站点数据，就看到另一份（空的）书架；
 *   2. 想在另一台设备上接着读，把这里的 token 复制过去即可 —— 页脚提供了这个入口。
 */
const USER_HEADER = 'x-reader-user'
const USER_STORAGE_KEY = 'readerUser'
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,64}$/

function userToken() {
    let token = localStorage.getItem(USER_STORAGE_KEY) ?? ''
    if (!TOKEN_SHAPE.test(token)) {
        // 两段 UUID 去掉连字符正好 64 位，够长也够随机
        token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
        localStorage.setItem(USER_STORAGE_KEY, token)
    }
    return token
}

/** 调用接口。失败时抛出带 code 的错误，调用方据此决定怎么提示 */
async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: { ...(options.headers ?? {}), [USER_HEADER]: userToken() },
    })
    const text = await response.text()
    let json = null
    try {
        json = text === '' ? null : JSON.parse(text)
    } catch {
        /* 非 JSON：下面按状态码统一处理 */
    }
    if (!response.ok) {
        const error = new Error(json?.error ?? `请求失败（HTTP ${response.status}）`)
        error.code = json?.code ?? 'http_error'
        error.status = response.status
        throw error
    }
    return json
}

const postJson = (path, body) =>
    api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })

const paramsOf = (obj) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
    }
    return search.toString()
}

/**
 * 分批导入书源
 *
 * 导入接口对**单次请求体**有上限（防止一次误传把 Worker 内存打满），
 * 而社区合集动辄好几 MB（yckceo 的精选合集 6.5 MB / 821 条），一次传不进去。
 * 所以这里按大小切片分批提交，再把各批的结果合并成一份报告。
 *
 * 切片而不是直接调大上限：上限是为了护住 Worker 内存，调大等于把风险让给线上；
 * 而分批对任何规模的合集都成立。
 */
async function importSourcesChunked(text) {
    const CHUNK_BYTES = 1.5 * 1024 * 1024
    const totals = { imported: 0, updated: 0, rejected: [] }

    let list = null
    try {
        const parsed = JSON.parse(text)
        list = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.sources)
              ? parsed.sources
              : null
    } catch {
        /* 不是合法 JSON 就整段发过去，让接口给出准确的报错 */
    }

    // 小文件、或结构不对（不是数组）时不切，交给接口统一判定
    if (!list || list.length === 0 || text.length <= CHUNK_BYTES) {
        return api('/api/sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: text,
        })
    }

    const batches = Math.max(1, Math.ceil(text.length / CHUNK_BYTES))
    const perBatch = Math.ceil(list.length / batches)
    for (let start = 0; start < list.length; start += perBatch) {
        const slice = list.slice(start, start + perBatch)
        const report = await api('/api/sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(slice),
        })
        totals.imported += report.imported ?? 0
        totals.updated += report.updated ?? 0
        if (report.rejected?.length) totals.rejected.push(...report.rejected)
    }
    return totals
}

function parseRoute() {
    const raw = location.hash.replace(/^#\/?/, '')
    const [path, query] = raw.split('?')
    return { path: path === '' ? 'shelf' : path, params: new URLSearchParams(query ?? '') }
}

const go = (hash) => {
    location.hash = hash
}

function alertBox(kind, message, extra) {
    return el('div', { class: `alert ${kind}` }, [
        message,
        extra ? el('div', { class: 'muted', text: extra }) : null,
    ])
}

function spinner(label) {
    return el('div', { class: 'card muted', text: label })
}

/** 顶部的临时提示，2.5 秒后自己消失 */
let toastTimer = null
function toast(message, kind = 'ok') {
    const host = document.querySelector('#toast')
    host.replaceChildren(alertBox(kind, message))
    host.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
        host.hidden = true
    }, 2500)
}

// ---------------------------------------------------------------- 主题与字号

const prefs = {
    get theme() {
        return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'
    },
    set theme(value) {
        localStorage.setItem('theme', value)
        applyTheme()
    },
    get fontSize() {
        return Number(localStorage.getItem('fontSize') ?? '18')
    },
    set fontSize(value) {
        localStorage.setItem('fontSize', String(value))
        applyFontSize()
    },
}

function applyTheme() {
    document.documentElement.dataset.theme = prefs.theme
}

function applyFontSize() {
    document.documentElement.style.setProperty('--reader-font-size', `${prefs.fontSize}px`)
}

/**
 * 页脚里的身份显示
 *
 * 身份是「书架跟着谁走」的唯一依据，把它藏起来只会让人困惑于
 * 「为什么换个浏览器书架就空了」。显示出来，并给出复制/切换两个入口 ——
 * 这样在另一台设备上接着读是可行的，而不是只能重来。
 */
function renderIdentity() {
    const host = document.querySelector('#identity')
    if (!host) return
    const token = userToken()

    host.replaceChildren(
        el('span', { text: `本机身份 ${token.slice(0, 6)}…${token.slice(-4)}` }),
        el('button', {
            class: 'btn sm',
            text: '复制',
            title: '复制本机身份，可在另一台设备上「切换身份」粘贴',
            onclick: async () => {
                try {
                    await navigator.clipboard.writeText(token)
                    toast('身份已复制')
                } catch {
                    // 剪贴板权限可能被浏览器拒绝，那就把完整的贴出来让人手动复制
                    toast(`复制失败，请手动复制：${token}`, 'error')
                }
            },
        }),
        el('button', {
            class: 'btn sm',
            text: '切换',
            title: '粘贴另一台设备的身份，接着读那边的书架',
            onclick: () => {
                const next = prompt('粘贴另一台设备的身份（留空取消）：', '')
                if (!next) return
                const trimmed = next.trim()
                if (!TOKEN_SHAPE.test(trimmed)) {
                    toast('身份格式不对（应为 20～64 位字母、数字或 - _）', 'error')
                    return
                }
                localStorage.setItem(USER_STORAGE_KEY, trimmed)
                shelfCache = null
                toast('已切换身份')
                render()
            },
        }),
    )
}

// ---------------------------------------------------------------- 书架缓存

/**
 * 书架快照。用来判断「这本书在不在书架里」，以及避免每次进详情页都重查一遍。
 * 任何一次增删之后都要 invalidate，否则界面会显示过期的状态。
 */
let shelfCache = null

async function loadShelf(force = false) {
    if (shelfCache && !force) return shelfCache
    const data = await api('/api/shelf')
    shelfCache = data.entries ?? []
    return shelfCache
}

function inShelf(entries, sourceId, bookUrl) {
    return entries.some((e) => e.sourceId === sourceId && e.bookUrl === bookUrl)
}

async function addBook(sourceId, bookUrl, name, author, coverUrl) {
    const result = await postJson('/api/shelf', { sourceId, bookUrl, name, author, coverUrl })
    shelfCache = null
    toast(result.created ? `已加入书架：${name}` : `已在书架里：${name}`)
    return result
}

async function removeBook(entry) {
    await api(`/api/shelf?key=${encodeURIComponent(entry.bookKey)}`, { method: 'DELETE' })
    shelfCache = null
    toast(`已移出书架：${entry.name}`)
}

// ---------------------------------------------------------------- 视图：书架

async function viewShelf(host) {
    host.append(el('h2', { text: '书架' }))
    host.append(spinner('正在读取书架…'))

    let entries
    try {
        entries = await loadShelf(true)
    } catch (err) {
        host.replaceChildren(
            el('h2', { text: '书架' }),
            alertBox('error', '读取书架失败', err.message),
        )
        return
    }

    host.replaceChildren(el('h2', { text: '书架' }))

    if (entries.length === 0) {
        host.append(
            alertBox(
                'warn',
                '书架还是空的',
                '先在「书源」里导入一份 Legado 书源，再去「搜索」找书。',
            ),
            el('div', { class: 'row' }, [
                el('button', {
                    class: 'btn primary',
                    text: '去书源管理',
                    onclick: () => go('#/sources'),
                }),
                el('button', { class: 'btn', text: '去搜索', onclick: () => go('#/search') }),
            ]),
        )
        return
    }

    for (const entry of entries) {
        const readInfo =
            entry.chapterName !== null
                ? `读到第 ${(entry.chapterIndex ?? 0) + 1} 章 · ${entry.chapterName}`
                : '还没开始读'

        host.append(
            el('div', { class: 'card' }, [
                el('div', { class: 'book-item' }, [
                    el(
                        'div',
                        { class: 'cover' },
                        entry.coverUrl ? el('img', { src: entry.coverUrl, alt: '' }) : '无封面',
                    ),
                    el('div', { class: 'spacer' }, [
                        el('div', {
                            class: 'title',
                            text: entry.name,
                            onclick: () =>
                                go(
                                    `#/book?${paramsOf({
                                        sourceId: entry.sourceId,
                                        url: entry.bookUrl,
                                        name: entry.name,
                                        author: entry.author,
                                    })}`,
                                ),
                        }),
                        el('div', { class: 'muted', text: entry.author || '未知作者' }),
                        el('div', { class: 'muted', text: readInfo }),
                    ]),
                ]),
                el('div', { class: 'row tight', style: 'margin-top:10px' }, [
                    el('button', {
                        class: 'btn primary sm',
                        text: entry.chapterName !== null ? '继续阅读' : '开始阅读',
                        onclick: () =>
                            go(
                                `#/read?${paramsOf({
                                    sourceId: entry.sourceId,
                                    bookUrl: entry.bookUrl,
                                    name: entry.name,
                                    author: entry.author,
                                    index: entry.chapterIndex ?? 0,
                                })}`,
                            ),
                    }),
                    el('div', { class: 'spacer' }),
                    el('button', {
                        class: 'btn danger sm',
                        text: '移出书架',
                        onclick: async (event) => {
                            if (!confirm(`把《${entry.name}》移出书架？阅读进度也会一起清掉。`))
                                return
                            event.target.disabled = true
                            try {
                                await removeBook(entry)
                                render()
                            } catch (err) {
                                toast(`移出失败：${err.message}`, 'error')
                                event.target.disabled = false
                            }
                        },
                    }),
                ]),
            ]),
        )
    }
}

// ---------------------------------------------------------------- 视图：搜索

let searchKeyword = ''

async function viewSearch(host) {
    const input = el('input', {
        type: 'search',
        placeholder: '输入书名或作者',
        value: searchKeyword,
        onkeydown: (event) => {
            if (event.key === 'Enter') runSearch()
        },
    })

    const resultHost = el('section')

    host.replaceChildren(
        el('h2', { text: '搜索' }),
        el('div', { class: 'card' }, [
            el('div', { class: 'row' }, [
                el('div', { class: 'spacer' }, [input]),
                el('button', { class: 'btn primary', text: '搜索', onclick: () => runSearch() }),
            ]),
            el('div', {
                class: 'muted',
                style: 'margin-top:8px',
                text: '会并发打到所有启用的书源。',
            }),
        ]),
        resultHost,
    )

    async function runSearch() {
        const keyword = input.value.trim()
        if (keyword === '') {
            resultHost.replaceChildren(alertBox('warn', '先输入关键词'))
            return
        }
        searchKeyword = keyword
        resultHost.replaceChildren(spinner('正在搜索…'))

        let data
        try {
            data = await postJson('/api/search', { keyword })
        } catch (err) {
            resultHost.replaceChildren(alertBox('error', '搜索失败', err.message))
            return
        }

        const blocks = []
        if (data.sourceCount === 0) {
            blocks.push(
                alertBox(
                    'warn',
                    '没有可用的书源',
                    '一份书源都没有，或者都被停用了。先去「书源」里导入。',
                ),
            )
        } else {
            blocks.push(
                el('div', {
                    class: 'muted',
                    text: `命中 ${data.totalBooks} 本，来自 ${data.sourceCount} 个书源；关键词「${data.keyword}」`,
                }),
            )
        }

        for (const group of data.sources ?? []) {
            const header = el('div', { class: 'row tight', style: 'margin-top:6px' }, [
                el('strong', { text: group.sourceName }),
                el('span', {
                    class: `badge ${group.ok ? 'on' : 'off'}`,
                    text: group.ok ? `${group.count} 本 · ${group.elapsedMs}ms` : '失败',
                }),
            ])

            if (!group.ok) {
                // 单个源失败不影响别人，但必须把原因摆出来 —— 否则用户只会觉得「搜不到书」
                blocks.push(
                    el('div', { class: 'card' }, [
                        header,
                        alertBox(
                            'error',
                            group.error ?? '这个书源出错了',
                            `错误码：${group.errorCode ?? '未知'}`,
                        ),
                    ]),
                )
                continue
            }

            const items = (group.books ?? []).map((book) => bookCard(book, group.sourceId))
            blocks.push(
                el('div', { class: 'card' }, [
                    header,
                    items.length === 0
                        ? el('div', { class: 'muted', text: '这个源没有结果' })
                        : null,
                    ...items,
                ]),
            )
        }

        resultHost.replaceChildren(...blocks)
    }

    if (searchKeyword !== '') runSearch()
}

function bookCard(book, sourceId) {
    const openBook = () =>
        go(
            `#/book?${paramsOf({
                sourceId,
                url: book.bookUrl,
                name: book.name,
                author: book.author,
            })}`,
        )

    return el('div', { class: 'book-item', style: 'margin-top:10px' }, [
        el(
            'div',
            { class: 'cover' },
            book.coverUrl ? el('img', { src: book.coverUrl, alt: '' }) : '无封面',
        ),
        el('div', { class: 'spacer' }, [
            el('div', { class: 'title', text: book.name, onclick: openBook }),
            el('div', {
                class: 'muted',
                text: [book.author, book.kind, book.lastChapter].filter(Boolean).join(' · '),
            }),
            el('div', { class: 'row tight', style: 'margin-top:6px' }, [
                el('button', { class: 'btn sm', text: '详情 / 目录', onclick: openBook }),
                el('button', {
                    class: 'btn sm',
                    text: '加入书架',
                    onclick: async (event) => {
                        event.target.disabled = true
                        try {
                            await addBook(
                                sourceId,
                                book.bookUrl,
                                book.name,
                                book.author ?? '',
                                book.coverUrl ?? '',
                            )
                        } catch (err) {
                            toast(`加入失败：${err.message}`, 'error')
                        } finally {
                            event.target.disabled = false
                        }
                    },
                }),
            ]),
        ]),
    ])
}

// ---------------------------------------------------------------- 视图：书源管理

/**
 * 上一次导入的结果。
 *
 * 存在模块里而不是直接写进 DOM：导入成功后要重渲染整个列表（书源数变了），
 * 而重渲染会把刚插进去的提示节点一起清掉 —— 被拒绝的明细正是用户最需要看到的东西，
 * 不能因为一次刷新就消失。
 */
let lastImportReport = null

async function viewSources(host) {
    host.replaceChildren(el('h2', { text: '书源' }), spinner('正在读取书源…'))

    let sources
    try {
        sources = (await api('/api/sources')).sources ?? []
    } catch (err) {
        host.replaceChildren(
            el('h2', { text: '书源' }),
            alertBox('error', '读取书源失败', err.message),
        )
        return
    }

    const listHost = el('section')
    const importHost = el('section')

    host.replaceChildren(
        el('h2', { text: '书源' }),
        importHost,
        el('h3', { text: `已有书源（${sources.length}）` }),
        listHost,
    )

    // ---- 上一次导入的结果 ----

    if (lastImportReport) {
        const report = lastImportReport
        importHost.append(
            el('div', { class: 'card' }, [
                el('strong', {
                    text: `上次导入：新增 ${report.imported} 条，更新 ${report.updated} 条，拒绝 ${report.rejected?.length ?? 0} 条`,
                }),
                ...(report.rejected ?? []).map((item) =>
                    el('div', { class: 'muted', text: `${item.name}：${item.reason}` }),
                ),
                el('div', { class: 'row tight', style: 'margin-top:8px' }, [
                    el('button', {
                        class: 'btn sm',
                        text: '知道了',
                        onclick: () => {
                            lastImportReport = null
                            render()
                        },
                    }),
                ]),
            ]),
        )
    }

    // ---- 导入 ----

    const textarea = el('textarea', {
        placeholder: '把 Legado 书源的 JSON 粘到这里（数组或 {"sources":[...]} 都行）',
    })
    const fileInput = el('input', { type: 'file', accept: '.json,application/json' })
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0]
        if (!file) return
        textarea.value = await file.text()
        toast(`已读入 ${file.name}（${Math.round(file.size / 1024)} KB）`)
    })

    importHost.append(
        el('div', { class: 'card' }, [
            el('div', { class: 'row' }, [
                el('div', { class: 'spacer' }, [fileInput]),
                el('button', {
                    class: 'btn primary',
                    text: '导入',
                    onclick: async (event) => {
                        const text = textarea.value.trim()
                        if (text === '') {
                            toast('还没有内容可导入', 'error')
                            return
                        }
                        event.target.disabled = true
                        event.target.textContent = '导入中…'
                        try {
                            const report = await importSourcesChunked(text)
                            lastImportReport = report
                            toast(`新增 ${report.imported} 条，更新 ${report.updated} 条`)
                            render()
                        } catch (err) {
                            toast(`导入失败：${err.message}`, 'error')
                            event.target.disabled = false
                            event.target.textContent = '导入'
                        }
                    },
                }),
            ]),
            el('div', {
                class: 'muted',
                style: 'margin:8px 0',
                text: '同一个站点地址重复导入算更新，会保留你改过的名字、分组与启用状态。',
            }),
            textarea,
        ]),
    )

    // ---- 列表 ----

    if (sources.length === 0) {
        listHost.append(
            alertBox('warn', '还没有书源', '导入一份 Legado 书源 JSON 之后就能搜索了。'),
        )
        return
    }

    for (const source of sources) {
        const badges = [
            source.builtin ? el('span', { class: 'badge', text: '内置' }) : null,
            source.enabled ? null : el('span', { class: 'badge off', text: '已停用' }),
            source.hasSearch ? null : el('span', { class: 'badge off', text: '无搜索规则' }),
        ].filter(Boolean)

        listHost.append(
            el('div', { class: 'card' }, [
                el('div', { class: 'row tight' }, [
                    el('strong', { text: source.name }),
                    ...badges,
                    el('div', { class: 'spacer' }),
                    el('label', { class: 'check' }, [
                        el('input', {
                            type: 'checkbox',
                            checked: source.enabled,
                            onchange: async (event) => {
                                event.target.disabled = true
                                const wanted = event.target.checked
                                try {
                                    await api('/api/sources', {
                                        method: 'PATCH',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ id: source.id, enabled: wanted }),
                                    })
                                    toast(wanted ? '已启用' : '已停用')
                                    // 重渲染，让「已停用」徽标跟着开关一起变 ——
                                    // 只动开关不换徽标，页面就会同时显示两种互相矛盾的状态
                                    render()
                                } catch (err) {
                                    toast(`操作失败：${err.message}`, 'error')
                                    event.target.checked = !wanted
                                    event.target.disabled = false
                                }
                            },
                        }),
                        '启用',
                    ]),
                    source.builtin
                        ? null
                        : el('button', {
                              class: 'btn danger sm',
                              text: '删除',
                              onclick: async (event) => {
                                  if (!confirm(`删除书源「${source.name}」？`)) return
                                  event.target.disabled = true
                                  try {
                                      await api(
                                          `/api/sources?id=${encodeURIComponent(source.id)}`,
                                          { method: 'DELETE' },
                                      )
                                      toast(`已删除：${source.name}`)
                                      render()
                                  } catch (err) {
                                      toast(`删除失败：${err.message}`, 'error')
                                      event.target.disabled = false
                                  }
                              },
                          }),
                ]),
                el('div', { class: 'muted mono', style: 'margin-top:6px', text: source.id }),
            ]),
        )
    }
}

// ---------------------------------------------------------------- 视图：书籍详情

async function viewBook(host) {
    const route = parseRoute()
    const sourceId = route.params.get('sourceId') ?? ''
    const bookUrl = route.params.get('url') ?? ''
    const name = route.params.get('name') ?? ''
    const author = route.params.get('author') ?? ''

    if (sourceId === '' || bookUrl === '') {
        host.replaceChildren(alertBox('error', '缺少书源或书籍地址'))
        return
    }

    host.replaceChildren(el('h2', { text: name || '书籍' }), spinner('正在读取详情…'))

    let info
    try {
        info = await api(`/api/book?${paramsOf({ sourceId, url: bookUrl })}`)
    } catch (err) {
        host.replaceChildren(
            el('h2', { text: name || '书籍' }),
            alertBox('error', '读取详情失败', err.message),
        )
        return
    }

    const chapters = []
    let tocError = null
    let tocWarning = null
    if (info.tocUrl) {
        try {
            const toc = await api(`/api/toc?${paramsOf({ sourceId, url: info.tocUrl })}`)
            chapters.push(...(toc.chapters ?? []))
            // 翻页中途失败时服务端会给出 warning：目录能用，但很可能不完整。
            // 不显示的话，用户会以为「这本书就这么几章」——那是静默的少数据。
            tocWarning = toc.warning ?? null
        } catch (err) {
            tocError = err
        }
    }

    const shelf = await loadShelf().catch(() => [])
    const alreadyInShelf = inShelf(shelf, sourceId, bookUrl)
    const bookName = info.name || name || '未命名'
    const bookAuthor = info.author || author

    const openChapter = (index) =>
        go(
            `#/read?${paramsOf({
                sourceId,
                bookUrl,
                name: bookName,
                author: bookAuthor,
                index,
            })}`,
        )

    host.replaceChildren(
        el('h2', { text: bookName }),
        el('div', { class: 'card' }, [
            el('div', { class: 'muted', text: bookAuthor || '未知作者' }),
            info.intro ? el('p', { class: 'muted', text: info.intro }) : null,
            el('div', { class: 'row tight', style: 'margin-top:8px' }, [
                el('button', {
                    class: 'btn primary sm',
                    text: chapters.length > 0 ? '从第一章开始读' : '开始阅读',
                    disabled: chapters.length === 0 && !info.tocUrl,
                    onclick: () => openChapter(0),
                }),
                el('button', {
                    class: 'btn sm',
                    text: alreadyInShelf ? '已在书架' : '加入书架',
                    disabled: alreadyInShelf,
                    onclick: async (event) => {
                        event.target.disabled = true
                        try {
                            await addBook(
                                sourceId,
                                bookUrl,
                                bookName,
                                bookAuthor,
                                info.coverUrl ?? '',
                            )
                            event.target.textContent = '已在书架'
                        } catch (err) {
                            toast(`加入失败：${err.message}`, 'error')
                            event.target.disabled = false
                        }
                    },
                }),
                el('div', { class: 'spacer' }),
                el('button', { class: 'btn sm', text: '返回', onclick: () => history.back() }),
            ]),
        ]),
    )

    if (tocError) {
        host.append(alertBox('error', '目录读取失败', tocError.message))
        return
    }
    if (tocWarning) {
        host.append(alertBox('warn', '这份目录可能不完整', tocWarning))
    }
    if (chapters.length === 0) {
        host.append(alertBox('warn', '这个书源没给目录', '可能规则里的 chapterList 没匹配到内容。'))
        return
    }

    host.append(
        el('h3', { text: `目录（${chapters.length} 章）` }),
        el('div', { class: 'card' }, [
            el(
                'ul',
                { class: 'chapter-list' },
                chapters.map((chapter, index) =>
                    el('li', {}, [
                        el('button', {
                            text: `${index + 1}. ${chapter.name}`,
                            onclick: () => openChapter(index),
                        }),
                    ]),
                ),
            ),
        ]),
    )
}

// ---------------------------------------------------------------- 视图：阅读

/**
 * 当前打开的书的目录缓存。
 *
 * 翻页时不该重新拉一次目录：一次翻页要 3 个请求已经不算少，
 * 目录不变的前提下再拉一遍纯属浪费 —— 而且源站点慢的话，翻页会明显卡顿。
 */
let readerCache = null

async function viewRead(host) {
    const route = parseRoute()
    const sourceId = route.params.get('sourceId') ?? ''
    const bookUrl = route.params.get('bookUrl') ?? ''
    const name = route.params.get('name') ?? ''
    const author = route.params.get('author') ?? ''
    const wantedIndex = Number(route.params.get('index') ?? '0')

    if (sourceId === '' || bookUrl === '') {
        host.replaceChildren(alertBox('error', '缺少书源或书籍地址'))
        return
    }

    const cacheKey = `${sourceId}\n${bookUrl}`
    if (readerCache?.key !== cacheKey) {
        host.replaceChildren(el('h2', { text: name || '阅读' }), spinner('正在读取目录…'))
        try {
            const info = await api(`/api/book?${paramsOf({ sourceId, url: bookUrl })}`)
            if (!info.tocUrl) throw new Error('这个书源没有给出目录地址')
            const toc = await api(`/api/toc?${paramsOf({ sourceId, url: info.tocUrl })}`)
            readerCache = {
                key: cacheKey,
                sourceId,
                bookUrl,
                name: info.name || name || '未命名',
                author: info.author || author,
                chapters: toc.chapters ?? [],
                tocWarning: toc.warning ?? null,
            }
        } catch (err) {
            host.replaceChildren(
                el('h2', { text: name || '阅读' }),
                alertBox('error', '打不开这本书', err.message),
                el('div', { class: 'row' }, [
                    el('button', { class: 'btn', text: '返回', onclick: () => history.back() }),
                ]),
            )
            return
        }
    }

    const book = readerCache
    if (book.chapters.length === 0) {
        host.replaceChildren(el('h2', { text: book.name }), alertBox('warn', '这本书没有章节'))
        return
    }

    let index = Number.isFinite(wantedIndex) ? wantedIndex : 0
    index = Math.min(Math.max(index, 0), book.chapters.length - 1)
    const chapter = book.chapters[index]

    const titleEl = el('div', {
        class: 'chapter-title',
        text: `${index + 1}/${book.chapters.length} · ${chapter.name}`,
    })
    const readingHost = el('article', { id: 'reading' }, [spinner('正在取正文…')])

    const bar = el('div', { class: 'reader-bar' }, [
        el('button', {
            class: 'icon-btn',
            text: '←',
            title: '上一章',
            disabled: index === 0,
            onclick: () => openChapter(index - 1),
        }),
        titleEl,
        el('button', {
            class: 'icon-btn',
            text: '→',
            title: '下一章',
            disabled: index === book.chapters.length - 1,
            onclick: () => openChapter(index + 1),
        }),
        el('button', { class: 'icon-btn', text: '目录', onclick: () => openDrawer(book, index) }),
        el('button', {
            class: 'icon-btn',
            text: 'A-',
            title: '缩小字号',
            onclick: () => (prefs.fontSize = Math.max(14, prefs.fontSize - 1)),
        }),
        el('button', {
            class: 'icon-btn',
            text: 'A+',
            title: '放大字号',
            onclick: () => (prefs.fontSize = Math.min(28, prefs.fontSize + 1)),
        }),
        el('button', {
            class: 'icon-btn',
            text: prefs.theme === 'dark' ? '浅色' : '深色',
            title: '切换主题',
            onclick: (event) => {
                prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'
                event.target.textContent = prefs.theme === 'dark' ? '浅色' : '深色'
            },
        }),
    ])

    host.replaceChildren(bar, readingHost)

    function openChapter(next) {
        go(
            `#/read?${paramsOf({ sourceId, bookUrl, name: book.name, author: book.author, index: next })}`,
        )
    }

    // ---- 取正文 ----

    let content
    try {
        content = await api(`/api/content?${paramsOf({ sourceId, url: chapter.url })}`)
    } catch (err) {
        readingHost.replaceChildren(
            alertBox('error', '正文取不到', err.message),
            el('div', { class: 'row' }, [
                el('button', { class: 'btn', text: '返回目录', onclick: () => openBookDetail() }),
            ]),
        )
        return
    }

    /**
     * 按类型渲染正文
     *
     * 文本 / 图片 / 音频 / 下载是四种不同的东西。以前四种一律按文本渲染，
     * 于是图片源显示成一堆 `<img>` 源码、音频源显示成一条网址、文件源直接报错 ——
     * 不是四个毛病，是把四种东西当成了一种。
     *
     * 媒体地址用的是服务端签发的 /api/media 地址（代理原因见项目 README）。
     */
    function renderText(text) {
        const box = el('div')
        if (text === '') {
            // 空正文是真实存在的问题（规则没匹配到），不能装成「这一章没内容」糊过去
            box.append(
                alertBox(
                    'warn',
                    '这一章取到的是空正文',
                    '通常是书源的 content 规则没匹配到内容，或站点改版了。',
                ),
            )
            return box
        }
        for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (trimmed !== '') box.append(el('p', { text: trimmed }))
        }
        return box
    }

    function renderImages(images) {
        const box = el('div', { class: 'comic' })
        if (!images || images.length === 0) {
            box.append(
                alertBox(
                    'warn',
                    '这一话没有取到图片',
                    '通常是书源的 content 规则没匹配到图片地址。',
                ),
            )
            return box
        }
        images.forEach((image, index) => {
            box.append(
                el('img', {
                    class: 'comic-page',
                    src: image.proxyUrl,
                    alt: `第 ${index + 1} 页`,
                    loading: 'lazy',
                    // 单张图失败不该让整话变空白，也不该静默：就地说明是第几张没取到
                    onerror: (event) => {
                        event.target.replaceWith(
                            el('div', {
                                class: 'comic-failed',
                                text: `第 ${index + 1} 张加载失败`,
                            }),
                        )
                    },
                }),
            )
        })
        box.append(el('div', { class: 'comic-meta', text: `共 ${images.length} 张` }))
        return box
    }

    function renderAudio(audio) {
        const box = el('div', { class: 'audio-box' })
        if (!audio?.proxyUrl) {
            box.append(alertBox('warn', '没有取到音频地址', '书源的正文规则没匹配到可播放的直链。'))
            return box
        }
        box.append(
            el('audio', {
                class: 'audio-player',
                controls: true,
                preload: 'metadata',
                src: audio.proxyUrl,
            }),
        )
        box.append(
            el('p', {
                class: 'hint',
                text: '拖动进度条依赖上游支持 Range；若一直加载不出来，多半是上游站点限制了访问。',
            }),
        )
        return box
    }

    function renderDownloads(downloads) {
        const box = el('div', { class: 'downloads' })
        if (!downloads || downloads.length === 0) {
            box.append(
                alertBox('warn', '没有取到下载地址', '书源的 downloadUrls 规则没匹配到地址。'),
            )
            return box
        }
        downloads.forEach((item, index) => {
            box.append(
                el('a', {
                    class: 'btn dl',
                    href: item.proxyUrl,
                    download: item.name || '',
                    text: item.name || `下载 ${index + 1}`,
                }),
            )
        })
        box.append(el('p', { class: 'hint', text: '下载由本站代取，因此不受上游防盗链影响。' }))
        return box
    }

    function renderContent(payload) {
        switch (payload.kind) {
            case 'images':
                return renderImages(payload.images)
            case 'audio':
                return renderAudio(payload.audio)
            case 'downloads':
                return renderDownloads(payload.downloads)
            default:
                return renderText(String(payload.content ?? '').trim())
        }
    }

    const body = renderContent(content)

    readingHost.replaceChildren(
        el('h1', { text: chapter.name }),
        // 目录不完整时说一句：否则用户会把「少了一截」当成「这本书就这么长」
        ...(book.tocWarning ? [alertBox('warn', '这份目录可能不完整', book.tocWarning)] : []),
        body,
        el('div', { class: 'reader-nav' }, [
            el('button', {
                class: 'btn',
                text: index === 0 ? '已是第一章' : '上一章',
                disabled: index === 0,
                onclick: () => openChapter(index - 1),
            }),
            el('button', {
                class: 'btn',
                text: index === book.chapters.length - 1 ? '已是最后一章' : '下一章',
                disabled: index === book.chapters.length - 1,
                onclick: () => openChapter(index + 1),
            }),
        ]),
        el('div', { class: 'row tight', style: 'margin-top:14px' }, [
            el('button', { class: 'btn sm', text: '书目 / 目录', onclick: () => openBookDetail() }),
        ]),
    )

    function openBookDetail() {
        go(`#/book?${paramsOf({ sourceId, url: bookUrl, name: book.name, author: book.author })}`)
    }

    window.scrollTo({ top: 0 })

    // ---- 记录阅读位置 ----

    try {
        await api('/api/progress', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sourceId,
                bookUrl,
                chapterUrl: chapter.url,
                chapterName: chapter.name,
                chapterIndex: index,
            }),
        })
        shelfCache = null
    } catch (err) {
        // 记不上进度不影响这一章的阅读，但得让用户知道 —— 否则下次打开会发现位置不对
        toast(`阅读进度没记上：${err.message}`, 'error')
    }
}

function openDrawer(book, currentIndex) {
    const list = el(
        'ul',
        { class: 'chapter-list' },
        book.chapters.map((chapter, index) =>
            el('li', { 'data-current': index === currentIndex ? 'true' : 'false' }, [
                el('button', {
                    text: `${index + 1}. ${chapter.name}`,
                    onclick: () => {
                        close()
                        go(
                            `#/read?${paramsOf({
                                sourceId: book.sourceId,
                                bookUrl: book.bookUrl,
                                name: book.name,
                                author: book.author,
                                index,
                            })}`,
                        )
                    },
                }),
            ]),
        ),
    )

    const backdrop = el('div', { class: 'drawer-backdrop', onclick: () => close() })
    const drawer = el('div', { class: 'drawer' }, [
        el('header', {}, [
            el('strong', { text: '目录' }),
            el('div', { class: 'spacer' }),
            el('button', { class: 'icon-btn', text: '×', onclick: () => close() }),
        ]),
        el('div', { class: 'body' }, [list]),
    ])

    function close() {
        backdrop.remove()
        drawer.remove()
    }

    document.body.append(backdrop, drawer)
    // 打开时把当前章节滚进视野，省得每次手动找
    requestAnimationFrame(() => {
        list.querySelector('li[data-current="true"]')?.scrollIntoView({ block: 'center' })
    })
}

// ---------------------------------------------------------------- 路由

async function render() {
    const route = parseRoute()
    const host = document.querySelector('#view')
    host.replaceChildren()

    for (const tab of document.querySelectorAll('.tab')) {
        const active = tab.dataset.route === route.path
        if (active) tab.setAttribute('aria-current', 'page')
        else tab.removeAttribute('aria-current')
    }

    try {
        if (route.path === 'search') await viewSearch(host)
        else if (route.path === 'sources') await viewSources(host)
        else if (route.path === 'book') await viewBook(host)
        else if (route.path === 'read') await viewRead(host)
        else await viewShelf(host)
    } catch (err) {
        host.replaceChildren(alertBox('error', '页面出错', err?.message ?? String(err)))
    }
}

window.addEventListener('hashchange', render)
window.addEventListener('DOMContentLoaded', () => {
    applyTheme()
    applyFontSize()
    renderIdentity()
    for (const tab of document.querySelectorAll('.tab')) {
        tab.addEventListener('click', () => go(`#/${tab.dataset.route}`))
    }
    render()
})
