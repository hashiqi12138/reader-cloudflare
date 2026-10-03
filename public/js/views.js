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
    logout,
    paramsOf,
    postJson,
    prefs,
    register as doRegister,
    relativeTime,
    saveDisplayName,
    savePassword,
    setChildren,
    skeletonBlock,
    skeletonList,
    toast,
} from './core.js'
import { mergeBooks, sourceBookKey } from './merge.js'

/**
 * 阅读界面的地址
 *
 * 参数名必须是 `url`：`reader.js` 用 `route.get('url')` 取书籍地址，
 * 而 `viewBook` / 书架 / 阅读界面内部翻页也全都用 `url`。
 * 这里早先写的是 `bookUrl`，结果**点「开始阅读」永远停在「缺少书源或书籍地址」**——
 * 参数名对不上不会有任何报错，只是那一个页面打不开。
 */
export const readUrl = (sourceId, url, name, author, index) =>
    `#/read?${paramsOf({ sourceId, url, name, author, index })}`

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

// ---------------------------------------------------------------- 账号

/**
 * 账号设置：改显示名、改密码、退出登录
 *
 * 这一页原先不存在 —— 顶栏那个按钮直接就是「退出登录」，于是**没有任何入口能改密码**
 * （服务端连接口都没有）。对「长期使用」来说这是硬缺口：一旦怀疑密码泄露，
 * 用户唯一能做的是重新注册一个账号，而那会把书架、进度、书签全丢下。
 *
 * 三处刻意的设计：
 *
 * 1. 改密码要**当前密码**（服务端强制，见 `changePassword`）与**确认新密码**（纯界面体贴：
 *    密码框是掩码的，打错了自己看不见）。
 * 2. 改完密码**当前这条会话留着**，其它设备的会话由服务端踢掉，并在界面上说清踢了几条 ——
 *    「密码改了但别的设备还能用」是比不改更糟的状态。
 * 3. 显示名只管界面上那个称呼，**用户名不跟着改**：它是登录凭据。
 */
