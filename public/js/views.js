/*
 * 各视图：登录、首页、书架、发现、搜索、书源、书籍详情。
 *
 * 阅读界面单独放在 reader.js —— 它是唯一有状态机（分页、翻页动画、手势）的一屏，
 * 和这些「取数据 → 渲染」的页面不是一类东西。
 */

import {
    alertBox,
    api,
    append,
    claimAnonymous,
    coverNode,
    currentUser,
    el,
    go,
    loadSession,
    login as doLogin,
    paramsOf,
    postJson,
    prefs,
    register as doRegister,
    relativeTime,
    skeletonBlock,
    skeletonList,
    toast,
} from './core.js'

export const readUrl = (sourceId, bookUrl, name, author, index) =>
    `#/read?${paramsOf({ sourceId, bookUrl, name, author, index })}`

export const bookUrl = (sourceId, book) =>
    `#/book?${paramsOf({ sourceId, url: book.bookUrl, name: book.name, author: book.author })}`

// ---------------------------------------------------------------- 书架缓存

let shelfEntries = null

export async function loadShelf(force = false) {
    if (shelfEntries && !force) return shelfEntries
    const data = await api('/api/shelf')
    shelfEntries = data.entries ?? []
    return shelfEntries
}

export function invalidateShelf() {
    shelfEntries = null
}

export const inShelf = (entries, sourceId, target) =>
    entries.some((e) => e.sourceId === sourceId && e.bookUrl === target)

export async function addBook(sourceId, book) {
    const result = await postJson('/api/shelf', {
        sourceId,
        bookUrl: book.bookUrl,
        name: book.name,
        author: book.author ?? '',
        coverUrl: book.coverUrl ?? '',
    })
    invalidateShelf()
    toast(result.created ? `已加入书架：${result.entry.name}` : `已在书架里：${result.entry.name}`)
    return result
}

export async function removeBook(entry) {
    await api(`/api/shelf?key=${encodeURIComponent(entry.bookKey)}`, { method: 'DELETE' })
    invalidateShelf()
    toast(`已移出书架：${entry.name}`)
}

// ---------------------------------------------------------------- 登录

export async function viewLogin(host, notice) {
    const mode = { value: 'login' }
    const username = el('input', {
        type: 'text',
        name: 'username',
        autocomplete: 'username',
        placeholder: '用户名',
        value: '',
    })
    const password = el('input', {
        type: 'password',
        name: 'password',
        autocomplete: 'current-password',
        placeholder: '密码（至少 8 位）',
    })
    const submit = el('button', { class: 'btn primary block', type: 'submit', text: '登录' })
    const errorHost = el('div')
    const switchHint = el('div', { class: 'auth-switch' })
    const card = el('div', { class: 'card auth-card' })
    const heading = el('h1', { class: 'auth-title', text: '书源阅读器' })

    function renderSwitch() {
        switchHint.replaceChildren(
            mode.value === 'login'
                ? el('span', {}, [
                      '还没有账号？',
                      el('button', {
                          class: 'link',
                          type: 'button',
                          text: '注册一个',
                          onclick: () => {
                              mode.value = 'register'
                              renderSwitch()
                          },
                      }),
                  ])
                : el('span', {}, [
                      '已经有账号了？',
                      el('button', {
                          class: 'link',
                          type: 'button',
                          text: '去登录',
                          onclick: () => {
                              mode.value = 'login'
                              renderSwitch()
                          },
                      }),
                  ]),
        )
        submit.textContent = mode.value === 'login' ? '登录' : '注册并开始使用'
        password.autocomplete = mode.value === 'login' ? 'current-password' : 'new-password'
        heading.textContent = mode.value === 'login' ? '欢迎回来' : '创建账号'
    }

    const form = el(
        'form',
        {
            class: 'auth-form',
            onsubmit: async (event) => {
                event.preventDefault()
                errorHost.replaceChildren()
                submit.disabled = true
                submit.textContent = mode.value === 'login' ? '登录中…' : '注册中…'
                try {
                    const user = String(username.value).trim()
                    const pass = String(password.value)
                    if (mode.value === 'login') await doLogin(user, pass)
                    else await doRegister(user, pass)
                    toast(`欢迎，${currentUser()?.displayName ?? user}`)
                    go('#/home')
                } catch (err) {
                    errorHost.replaceChildren(alertBox('error', '没能登录', err.message))
                } finally {
                    submit.disabled = false
                    renderSwitch()
                }
            },
        },
        [
            el('label', { class: 'field' }, [
                el('span', { class: 'field-label', text: '用户名' }),
                username,
            ]),
            el('label', { class: 'field' }, [
                el('span', { class: 'field-label', text: '密码' }),
                password,
            ]),
            submit,
            errorHost,
            switchHint,
        ],
    )

    card.append(
        el('p', { class: 'auth-lead', text: '书架、阅读进度跟着账号走，换设备也能接着读。' }),
        form,
    )
    host.replaceChildren(
        el('section', { class: 'auth' }, [
            heading,
            card,
            notice ? el('div', { class: 'auth-notice', text: notice }) : null,
            el('p', {
                class: 'muted center',
                text: '书源仍然由部署者统一维护：换浏览器，书源还在。',
            }),
        ]),
    )
    username.focus()
    renderSwitch()
}