export async function viewAccount(host) {
    const user = currentUser()
    if (!user) {
        host.replaceChildren(emptyState('先登录', '登录之后才能看到账号设置。'))
        return
    }

    const card = (title, ...children) =>
        el('section', { class: 'card' }, [el('h2', { text: title }), ...children])

    // ---- 显示名 ----
    const nameInput = el('input', {
        type: 'text',
        maxlength: '24',
        value: user.displayName,
    })
    const nameStatus = el('div')
    const nameSubmit = el('button', { class: 'btn primary', type: 'submit', text: '保存' })

    const nameForm = el(
        'form',
        {
            onsubmit: async (event) => {
                event.preventDefault()
                nameStatus.replaceChildren()
                nameSubmit.disabled = true
                try {
                    const updated = await saveDisplayName(String(nameInput.value).trim())
                    toast(`显示名已改为「${updated?.displayName ?? ''}」`)
                    /**
                     * 顶栏那一份也是从会话里读的，通知它重画（app.js 监听这个事件）
                     *
                     * `bubbles: true` 不能省：事件派发在 `document` 上，而监听在 `window`，
                     * 默认不冒泡就**到不了**监听器 —— 表现是「改名成功、提示也对，顶栏还是旧名字」。
                     */
                    document.dispatchEvent(
                        new CustomEvent('reader:account-changed', { bubbles: true }),
                    )
                } catch (err) {
                    nameStatus.replaceChildren(alertBox('error', '没能改显示名', err.message))
                } finally {
                    nameSubmit.disabled = false
                }
            },
        },
        [
            el('label', { class: 'field' }, [
                el('span', { class: 'field-label', text: '显示名' }),
                nameInput,
            ]),
            el('p', { class: 'muted tiny', text: '只改界面上显示的名字，登录用的用户名不变。' }),
            nameSubmit,
            nameStatus,
        ],
    )

    // ---- 密码 ----
    const currentInput = el('input', {
        type: 'password',
        autocomplete: 'current-password',
        placeholder: '当前密码',
    })
    const nextInput = el('input', {
        type: 'password',
        autocomplete: 'new-password',
        placeholder: '新密码（至少 8 位）',
    })
    const againInput = el('input', {
        type: 'password',
        autocomplete: 'new-password',
        placeholder: '再输一次新密码',
    })
    const passwordStatus = el('div')
    const passwordSubmit = el('button', { class: 'btn primary', type: 'submit', text: '改密码' })

    const passwordForm = el(
        'form',
        {
            onsubmit: async (event) => {
                event.preventDefault()
                passwordStatus.replaceChildren()
                const next = String(nextInput.value)
                if (next !== String(againInput.value)) {
                    passwordStatus.replaceChildren(
                        alertBox('error', '两次输入的新密码不一样', '那两栏要填同一个。'),
                    )
                    return
                }
                passwordSubmit.disabled = true
                passwordSubmit.textContent = '提交中…'
                try {
                    const result = await savePassword(String(currentInput.value), next)
                    currentInput.value = ''
                    nextInput.value = ''
                    againInput.value = ''
                    const revoked = Number(result?.revoked ?? 0)
                    passwordStatus.replaceChildren(
                        alertBox(
                            'ok',
                            '密码已改',
                            revoked > 0
                                ? `其它 ${revoked} 台设备上的登录已经失效，需要重新登录。`
                                : '其它设备上的登录不受影响。',
                        ),
                    )
                } catch (err) {
                    passwordStatus.replaceChildren(alertBox('error', '没能改密码', err.message))
                } finally {
                    passwordSubmit.disabled = false
                    passwordSubmit.textContent = '改密码'
                }
            },
        },
        [
            el('label', { class: 'field' }, [
                el('span', { class: 'field-label', text: '当前密码' }),
                currentInput,
            ]),
            el('label', { class: 'field' }, [
                el('span', { class: 'field-label', text: '新密码' }),
                nextInput,
            ]),
            el('label', { class: 'field' }, [
                el('span', { class: 'field-label', text: '确认新密码' }),
                againInput,
            ]),
            passwordSubmit,
            passwordStatus,
        ],
    )

    setChildren(host, [
        el('h1', { text: '账号' }),
        card('显示名', nameForm),
        card('密码', passwordForm),
        card(
            '账号信息',
            el('p', { class: 'muted tiny', text: `用户名：${user.username}` }),
            el('p', {
                class: 'muted tiny',
                text: `注册于 ${new Date(user.createdAt).toLocaleString('zh-CN')}`,
            }),
            el('div', { class: 'row' }, [
                el('button', {
                    class: 'btn ghost',
                    text: '退出登录',
                    onclick: async () => {
                        await logout()
                        invalidateShelf()
                        toast('已退出登录')
                        go('#/login')
                    },
                }),
            ]),
        ),
    ])
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
    /**
     * 合并卡片要按「**任一**书源有这本」算已在书架
     *
     * 搜索结果是按书合并的，一条卡片背后可能有十几个源；只看主源的话，
     * 从别的源加过这本书再搜一次，卡片还是显示「加入书架」，点了才发现重复。
     */
    const saved = options.savedAny
        ? options.savedAny.some((item) => inShelf(entries, item.sourceId, item.bookUrl))
        : entries
          ? inShelf(entries, sourceId, book.bookUrl)
          : false

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

/**
 * 书源选择器
 *
 * 带发现页的书源动辄几百条，横排 chips 在桌面端几乎没法用：
 * 滚动条被 `scrollbar-width: none` 藏掉了，鼠标滚轮也不会把竖向滚动翻译成横向，
 * 于是「书源列表滚不动」。这里换成一个可搜索的下拉 —— 点开是固定高度的列表，
 * 竖向滚动 + 关键字过滤，几百条也能几秒内找到。
 */
function sourcePicker(sources, activeSource, onPick) {
    const label = el('span', { class: 'picker-value', text: activeSource.name })
    const button = el(
        'button',
        {
            class: 'picker-button',
            type: 'button',
            title: '切换书源',
            onclick: (event) => {
                event.stopPropagation()
                toggle()
            },
        },
        [label, el('span', { class: 'picker-caret', text: '▾' })],
    )

    const search = el('input', {
        type: 'search',
        class: 'picker-search',
        placeholder: `在 ${sources.length} 个书源里搜索…`,
        oninput: () => renderList(search.value),
        onkeydown: (event) => {
            if (event.key === 'Escape') close()
        },
    })

    const list = el('div', { class: 'picker-list', role: 'listbox' })
    const panel = el('div', { class: 'picker-panel', hidden: true }, [search, list])
    const wrap = el('div', { class: 'picker' }, [button, panel])

    function renderList(keyword = '') {
        const needle = keyword.trim().toLowerCase()
        const matched = needle
            ? sources.filter(
                  (s) =>
                      s.name.toLowerCase().includes(needle) ||
                      (s.group ?? '').toLowerCase().includes(needle),
              )
            : sources
        if (matched.length === 0) {
            list.replaceChildren(el('p', { class: 'muted tiny center', text: '没有匹配的书源' }))
            return
        }
        list.replaceChildren(
            ...matched.map((source) =>
                el(
                    'button',
                    {
                        class: `picker-item ${source.id === activeSource.id ? 'active' : ''}`,
                        type: 'button',
                        onclick: () => {
                            close()
                            onPick(source)
                        },
                    },
                    [
                        el('span', { class: 'picker-item-name', text: source.name }),
                        source.group
                            ? el('span', { class: 'badge ghost', text: source.group })
                            : null,
                    ],
                ),
            ),
        )
    }

    function open() {
        panel.hidden = false
        button.classList.add('open')
        renderList(search.value)
        requestAnimationFrame(() => search.focus())
    }
    function close() {
        panel.hidden = true
        button.classList.remove('open')
    }
    function toggle() {
        if (panel.hidden) open()
        else close()
    }

    // 点面板之外收起。视图被替换后自己摘掉监听，避免路由来回切时累积。
    const onDocClick = (event) => {
        if (!wrap.isConnected) {
            document.removeEventListener('click', onDocClick)
            return
        }
        if (!wrap.contains(event.target)) close()
    }
    document.addEventListener('click', onDocClick)

    return wrap
}

/** 把发现页的失败按原因归类，给一句能落地的下一步，而不是只回显原始错误 */
function exploreHint(err) {
    const message = String(err?.message ?? '')
    if (/没有配置发现地址/.test(message))
        return '这个书源没有 exploreUrl，换一个带「可发现」标记的书源。'
    if (/没有配置发现页的书目规则/.test(message))
        return '书源缺少 ruleExplore.bookList，没法解析书目。'
    if (/is not defined|not a function/.test(message))
        return '书源的脚本用到了本引擎还没实现的全局变量或方法。'
    if (/超时|timeout/i.test(message)) return '书源站点响应太慢，稍后再试。'
    if (/上游返回 HTTP|请求失败|取网失败/.test(message))
        return '书源站点拒绝了请求或已改版，换个分类试试。'
    if (/不是合法 JSON/.test(message)) return '书源地址的写法本引擎还没支持，换一个分类试试。'
    return ''
}

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
    const activeSource =
        sources.find((s) => s.id === wanted) ?? sources.find((s) => s.id === stored) ?? sources[0]
    const active = activeSource.id

    const picker = sourcePicker(sources, activeSource, (source) => {
        localStorage.setItem(EXPLORE_PICK_KEY, source.id)
        go(`#/explore?${paramsOf({ sourceId: source.id })}`)
    })

    const categoryBar = el('div', { class: 'chips wrap' })
    const listHost = el('div')
    host.replaceChildren(
        el('div', { class: 'page-head' }, [
            el('div', {}, [
                el('h1', { class: 'page-title', text: '发现' }),
                el('p', {
                    class: 'muted',
                    text: `${sources.length} 个书源带发现页 · 按书源自带的栏目逛一逛`,
                }),
            ]),
        ]),
        el('div', { class: 'explore-bar' }, [
            el('span', { class: 'muted tiny', text: '书源' }),
            picker,
        ]),
        categoryBar,
        listHost,
    )
    localStorage.setItem(EXPLORE_PICK_KEY, active)

    listHost.replaceChildren(skeletonList(3, 'grid'))
    let explore
    try {
        explore = await api(`/api/explore?${paramsOf({ sourceId: active })}`)
    } catch (err) {
        const hint = exploreHint(err)
        categoryBar.replaceChildren()
        listHost.replaceChildren(
            alertBox(
                'error',
                '这个书源的发现页打不开',
                hint ? `${err.message}（${hint}）` : err.message,
            ),
            el('div', { class: 'row' }, [
                el('button', {
                    class: 'btn ghost',
                    text: '重试',
                    onclick: () => viewExplore(host),
                }),
                el('button', {
                    class: 'btn ghost',
                    text: '换个书源',
                    onclick: () => go('#/explore'),
                }),
            ]),
        )
        return
    }

    const categories = explore.categories ?? []
    if (categories.length === 0) {
        listHost.replaceChildren(
            alertBox(
                'warn',
                '这个书源的发现页里没有任何分类',
                '书源声明了 exploreUrl，但解析出来是空的 —— 通常是规则改版了。',
            ),
        )
        return
    }

    const wantedCategory = route.get('url')
    let current = categories.find((c) => c.url === wantedCategory) ?? categories[0]

    // 分类多起来（有的源上百个）之后，横向 chips 同样滚不动，所以允许换行铺开
    for (const category of categories) {
        categoryBar.append(
            el('button', {
                class: `chip ${category.url === current.url ? 'active' : ''}`,
                text: category.title,
                onclick: (event) => {
                    current = category
                    for (const node of categoryBar.children) node.classList.remove('active')
                    event.currentTarget.classList.add('active')
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
                        `「${current.title}」这个栏目下没有取到书`,
                        '可能是书源的列表规则没匹配到，或站点改版了。换个栏目试试。',
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
            const hint = exploreHint(err)
            footer.replaceChildren()
            listHost.append(
                alertBox(
                    'error',
                    `「${current.title}」打不开`,
                    hint ? `${err.message}（${hint}）` : err.message,
                ),
            )
        } finally {
            loading = false
        }
    }

    await loadCategory(1)
}

// ---------------------------------------------------------------- 搜索

let lastKeyword = ''

/**
 * 最近一次搜索的合并结果，供**详情页换源**用
 *
 * 键是 (书源, 书籍地址)：详情页只知道「自己在哪一源、哪一条地址」，
 * 从这里反查出「同一条书在别的源上的地址」。刷新页面缓存就没了 ——
 * 那时详情页只是不显示「换源」那一排，读书不受影响。
 */
const mergedIndex = new Map()

function rememberMerged(merged) {
    mergedIndex.clear()
    for (const item of merged) {
        for (const source of item.sources) {
            mergedIndex.set(sourceBookKey(source.sourceId, source.book.bookUrl), item)
        }
    }
}

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

        /**
         * **按书合并**，而不是按书源分块列出来
         *
         * 按源分块的话，同一本书在十几个源上出现十几次（真实安装里搜一个热词就是一整页
         * 重复）；而且源越多越严重 —— 加源本来是为了「多几条路能读到书」，
         * 结果反而让搜索结果更难用。合并之后一条卡片代表一本书，
         * 主源进详情页、那里再换源（见下方 rememberMerged）。
         */
        const succeeded = (data.sources ?? []).filter(
            (per) => per.ok && (per.books ?? []).length > 0,
        )
        const merged = mergeBooks(succeeded, {
            // 已经在书架里的那一源优先 —— 从搜索点进去就是上次读的那个源
            prefer: (sourceId, book) => inShelf(entries, sourceId, book.bookUrl),
        })
        rememberMerged(merged)

        const blocks = [
            el('p', {
                class: 'muted',
                text: `命中 ${data.totalBooks} 本，来自 ${data.sourceCount} 个书源；按书合并后是 ${merged.length} 本`,
            }),
        ]
        const failed = []

        for (const per of data.sources ?? []) {
            if (!per.ok) failed.push(`${per.sourceName}：${per.error ?? '未知错误'}`)
        }

        if (merged.length > 0) {
            const grid = el('div', { class: 'grid' })
            for (const item of merged) {
                const preferred = item.preferred
                grid.append(
                    bookCard({ ...item, bookUrl: preferred.book.bookUrl }, preferred.sourceId, {
                        entries,
                        // 一条卡片背后可能有很多源，任一源加过就算已在书架
                        savedAny: item.sources.map((source) => ({
                            sourceId: source.sourceId,
                            bookUrl: source.book.bookUrl,
                        })),
                        sourceLabel:
                            item.sources.length > 1
                                ? `${item.sources.length} 个书源`
                                : preferred.sourceName,
                        onRead: () =>
                            go(
                                readUrl(
                                    preferred.sourceId,
                                    preferred.book.bookUrl,
                                    item.name,
                                    item.author,
                                    0,
                                ),
                            ),
                    }),
                )
            }
            blocks.push(grid)
        } else {
            blocks.push(
                emptyState(
                    '没搜到',
                    '换个关键词试试；也可以到「书源」里看看启用的源是不是都被停用了。',
                ),
            )
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

    /**
     * 换源：别的书源上也有这本书时，列一排按钮
     *
     * 搜索结果是按书合并的，所以「这本书在哪些源上有」这件事只有这里能回答 ——
     * 换了源之后同一个页面重新走一遍，地址换成那一源的地址，其余一切照旧。
     * 缓存来自最近一次搜索；直接分享链接进来（没搜过）时这一排不出现，不影响读书。
     */
    const group = mergedIndex.get(sourceBookKey(sourceId, target))
    const others = (group?.sources ?? []).filter((item) => item.sourceId !== sourceId)
    const switchRow =
        others.length > 0
            ? el('section', { class: 'card switch-sources' }, [
                  el('h2', { text: `换源（还有 ${others.length} 个书源有这本书）` }),
                  el(
                      'div',
                      { class: 'row' },
                      others.map((item) =>
                          el('button', {
                              class: 'btn sm ghost',
                              text: item.sourceName,
                              title: `用「${item.sourceName}」打开这本书`,
                              onclick: () => go(bookUrl(item.sourceId, item.book)),
                          }),
                      ),
                  ),
              ])
            : null

    setChildren(host, [
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
        switchRow,
        warning ? alertBox('warn', '这份目录可能不完整', warning) : null,
        chapterList
            ? el('section', { class: 'card' }, [el('h2', { text: '目录' }), chapterList])
            : null,
    ])
}