// ---------------------------------------------------------------- 书籍卡片

/**
 * 书籍卡片
 *
 * 卡片本身点开详情，次要动作（加入书架）放在卡片右下角的小按钮上 ——
 * 把「打开」和「收藏」都做成整块可点，就一定会有人点错。
 */
export function bookCard(book, sourceId, options = {}) {
    const entries = options.entries ?? null
    const saved = entries ? inShelf(entries, sourceId, book.bookUrl) : false

    const meta = [book.author || '未知作者', book.kind || '', book.lastChapter || '']
        .filter(Boolean)
        .join(' · ')

    return el('article', { class: `book-card ${options.compact ? 'compact' : ''}` }, [
        el('a', { class: 'book-card-main', href: bookUrl(sourceId, book) }, [
            coverNode(book.coverUrl, book.name, 'cover'),
            el('div', { class: 'book-card-text' }, [
                el('h3', { class: 'book-title', text: book.name }),
                el('p', { class: 'book-meta', text: meta }),
                book.intro ? el('p', { class: 'book-intro', text: book.intro }) : null,
            ]),
        ]),
        el('div', { class: 'book-card-actions' }, [
            options.sourceLabel ? el('span', { class: 'badge', text: options.sourceLabel }) : null,
            el('div', { class: 'spacer' }),
            options.onRead
                ? el('button', {
                      class: 'btn sm ghost',
                      text: '试读',
                      onclick: options.onRead,
                  })
                : null,
            el('button', {
                class: `btn sm ${saved ? 'ghost' : 'primary'}`,
                text: saved ? '已在书架' : '加入书架',
                disabled: saved,
                onclick: async (event) => {
                    const button = event.target
                    button.disabled = true
                    try {
                        await addBook(sourceId, book)
                        button.textContent = '已在书架'
                        button.classList.remove('primary')
                        button.classList.add('ghost')
                        options.onChanged?.()
                    } catch (err) {
                        toast(`加入失败：${err.message}`, 'error')
                        button.disabled = false
                    }
                },
            }),
        ]),
    ])
}

function emptyState(title, hint, actions = []) {
    return el('div', { class: 'empty' }, [
        el('div', { class: 'empty-mark', text: '📚' }),
        el('h2', { text: title }),
        el('p', { class: 'muted', text: hint }),
        actions.length > 0 ? el('div', { class: 'row center' }, actions) : null,
    ])
}

// ---------------------------------------------------------------- 首页

export async function viewHome(host) {
    host.replaceChildren(el('h1', { class: 'page-title', text: '首页' }), skeletonList(4, 'grid'))

    let data
    try {
        data = await api('/api/home')
    } catch (err) {
        host.replaceChildren(
            el('h1', { class: 'page-title', text: '首页' }),
            alertBox('error', '首页加载失败', err.message),
        )
        return
    }

    const sections = data.sections ?? []
    const reading = data.continueReading ?? []

    const head = el('div', { class: 'page-head' }, [
        el('div', {}, [
            el('h1', { class: 'page-title', text: '首页' }),
            el('p', {
                class: 'muted',
                text: `继续阅读 ${reading.length} 本 · 推荐来自 ${sections.length} 个书源`,
            }),
        ]),
        el('button', {
            class: 'btn sm ghost',
            text: '换一批',
            title: '重新拉一遍各书源的推荐位',
            onclick: async (event) => {
                event.target.disabled = true
                event.target.textContent = '更新中…'
                try {
                    await api('/api/home?refresh=1')
                    toast('推荐位已更新')
                    await viewHome(host)
                } catch (err) {
                    toast(`更新失败：${err.message}`, 'error')
                    event.target.disabled = false
                    event.target.textContent = '换一批'
                }
            },
        }),
    ])

    const blocks = [head]

    // ---- 继续阅读 ----
    if (reading.length > 0) {
        const row = el('div', { class: 'rail' })
        for (const entry of reading) {
            row.append(
                el('article', { class: 'rail-card' }, [
                    el('div', { class: 'rail-head' }, [
                        coverNode(entry.coverUrl, entry.name, 'cover small'),
                        el('div', { class: 'rail-text' }, [
                            el('h3', { class: 'book-title', text: entry.name }),
                            el('p', {
                                class: 'book-meta',
                                text: entry.chapterName
                                    ? `第 ${(entry.chapterIndex ?? 0) + 1} 章 · ${entry.chapterName}`
                                    : '还没开始读',
                            }),
                            el('p', {
                                class: 'muted tiny',
                                text: entry.readAt
                                    ? `上次阅读 ${relativeTime(entry.readAt)}`
                                    : '加入书架',
                            }),
                        ]),
                    ]),
                    el('div', { class: 'rail-actions' }, [
                        el('button', {
                            class: 'btn primary sm',
                            text: '继续阅读',
                            onclick: () =>
                                go(
                                    readUrl(
                                        entry.sourceId,
                                        entry.bookUrl,
                                        entry.name,
                                        entry.author,
                                        entry.chapterIndex ?? 0,
                                    ),
                                ),
                        }),
                        el('div', { class: 'spacer' }),
                        el('a', {
                            class: 'btn sm ghost',
                            href: bookUrl(entry.sourceId, {
                                bookUrl: entry.bookUrl,
                                name: entry.name,
                            }),
                            text: '详情',
                        }),
                    ]),
                ]),
            )
        }
        blocks.push(sectionTitle('继续阅读'), row)
    }

    // ---- 推荐位 ----
    if (sections.length === 0) {
        blocks.push(
            emptyState(
                '还没有可推荐的来源',
                '推荐位取自各书源的「发现页」（exploreUrl）。导入带发现页的书源后，这里会自动出现内容。',
                [
                    el('button', {
                        class: 'btn primary',
                        text: '去导入书源',
                        onclick: () => go('#/sources'),
                    }),
                    el('button', {
                        class: 'btn ghost',
                        text: '去发现页',
                        onclick: () => go('#/explore'),
                    }),
                ],
            ),
        )
    }

    for (const section of sections) {
        const row = el('div', { class: 'rail' })
        for (const book of section.books) {
            row.append(
                el('a', { class: 'shelf-tile', href: bookUrl(section.sourceId, book) }, [
                    coverNode(book.coverUrl, book.name, 'cover tile'),
                    el('span', { class: 'tile-title', text: book.name }),
                    el('span', { class: 'tile-meta', text: book.author || '未知作者' }),
                ]),
            )
        }
        blocks.push(
            el('div', { class: 'section-head' }, [
                el('h2', { text: section.category }),
                el('span', { class: 'muted tiny', text: section.sourceName }),
                el('div', { class: 'spacer' }),
                el('button', {
                    class: 'link',
                    text: '在发现页看更多',
                    onclick: () =>
                        go(
                            `#/explore?${paramsOf({ sourceId: section.sourceId, url: section.categoryUrl })}`,
                        ),
                }),
            ]),
            row,
        )
    }

    if ((data.failures ?? []).length > 0) {
        blocks.push(
            el('details', { class: 'failures' }, [
                el('summary', { text: `${data.failures.length} 个书源这次没取到推荐` }),
                el(
                    'ul',
                    {},
                    data.failures.map((line) => el('li', { text: line })),
                ),
            ]),
        )
    }

    blocks.push(
        el('p', { class: 'muted tiny center', text: `推荐位缓存于 ${relativeTime(data.builtAt)}` }),
    )
    host.replaceChildren(...blocks)
    void prefs
}

function sectionTitle(label) {
    return el('div', { class: 'section-head' }, [el('h2', { text: label })])
}

// ---------------------------------------------------------------- 书架

export async function viewShelf(host) {
    host.replaceChildren(el('h1', { class: 'page-title', text: '书架' }), skeletonList(4, 'grid'))

    let entries
    try {
        entries = await loadShelf(true)
    } catch (err) {
        host.replaceChildren(
            el('h1', { class: 'page-title', text: '书架' }),
            alertBox('error', '读取书架失败', err.message),
        )
        return
    }

    if (entries.length === 0) {
        host.replaceChildren(
            el('h1', { class: 'page-title', text: '书架' }),
            emptyState('书架还是空的', '去发现页逛逛，或者直接搜书名。', [
                el('button', {
                    class: 'btn primary',
                    text: '去发现页',
                    onclick: () => go('#/explore'),
                }),
                el('button', { class: 'btn ghost', text: '去搜索', onclick: () => go('#/search') }),
            ]),
        )
        return
    }

    const grid = el('div', { class: 'grid' })
    for (const entry of entries) {
        grid.append(
            el('article', { class: 'book-card' }, [
                el(
                    'a',
                    {
                        class: 'book-card-main',
                        href: bookUrl(entry.sourceId, { bookUrl: entry.bookUrl, name: entry.name }),
                    },
                    [
                        coverNode(entry.coverUrl, entry.name, 'cover'),
                        el('div', { class: 'book-card-text' }, [
                            el('h3', { class: 'book-title', text: entry.name }),
                            el('p', { class: 'book-meta', text: entry.author || '未知作者' }),
                            el('p', {
                                class: 'muted tiny',
                                text: entry.chapterName
                                    ? `读到第 ${(entry.chapterIndex ?? 0) + 1} 章 · ${entry.chapterName}`
                                    : '还没开始读',
                            }),
                        ]),
                    ],
                ),
                el('div', { class: 'book-card-actions' }, [
                    el('button', {
                        class: 'btn primary sm',
                        text: entry.chapterName ? '继续阅读' : '开始阅读',
                        onclick: () =>
                            go(
                                readUrl(
                                    entry.sourceId,
                                    entry.bookUrl,
                                    entry.name,
                                    entry.author,
                                    entry.chapterIndex ?? 0,
                                ),
                            ),
                    }),
                    el('div', { class: 'spacer' }),
                    el('button', {
                        class: 'btn sm danger ghost',
                        text: '移出',
                        onclick: async (event) => {
                            if (!confirm(`把《${entry.name}》移出书架？阅读进度也会一起清掉。`))
                                return
                            event.target.disabled = true
                            try {
                                await removeBook(entry)
                                await viewShelf(host)
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

    host.replaceChildren(
        el('div', { class: 'page-head' }, [
            el('div', {}, [
                el('h1', { class: 'page-title', text: '书架' }),
                el('p', { class: 'muted', text: `${entries.length} 本` }),
            ]),
            el('button', {
                class: 'btn sm ghost',
                text: '去发现页',
                onclick: () => go('#/explore'),
            }),
        ]),
        grid,
    )
}

// ---------------------------------------------------------------- 发现

const EXPLORE_PICK_KEY = 'explore.pick'

export async function viewExplore(host) {
    const route = new URLSearchParams(location.hash.split('?')[1] ?? '')
    host.replaceChildren(
        el('h1', { class: 'page-title', text: '发现' }),
        skeletonBlock('正在读取书源…'),
    )

    let sources
    try {
        const data = await api('/api/sources')
        sources = (data.sources ?? []).filter((s) => s.hasExplore && s.enabled)
    } catch (err) {
        host.replaceChildren(
            el('h1', { class: 'page-title', text: '发现' }),
            alertBox('error', '读取书源失败', err.message),
        )
        return
    }

    if (sources.length === 0) {
        host.replaceChildren(
            el('h1', { class: 'page-title', text: '发现' }),
            emptyState(
                '没有可探索的书源',
                '「发现」用的是书源的 exploreUrl（发现页）。现在没有启用的书源带这个字段。',
                [
                    el('button', {
                        class: 'btn primary',
                        text: '去书源管理',
                        onclick: () => go('#/sources'),
                    }),
                    el('button', {
                        class: 'btn ghost',
                        text: '去搜索',
                        onclick: () => go('#/search'),
                    }),
                ],
            ),
        )
        return
    }

    // 记住上次看的是哪个书源：从推荐位点进来时也不会丢上下文
    const stored = localStorage.getItem(EXPLORE_PICK_KEY)
    const wanted = route.get('sourceId')
    const active =
        sources.find((s) => s.id === wanted)?.id ??
        sources.find((s) => s.id === stored)?.id ??
        sources[0].id

    const sourceBar = el('div', { class: 'chips' })
    for (const source of sources) {
        sourceBar.append(
            el('button', {
                class: `chip ${source.id === active ? 'active' : ''}`,
                text: source.name,
                onclick: () => {
                    localStorage.setItem(EXPLORE_PICK_KEY, source.id)
                    go(`#/explore?${paramsOf({ sourceId: source.id })}`)
                },
            }),
        )
    }

    const categoryBar = el('div', { class: 'chips' })
    const listHost = el('div')
    host.replaceChildren(
        el('div', { class: 'page-head' }, [
            el('div', {}, [
                el('h1', { class: 'page-title', text: '发现' }),
                el('p', { class: 'muted', text: '按书源自带的栏目逛一逛' }),
            ]),
        ]),
        sourceBar,
        categoryBar,
        listHost,
    )
    localStorage.setItem(EXPLORE_PICK_KEY, active)

    listHost.replaceChildren(skeletonList(3, 'grid'))
    let explore
    try {
        explore = await api(`/api/explore?${paramsOf({ sourceId: active })}`)
    } catch (err) {
        categoryBar.replaceChildren()
        listHost.replaceChildren(
            alertBox('error', '这个书源的发现页打不开', err.message),
            el('div', { class: 'row' }, [
                el('button', {
                    class: 'btn ghost',
                    text: '重试',
                    onclick: () => viewExplore(host),
                }),
            ]),
        )
        return
    }

    const categories = explore.categories ?? []
    if (categories.length === 0) {
        listHost.replaceChildren(alertBox('warn', '这个书源的发现页里没有任何分类'))
        return
    }

    const wantedCategory = route.get('url')
    let current = categories.find((c) => c.url === wantedCategory) ?? categories[0]

    for (const category of categories) {
        categoryBar.append(
            el('button', {
                class: `chip ${category.url === current.url ? 'active' : ''}`,
                text: category.title,
                onclick: () => {
                    current = category
                    for (const node of categoryBar.children) node.classList.remove('active')
                    ;[...categoryBar.children][categories.indexOf(category)]?.classList.add(
                        'active',
                    )
                    void loadCategory(1)
                },
            }),
        )
    }

    let page = 1
    let loading = false
    const footer = el('div', { class: 'row center', style: 'margin-top:16px' })

    async function loadCategory(nextPage, append = false) {
        if (loading) return
        loading = true
        page = nextPage
        const grid = el('div', { class: 'grid' })

        if (append) footer.replaceChildren(el('span', { class: 'muted tiny', text: '加载中…' }))
        else listHost.replaceChildren(skeletonList(4, 'grid'))

        try {
            const data = await api(
                `/api/explore/books?${paramsOf({ sourceId: active, url: current.url, page })}`,
            )
            const books = data.books ?? []

            if (!append) listHost.replaceChildren()

            if (books.length > 0) {
                const entries = await loadShelf()
                for (const book of books) grid.append(bookCard(book, active, { entries }))
                if (append) {
                    listHost.querySelector('.grid')?.append(...grid.children)
                } else {
                    listHost.append(grid)
                }
            }

            /**
             * 「还有没有更多」有一半靠内容判断
             *
             * 分类地址带 `{{page}}` 时，分页是书源用模板表达的，没有 nextPageUrl 可看；
             * 这时唯一的停止信号就是**某一页返回 0 条**。所以这里既看 hasMore，
             * 也看实际取到几本 —— 否则会一直给一个「加载更多」的按钮，点下去永远空。
             */
            if (books.length === 0 && !append) {
                listHost.replaceChildren(
                    alertBox(
                        'warn',
                        '这个栏目下没有取到书',
                        '可能是书源规则没匹配到，或站点改版了。',
                    ),
                )
                footer.replaceChildren()
            } else if (books.length === 0) {
                footer.replaceChildren(el('span', { class: 'muted tiny', text: '没有更多了' }))
            } else if (data.hasMore) {
                footer.replaceChildren(
                    el('button', {
                        class: 'btn ghost',
                        text: '加载更多',
                        onclick: () => loadCategory(page + 1, true),
                    }),
                )
            } else {
                footer.replaceChildren(el('span', { class: 'muted tiny', text: '没有更多了' }))
            }

            if (!footer.parentNode) listHost.append(footer)
        } catch (err) {
            footer.replaceChildren()
            listHost.append(alertBox('error', '这个栏目打不开', err.message))
        } finally {
            loading = false
        }
    }

    await loadCategory(1)
}

// ---------------------------------------------------------------- 搜索

let lastKeyword = ''

export async function viewSearch(host) {
    const input = el('input', {
        type: 'search',
        placeholder: '书名、作者，或书源里的任意关键词',
        value: lastKeyword,
        onkeydown: (event) => {
            if (event.key === 'Enter') run()
        },
    })
    const resultHost = el('div')

    host.replaceChildren(
        el('h1', { class: 'page-title', text: '搜索' }),
        el('div', { class: 'card search-bar' }, [
            el('div', { class: 'row' }, [
                el('div', { class: 'spacer' }, [input]),
                el('button', { class: 'btn primary', text: '搜索', onclick: () => run() }),
            ]),
            el('p', { class: 'muted tiny', text: '并发打到所有启用的书源，每个源独立成败。' }),
        ]),
        resultHost,
    )

    async function run() {
        const keyword = input.value.trim()
        if (keyword === '') {
            resultHost.replaceChildren(alertBox('warn', '先输入关键词'))
            return
        }
        lastKeyword = keyword
        resultHost.replaceChildren(skeletonList(4, 'grid'))

        let data
        try {
            data = await postJson('/api/search', { keyword })
        } catch (err) {
            resultHost.replaceChildren(alertBox('error', '搜索失败', err.message))
            return
        }

        if (data.sourceCount === 0) {
            resultHost.replaceChildren(
                alertBox('warn', '没有可用的书源', '一份书源都没有，或者都被停用了。'),
            )
            return
        }

        const entries = await loadShelf()
        const blocks = [
            el('p', {
                class: 'muted',
                text: `命中 ${data.totalBooks} 本，来自 ${data.sourceCount} 个书源`,
            }),
        ]
        const failed = []

        for (const per of data.sources ?? []) {
            if (!per.ok) {
                failed.push(`${per.sourceName}：${per.error ?? '未知错误'}`)
                continue
            }
            if ((per.books ?? []).length === 0) continue

            const grid = el('div', { class: 'grid' })
            for (const book of per.books) {
                grid.append(
                    bookCard(book, per.sourceId, {
                        entries,
                        sourceLabel: per.sourceName,
                        onRead: () =>
                            go(readUrl(per.sourceId, book.bookUrl, book.name, book.author, 0)),
                    }),
                )
            }
            blocks.push(sectionTitle(`${per.sourceName}（${per.books.length}）`), grid)
        }

        if (failed.length > 0) {
            blocks.push(
                el('details', { class: 'failures' }, [
                    el('summary', { text: `${failed.length} 个书源搜索失败` }),
                    el(
                        'ul',
                        {},
                        failed.map((line) => el('li', { text: line })),
                    ),
                ]),
            )
        }
        resultHost.replaceChildren(...blocks)
    }

    if (lastKeyword !== '') await run()
    input.focus()
}

// ---------------------------------------------------------------- 书源管理

export async function viewSources(host) {
    host.replaceChildren(el('h1', { class: 'page-title', text: '书源' }), skeletonList(3))

    let data
    try {
        data = await api('/api/sources')
    } catch (err) {
        host.replaceChildren(
            el('h1', { class: 'page-title', text: '书源' }),
            alertBox('error', '读取失败', err.message),
        )
        return
    }

    const sources = data.sources ?? []
    const importBox = renderImport(host)
    const list = el('div', { class: 'source-list' })

    for (const source of sources) {
        list.append(
            el('article', { class: 'source-row' }, [
                el('div', { class: 'source-main' }, [
                    el('h3', { class: 'source-name', text: source.name }),
                    el('p', { class: 'source-meta' }, [
                        el('span', { class: 'badge', text: typeLabel(source.type) }),
                        source.group
                            ? el('span', { class: 'badge ghost', text: source.group })
                            : null,
                        source.hasSearch ? el('span', { class: 'badge ok', text: '可搜索' }) : null,
                        source.hasExplore
                            ? el('span', { class: 'badge ok', text: '可发现' })
                            : null,
                        source.builtin ? el('span', { class: 'badge ghost', text: '内置' }) : null,
                    ]),
                ]),
                el('div', { class: 'source-actions' }, [
                    el(
                        'label',
                        { class: 'switch', title: source.enabled ? '点击停用' : '点击启用' },
                        [
                            el('input', {
                                type: 'checkbox',
                                checked: source.enabled,
                                onchange: async (event) => {
                                    const enabled = event.target.checked
                                    try {
                                        await postJson('/api/sources', { id: source.id, enabled })
                                        toast(
                                            enabled
                                                ? `已启用：${source.name}`
                                                : `已停用：${source.name}`,
                                        )
                                    } catch (err) {
                                        event.target.checked = !enabled
                                        toast(`操作失败：${err.message}`, 'error')
                                    }
                                },
                            }),
                            el('span', { class: 'switch-track' }),
                        ],
                    ),
                    source.builtin
                        ? null
                        : el('button', {
                              class: 'btn sm danger ghost',
                              text: '删除',
                              onclick: async (event) => {
                                  if (!confirm(`删除书源「${source.name}」？`)) return
                                  event.target.disabled = true
                                  try {
                                      await api(
                                          `/api/sources?id=${encodeURIComponent(source.id)}`,
                                          {
                                              method: 'DELETE',
                                          },
                                      )
                                      toast(`已删除：${source.name}`)
                                      await viewSources(host)
                                  } catch (err) {
                                      toast(`删除失败：${err.message}`, 'error')
                                      event.target.disabled = false
                                  }
                              },
                          }),
                ]),
            ]),
        )
    }

    host.replaceChildren(
        el('div', { class: 'page-head' }, [
            el('div', {}, [
                el('h1', { class: 'page-title', text: '书源' }),
                el('p', {
                    class: 'muted',
                    text: `${sources.length} 条 · 书源是全局的，所有人共用`,
                }),
            ]),
        ]),
        importBox,
        sources.length === 0
            ? emptyState('还没有书源', '导入一份 Legado 书源 JSON 就能开始用。')
            : list,
    )
}

function typeLabel(type) {
    return { 0: '文本', 1: '音频', 2: '图片', 3: '文件' }[type] ?? '文本'
}

function renderImport(host) {
    const status = el('div', { class: 'import-status' })
    const file = el('input', {
        type: 'file',
        accept: '.json,application/json',
        onchange: async (event) => {
            const chosen = event.target.files?.[0]
            if (!chosen) return
            await runImport(await chosen.text(), `文件 ${chosen.name}`)
            event.target.value = ''
        },
    })
    const textarea = el('textarea', {
        rows: 5,
        placeholder: '把书源 JSON 粘在这里（数组或 {"sources":[…] } 都行）',
    })

    async function runImport(raw, label) {
        status.replaceChildren(el('p', { class: 'muted', text: `正在导入 ${label}…` }))
        try {
            const report = await importChunked(raw)
            status.replaceChildren(
                alertBox(
                    'ok',
                    `导入完成：新增 ${report.imported} 条，更新 ${report.updated} 条`,
                    report.rejected?.length
                        ? `${report.rejected.length} 条被拒：${report.rejected
                              .slice(0, 3)
                              .map((r) => r.reason ?? r.name ?? '')
                              .join('；')}`
                        : '',
                ),
            )
            await viewSources(host)
        } catch (err) {
            status.replaceChildren(alertBox('error', '导入失败', err.message))
        }
    }

    return el('details', { class: 'card import-card' }, [
        el('summary', { text: '导入书源' }),
        el('div', { class: 'import-body' }, [
            el('div', { class: 'row' }, [file]),
            el('label', { class: 'field' }, [
                el('span', { class: 'field-label', text: '或直接粘贴 JSON' }),
                textarea,
            ]),
            el('div', { class: 'row' }, [
                el('button', {
                    class: 'btn primary',
                    text: '导入粘贴的内容',
                    onclick: () => {
                        const raw = textarea.value.trim()
                        if (raw === '') {
                            status.replaceChildren(alertBox('warn', '先粘贴书源 JSON'))
                            return
                        }
                        void runImport(raw, '粘贴的内容')
                    },
                }),
                el('div', { class: 'spacer' }),
                el('button', {
                    class: 'btn ghost',
                    text: '从网址导入',
                    onclick: async () => {
                        const url = prompt('书源 JSON 的网址：', '')
                        if (!url) return
                        status.replaceChildren(el('p', { class: 'muted', text: '正在下载…' }))
                        try {
                            const response = await fetch(url, { credentials: 'omit' })
                            if (!response.ok) throw new Error(`HTTP ${response.status}`)
                            await runImport(await response.text(), url)
                        } catch (err) {
                            status.replaceChildren(
                                alertBox(
                                    'error',
                                    '下载失败',
                                    `${err.message}。如果是跨域限制，请先把文件下载到本地再用上面的文件选择。`,
                                ),
                            )
                        }
                    },
                }),
            ]),
            status,
        ]),
    ])
}

/**
 * 分批导入
 *
 * 导入接口对单次请求体有上限（护住 Worker 内存），而社区合集动辄好几 MB，
 * 一次传不进去。所以按大小切片分批提交，再把结果合并。
 */
async function importChunked(raw) {
    const CHUNK_BYTES = 1.5 * 1024 * 1024
    const totals = { imported: 0, updated: 0, rejected: [] }

    let list = null
    try {
        const parsed = JSON.parse(raw)
        list = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.sources)
              ? parsed.sources
              : null
    } catch {
        /* 不是合法 JSON 就整段发过去，让接口给出准确的报错 */
    }

    if (!list || list.length === 0 || raw.length <= CHUNK_BYTES) {
        return api('/api/sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: raw,
        })
    }

    const batches = Math.max(1, Math.ceil(raw.length / CHUNK_BYTES))
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

// ---------------------------------------------------------------- 书籍详情

export async function viewBook(host) {
    const route = new URLSearchParams(location.hash.split('?')[1] ?? '')
    const sourceId = route.get('sourceId') ?? ''
    const target = route.get('url') ?? ''
    if (sourceId === '' || target === '') {
        host.replaceChildren(alertBox('error', '缺少书源或书籍地址'))
        return
    }

    host.replaceChildren(skeletonBlock('正在打开…'))

    let info
    let chapters = []
    let warning = null
    try {
        info = await api(`/api/book?${paramsOf({ sourceId, url: target })}`)
        if (info.tocUrl) {
            const toc = await api(`/api/toc?${paramsOf({ sourceId, url: info.tocUrl })}`)
            chapters = toc.chapters ?? []
            warning = toc.warning ?? null
        }
    } catch (err) {
        host.replaceChildren(
            alertBox('error', '打不开这本书', err.message),
            el('div', { class: 'row' }, [
                el('button', { class: 'btn ghost', text: '返回', onclick: () => history.back() }),
            ]),
        )
        return
    }

    const name = info.name || route.get('name') || '未命名'
    const author = info.author || route.get('author') || ''
    const book = { bookUrl: target, name, author, coverUrl: info.coverUrl }
    const entries = await loadShelf()
    const saved = inShelf(entries, sourceId, target)

    const actionRow = el('div', { class: 'row' }, [
        el('button', {
            class: `btn ${saved ? 'ghost' : 'primary'}`,
            text: saved ? '已在书架' : '加入书架',
            disabled: saved,
            onclick: async (event) => {
                event.target.disabled = true
                try {
                    await addBook(sourceId, book)
                    await viewBook(host)
                } catch (err) {
                    toast(`加入失败：${err.message}`, 'error')
                    event.target.disabled = false
                }
            },
        }),
        chapters.length > 0
            ? el('button', {
                  class: 'btn',
                  text: '开始阅读',
                  onclick: () => go(readUrl(sourceId, target, name, author, 0)),
              })
            : null,
        el('div', { class: 'spacer' }),
        saved
            ? el('button', {
                  class: 'btn sm danger ghost',
                  text: '移出书架',
                  onclick: async () => {
                      if (!confirm(`把《${name}》移出书架？`)) return
                      await removeBook(
                          entries.find((e) => e.bookUrl === target && e.sourceId === sourceId),
                      )
                      await viewBook(host)
                  },
              })
            : null,
    ])

    const chapterList =
        chapters.length > 0
            ? el('ol', { class: 'chapter-list' }, [
                  ...chapters.slice(0, 80).map((chapter, index) =>
                      el('li', {}, [
                          el('button', {
                              class: 'chapter-link',
                              text: `${index + 1}. ${chapter.name}`,
                              onclick: () => go(readUrl(sourceId, target, name, author, index)),
                          }),
                      ]),
                  ),
                  chapters.length > 80
                      ? el('li', {
                            class: 'muted center tiny',
                            text: `只列出前 80 章，共 ${chapters.length} 章 —— 进阅读界面看完整目录`,
                        })
                      : null,
              ])
            : null

    host.replaceChildren(
        el('article', { class: 'book-detail card' }, [
            el('div', { class: 'book-detail-head' }, [
                coverNode(info.coverUrl, name, 'cover large'),
                el('div', { class: 'spacer' }, [
                    el('h1', { class: 'book-title large', text: name }),
                    el('p', { class: 'book-meta', text: author || '未知作者' }),
                    el('p', { class: 'muted tiny', text: `${chapters.length} 章` }),
                    actionRow,
                ]),
            ]),
            info.intro
                ? el('details', { class: 'intro', open: true }, [
                      el('summary', { text: '简介' }),
                      el('p', { text: info.intro }),
                  ])
                : null,
        ]),
        warning ? alertBox('warn', '这份目录可能不完整', warning) : null,
        chapterList
            ? el('section', { class: 'card' }, [el('h2', { text: '目录' }), chapterList])
            : null,
    )
}
