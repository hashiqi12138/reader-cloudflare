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
    contextParams,
    coverNode,
    coverSrc,
    currentUser,
    el,
    go,
    importBackupFile,
    loadSession,
    loadVersion,
    login as doLogin,
    logout,
    paramsOf,
    patchJson,
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
import {
    SEARCH_MIN_PAGE,
    SEARCH_PAGE_SIZE,
    isCpuLimitError,
    nextPageSize,
    normalizeSelection,
    searchableSources,
} from './searchPlan.js'
import {
    ABILITY_ALL,
    ABILITY_EXPLORE,
    ABILITY_LOGIN,
    ABILITY_SEARCH,
    DEFAULT_FILTER,
    GROUP_ALL,
    STATUS_ALL,
    STATUS_OFF,
    STATUS_ON,
    filterSources,
    groupLabel,
    groupOptions,
    groupSources,
    isFiltering,
    mutableIds,
    splitGroups,
    tally,
} from './sourceFilter.js'
import { createSourcesCache } from './sourcesCache.js'

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

// ---------------------------------------------------------------- 书源缓存

/*
 * 用法与 `loadShelf` / `invalidateShelf` 一致，但底层多一层 `sourcesCache`：
 * 书源列表是**全部署共用**的（`sources` 表没有 owner 列），会话之外也会变 ——
 * 另一个标签页改了它，或者阅读时书源自己跑了 `putLoginHeader`。
 * 所以它要的是一个兜底时限，而不是「一直用到下次在本页改动为止」。
 */
const sourcesCache = createSourcesCache(() => api('/api/sources'))

export const loadSources = () => sourcesCache.load()
export const invalidateSources = () => sourcesCache.invalidate()

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

    // ---- 数据：导出 / 导入备份 ----
    const backupFile = el('input', { type: 'file', accept: '.json,application/json' })
    const backupStatus = el('div')
    const backupSubmit = el('button', { class: 'btn', type: 'button', text: '导入这份备份' })
    backupSubmit.onclick = async () => {
        const file = backupFile.files?.[0]
        backupStatus.replaceChildren()
        if (!file) {
            backupStatus.replaceChildren(alertBox('error', '先选一份备份文件'))
            return
        }
        backupSubmit.disabled = true
        backupSubmit.textContent = '导入中…'
        try {
            const result = await importBackupFile(file)
            const imported = result?.imported ?? {}
            invalidateShelf()
            backupFile.value = ''
            backupStatus.replaceChildren(
                alertBox(
                    'ok',
                    '导入完成',
                    [
                        `书架新增 ${imported.shelf ?? 0} 本`,
                        `进度写入 ${imported.progress ?? 0} 条（本地更新的 ${imported.progressKept ?? 0} 条保留）`,
                        `书签新增 ${imported.bookmarks ?? 0} 条（已在库里的 ${imported.bookmarksKept ?? 0} 条跳过）`,
                        `笔记新增 ${imported.notes ?? 0} 条（已在库里的 ${imported.notesKept ?? 0} 条跳过）`,
                    ].join('；'),
                ),
            )
        } catch (err) {
            backupStatus.replaceChildren(alertBox('error', '没能导入备份', err.message))
        } finally {
            backupSubmit.disabled = false
            backupSubmit.textContent = '导入这份备份'
        }
    }

    const backupCard = card(
        '数据（导出 / 导入）',
        el('p', {
            class: 'muted tiny',
            text: '一份备份包含书架、阅读进度、书签与笔记。换设备、换部署，或者从别的账号搬过来，都用它。',
        }),
        el('div', { class: 'row' }, [
            el('a', {
                class: 'btn primary',
                href: '/api/backup',
                text: '导出备份',
                title: '下载一个 JSON 文件（文件名带日期）',
            }),
        ]),
        el('p', {
            class: 'muted tiny',
            text: '只想把书签导成一份能读的清单？这里有一份全部书签的 Markdown / CSV（在阅读界面的书签面板里还能只导当前这本）。',
        }),
        el('div', { class: 'row' }, [
            el('a', {
                class: 'btn ghost',
                href: '/api/export/bookmarks?format=md',
                text: '书签清单 .md',
                title: '按书分组，带摘录与备注',
            }),
            el('a', {
                class: 'btn ghost',
                href: '/api/export/bookmarks?format=csv',
                text: '书签清单 .csv',
                title: '带 BOM，Excel 双击不乱码',
            }),
        ]),
        el('label', { class: 'field' }, [
            el('span', { class: 'field-label', text: '导入' }),
            backupFile,
        ]),
        el('p', {
            class: 'muted tiny',
            text: '导入是「只增不改」：书架里已有的不动；阅读进度按谁更新取，所以旧备份不会把读到的新章节倒回去；同一份文件导两次也不会变两倍。',
        }),
        el('p', {
            class: 'muted tiny',
            text: '替换净化规则不在备份里（它整份存在本机，改一条要立刻重排正文）。要把它带到别的设备，去阅读界面的「显示设置 → 替换净化 → 账号同步」上传 / 取回。',
        }),
        backupSubmit,
        backupStatus,
    )

    setChildren(host, [
        el('h1', { text: '账号' }),
        card('显示名', nameForm),
        card('密码', passwordForm),
        backupCard,
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
                        // 搜索结果与换源索引都是上一个人的数据，同页换账号会串味
                        forgetSearch()
                        toast('已退出登录')
                        go('#/login')
                    },
                }),
            ]),
        ),
    ])
}

// ---------------------------------------------------------------- 关于

/**
 * 关于：版本 + 更新记录
 *
 * 「更新记录」的正文由 `/api/version` 给（书在 `src/changelog.ts`），**不在前端再抄一份**：
 * 版本号的唯一出处是部署时的 `ENGINE_VERSION`，前端另存一份就会与它漂移，
 * 而「界面写着 0.53、实际跑着 0.52」这种故障不报错，只会让人对着错的版本排查。
 *
 * 这一页**不要求登录**（见 `app.js` 的 `render`）：它回答的是「这台部署跑的是哪一版」，
 * 与有没有账号无关 —— 而刚打开应用、还没登录的人，恰恰最可能想先确认这一点。
 */
export async function viewAbout(host) {
    setChildren(host, [
        el('h1', { class: 'page-title', text: '关于' }),
        skeletonBlock('正在读取版本…'),
    ])

    let info
    try {
        info = await loadVersion()
    } catch (err) {
        setChildren(host, [
            el('h1', { class: 'page-title', text: '关于' }),
            alertBox('error', '读不到版本信息', err.message),
        ])
        return
    }

    const releases = info.changelog ?? []

    setChildren(host, [
        el('h1', { class: 'page-title', text: '关于' }),
        el('section', { class: 'card' }, [
            el('h2', { text: '版本' }),
            el('p', { class: 'about-version', text: `书源阅读器 v${info.version}` }),
            el('p', {
                class: 'muted tiny',
                text: '这个号在部署时写进环境变量（ENGINE_VERSION），下面那份记录跟着它走。',
            }),
        ]),
        el('section', { class: 'card' }, [
            el('h2', { text: `更新记录（${releases.length} 版）` }),
            el('div', { class: 'releases' }, releases.map(releaseRow)),
        ]),
        el('section', { class: 'card' }, [
            el('h2', { text: '许可' }),
            el('p', {
                class: 'muted tiny',
                text: '本程序按 AGPL-3.0-or-later 发布。页脚的「源代码」是仓库地址 —— 通过网络使用它的任何人都能拿到源码。',
            }),
        ]),
    ])
}

/** 更新记录里的一条：版本号 + 日期 + 一句话 */
function releaseRow(release) {
    return el('div', { class: 'release' }, [
        el('div', { class: 'release-head' }, [
            el('strong', { text: `v${release.version}` }),
            el('span', { class: 'muted tiny', text: release.date }),
        ]),
        el('p', { class: 'release-note', text: release.note }),
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
            coverNode(coverSrc(book), book.name, 'cover'),
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
                        coverNode(coverSrc(entry), entry.name, 'cover small'),
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
                    coverNode(coverSrc(book), book.name, 'cover tile'),
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
                        coverNode(coverSrc(entry), entry.name, 'cover'),
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
 *
 * 这一轮又加了一层**分组**：按名字搜的前提是记得住名字，而「我记得是那本漫画的源」
 * 这种话只能靠分组答上来。分组下拉与「书源」页用的是同一个（`groupSelect`）。
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

    const state = { keyword: '', group: GROUP_ALL }
    const search = el('input', {
        type: 'search',
        class: 'picker-search',
        placeholder: `在 ${sources.length} 个书源里搜索…`,
        oninput: () => {
            state.keyword = search.value
            renderList()
        },
        onkeydown: (event) => {
            if (event.key === 'Escape') close()
        },
    })
    const groupSelectNode = groupSelect(sources, state.group, (value) => {
        state.group = value
        renderList()
    })

    const list = el('div', { class: 'picker-list', role: 'listbox' })
    const panel = el('div', { class: 'picker-panel', hidden: true }, [
        search,
        groupSelectNode,
        list,
    ])
    const wrap = el('div', { class: 'picker' }, [button, panel])

    function renderList() {
        fillPickerList(list, sources, state, (source) =>
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
                    // 第一个标签已经在分组头里写着，这里只补其余的（见 `sourceRowNode`）
                    ...splitGroups(source.group)
                        .slice(1)
                        .map((name) => el('span', { class: 'badge ghost', text: name })),
                ],
            ),
        )
    }

    function open() {
        panel.hidden = false
        button.classList.add('open')
        renderList()
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

/**
 * 把书源清单画进一个选择面板：**分组头 + 条目**
 *
 * 发现页那个下拉与搜索页的「搜索范围」共用这里 —— 两处的清单形状一样，
 * 差的只是条目本身：一个是单选的按钮，一个是多选的勾选框。所以 `renderItem`
 * 由调用方给。
 *
 * 分组头用普通 `<div>` 而不是 `<details>`：面板本身就是个定高的滚动浮层，
 * 再嵌一层折叠只会让人多点一次，而展开的那一列本来就不长。
 */
function fillPickerList(host, sources, options, renderItem) {
    const groups = groupSources(sources, options)
    if (groups.length === 0) {
        host.replaceChildren(el('p', { class: 'muted tiny', text: '没有匹配的书源' }))
        return
    }
    const nodes = []
    for (const group of groups) {
        nodes.push(
            el('div', { class: 'picker-group-head' }, [
                el('span', { class: 'picker-group-name', text: groupLabel(group.name) }),
                el('span', { class: 'muted tiny', text: `${group.items.length} 条` }),
            ]),
        )
        for (const one of group.items) nodes.push(renderItem(one))
    }
    host.replaceChildren(...nodes)
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
        const data = await loadSources()
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

/**
 * 上一次搜索的**原始结果**（按源分组的那一份），供返回搜索页时复原
 *
 * 「搜到一本 → 点进去 → 读完一章 → 返回 → 点下一本」是搜索页最高频的用法，
 * 而搜索是**按页花 CPU 额度**的（免费计划每请求 10 ms，见 EXPERIENCE.md「第二十六轮」）。
 * 每次返回都重搜一遍，等于把额度花在重复劳动上，用户还得白等一次。
 *
 * 只留一份、只认关键词：搜索页同一时刻只显示一个关键词的结果，多存几份既看不出区别，
 * 又会让「返回后看到的是不是最新的」变得含糊。重新点「搜索」就会把它换掉。
 */
let searchCache = null

/** 丢掉与「当前登录的人」绑定的搜索缓存 —— 退出登录时必须清，否则换个账号会看到上一个人的结果 */
function forgetSearch() {
    searchCache = null
    mergedIndex.clear()
}

/**
 * 搜索范围的读写（`pref.searchScope`，换行分隔的书源 id）
 *
 * 放在 localStorage 而不是内存里：用户挑好的那几个源，下次打开应用还该是他挑的那些。
 * 换行分隔的理由见 `core.js` 里那个收拢函数。
 */
const readSearchScope = () =>
    String(prefs.get('searchScope') ?? '')
        .split('\n')
        .map((one) => one.trim())
        .filter((one) => one !== '')

const writeSearchScope = (ids) => prefs.set('searchScope', ids.join('\n'))

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
    const scopeHost = el('div', { class: 'row search-scope' })
    const pickerHost = el('div', { class: 'search-picker', hidden: true })

    /**
     * 搜索状态放在**视图作用域**（而不再是 `run()` 里）
     *
     * 因为「返回搜索页」要能复原上一次的结果，就得让 `paint()` 有一份可复用的状态。
     */
    let keyword = lastKeyword
    let entries = []
    let perSource = []
    let searched = 0
    let totalSources = 0
    let pageLimit = SEARCH_PAGE_SIZE
    let busy = false

    /**
     * 能搜的书源 —— 选范围时的候选
     *
     * 用 `loadSources()`（「书源」页那份缓存），切过来不会多打一次请求。
     * 读不到也不影响「搜全部」那条路，所以只记下错误，不中断整个页面。
     */
    let pickable = []
    let sourcesError = ''
    try {
        pickable = searchableSources((await loadSources())?.sources ?? [])
    } catch (err) {
        sourcesError = err.message
    }

    /** 用户指定的搜索范围；空数组 = 不限定，按健康度一页一页来 */
    let selected = normalizeSelection(readSearchScope(), pickable)

    /** 范围那一行：显示当前范围 + 开合选择面板 + 一键清除 */
    function paintScope() {
        // 走 `setChildren` 而不是原生 `replaceChildren`：最后一个占位是 `? … : null`，
        // 原生的那个会把 null 变成文本 "null" 渲染出来（见 `test/dom.test.mjs`）
        setChildren(scopeHost, [
            el('span', { class: 'muted tiny', text: '搜索范围：' }),
            el('strong', {
                class: 'scope-value',
                text: selected.length > 0 ? `指定 ${selected.length} 个书源` : '全部书源',
            }),
            el('div', { class: 'spacer' }),
            el('button', {
                class: 'btn sm ghost',
                text: pickerHost.hidden ? '选择书源' : '收起',
                onclick: () => {
                    pickerHost.hidden = !pickerHost.hidden
                    if (pickerHost.hidden) pickerHost.replaceChildren()
                    else paintPicker()
                    paintScope()
                },
            }),
            selected.length > 0
                ? el('button', {
                      class: 'btn sm ghost',
                      text: '清除',
                      onclick: () => applySelection([]),
                  })
                : null,
        ])
    }

    /**
     * 书源选择面板
     *
     * 面板里改的是**草稿**，点「完成」才生效 —— 勾一个就重搜一次，既费额度，
     * 也让「勾了三个源结果搜了三遍」这种事发生。
     *
     * 候选有 800 多个，所以除了关键词还给了**分组**与「全选筛选结果」：
     * 「只搜快速书源这一组」是一句话的事，而不点这个按钮就得手动勾 227 下。
     */
    function paintPicker() {
        // 复用「换源」那套 `.picker-*` 样式（见 style.css）：书源清单的形状完全一样
        const filter = el('input', {
            class: 'picker-search',
            type: 'search',
            placeholder: '按名字或分组筛',
            oninput: () => paintList(),
        })
        const state = { keyword: '', group: GROUP_ALL }
        const groupSelectNode = groupSelect(pickable, state.group, (value) => {
            state.group = value
            paintList()
        })
        const listHost = el('div', { class: 'picker-list' })
        const foot = el('div', { class: 'row picker-foot' })
        let draft = [...selected]
        let matched = []

        function paintFoot() {
            setChildren(foot, [
                el('span', { class: 'muted tiny', text: `已选 ${draft.length} 个` }),
                el('div', { class: 'spacer' }),
                el('button', {
                    class: 'btn sm ghost',
                    text: `全选这 ${matched.length} 个`,
                    title: '把当前筛出来的书源全勾上',
                    hidden: matched.length === 0,
                    onclick: () => {
                        for (const one of matched) {
                            const id = String(one.id)
                            if (!draft.includes(id)) draft.push(id)
                        }
                        paintList()
                    },
                }),
                el('button', {
                    class: 'btn sm ghost',
                    text: '清空',
                    hidden: draft.length === 0,
                    onclick: () => {
                        draft = []
                        paintList()
                    },
                }),
                el('button', {
                    class: 'btn sm primary',
                    text: '完成',
                    onclick: () => {
                        pickerHost.hidden = true
                        pickerHost.replaceChildren()
                        applySelection(draft)
                    },
                }),
            ])
        }

        function paintList() {
            state.keyword = filter.value
            matched = filterSources(pickable, state)
            fillPickerList(listHost, pickable, state, (one) =>
                el('label', { class: 'picker-item' }, [
                    el('input', {
                        type: 'checkbox',
                        checked: draft.includes(String(one.id)),
                        onchange: (event) => {
                            const id = String(one.id)
                            if (event.target.checked) {
                                if (!draft.includes(id)) draft.push(id)
                            } else {
                                draft = draft.filter((item) => item !== id)
                            }
                            paintFoot()
                        },
                    }),
                    el('span', { class: 'picker-item-name', text: one.name }),
                    // 第一个标签已经在分组头里写着，这里只补其余的（见 `sourceRowNode`）
                    ...splitGroups(one.group)
                        .slice(1)
                        .map((name) => el('span', { class: 'badge ghost', text: name })),
                ]),
            )
            paintFoot()
        }

        if (sourcesError !== '') {
            setChildren(pickerHost, [alertBox('warn', '读不到书源清单，只能搜全部', sourcesError)])
            return
        }
        if (pickable.length === 0) {
            setChildren(pickerHost, [el('p', { class: 'muted tiny', text: '没有可搜的书源。' })])
            return
        }
        setChildren(pickerHost, [filter, groupSelectNode, listHost, foot])
        paintList()
    }

    /** 定下新的范围：存下来、作废旧结果，并按新范围重搜一次 */
    function applySelection(next) {
        const before = selected.join('\n')
        selected = normalizeSelection(next, pickable)
        writeSearchScope(selected)
        paintScope()
        if (before === selected.join('\n')) return

        searchCache = null
        if (keyword !== '') void run()
        else resultHost.replaceChildren()
    }

    host.replaceChildren(
        el('h1', { class: 'page-title', text: '搜索' }),
        el('div', { class: 'card search-bar' }, [
            el('div', { class: 'row' }, [
                el('div', { class: 'spacer' }, [input]),
                el('button', { class: 'btn primary', text: '搜索', onclick: () => run() }),
            ]),
            el('p', {
                class: 'muted tiny',
                text: '默认一次搜一批书源（先从最可能出结果的开始），要更多就点「继续加载」；也可以指定几个书源，只搜它们。',
            }),
            scopeHost,
            pickerHost,
        ]),
        resultHost,
    )
    paintScope()

    /** 书架状态：卡片上的「已加入」和「优先读哪个源」都看它。读不到不影响搜索 */
    try {
        entries = await loadShelf()
    } catch {
        /* 忽略：卡片会一律按未加入显示 */
    }

    /**
     * 拉一页
     *
     * 一个请求只搜一页（`SEARCH_PAGE_SIZE` 个源）：免费计划每个请求只有 10 ms CPU，
     * 一次把全部书源读出来再求值必然被掐（见 searchPlan.js 与 EXPERIENCE.md「第二十六轮」）。
     * 被掐时**不换时刻重试** —— 线上实测额度恢复得很慢，紧接着再发照样被掐 ——
     * 而是把这一页**折半**再试，一路折到 1 个源。
     *
     * **指定了书源就换一条路**：一次把用户选的那几个发过去（`sourceIds`），
     * 而且**不折半** —— 范围是用户定的，少搜一个就不是他要的结果了，宁可报错让他重来。
     */
    async function loadPage() {
        const scoped = selected.length > 0
        for (;;) {
            try {
                const data = await postJson(
                    '/api/search',
                    scoped
                        ? { keyword, sourceIds: [...selected] }
                        : { keyword, offset: searched, limit: pageLimit },
                )
                totalSources = data.totalSources ?? searched + (data.searched ?? 0)
                perSource.push(...(data.sources ?? []))
                searched += data.searched ?? 0
                remember()
                return
            } catch (err) {
                if (!scoped && isCpuLimitError(err) && pageLimit > SEARCH_MIN_PAGE) {
                    pageLimit = nextPageSize(pageLimit)
                    continue
                }
                throw err
            }
        }
    }

    /** 每页回来就记一次缓存：返回搜索页时直接摆出来，一个请求都不发 */
    function remember() {
        searchCache = {
            keyword,
            perSource,
            searched,
            totalSources,
            pageLimit,
            selected: [...selected],
        }
    }

    /** 继续加载：用户点一次才花一批额度 */
    async function loadMore() {
        if (busy) return
        busy = true
        paint(true)
        try {
            await loadPage()
        } catch (err) {
            toast(`继续加载失败：${err.message}`)
        } finally {
            busy = false
            paint(true)
        }
    }

    /**
     * 边搜边画
     *
     * 分片之后一次搜索是几十个请求，等全部跑完再画的话界面要空着几十秒
     * （而且线上有一部分片注定会被 CPU 限额掐掉，全等完等于白等）。
     * 每片回来就重画一次，用户看到的是结果在往下长；重画本身有成本
     * （要重新合并、重建卡片），所以按 200 ms 节流，最后再补一次强制渲染。
     */
    let lastPaint = 0
    const paint = (force) => {
        const now = Date.now()
        if (!force && now - lastPaint < 200) return
        lastPaint = now

        const data = {
            keyword,
            sourceCount: totalSources,
            totalBooks: perSource.reduce((sum, per) => sum + (per.count ?? 0), 0),
            sources: perSource,
        }

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
                text:
                    `已搜 ${data.sources.length}/${data.sourceCount} 个书源，` +
                    `命中 ${data.totalBooks} 本；按书合并后是 ${merged.length} 本`,
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
            // 这一页没搜到。还有源没搜时不说死「没搜到」——
            // 下一步该做的是点下面的「继续加载」
            const more = searched < totalSources
            blocks.push(
                emptyState(
                    more ? '这一批没有结果' : '没搜到',
                    more
                        ? '换个关键词试试；也可以点下面的「继续加载」搜后面的书源。'
                        : '换个关键词试试；也可以到「书源」里看看启用的源是不是都被停用了。',
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

        // 还有源没搜就摆一个「继续加载」—— 额度由用户点一次花一批
        if (searched < totalSources) {
            blocks.push(
                el('div', { class: 'load-more' }, [
                    el('button', {
                        class: 'btn',
                        text: busy
                            ? '加载中…'
                            : `继续加载（还有 ${totalSources - searched} 个书源）`,
                        onclick: () => void loadMore(),
                    }),
                ]),
            )
        }

        resultHost.replaceChildren(...blocks)
    }

    async function run() {
        const next = input.value.trim()
        if (next === '') {
            resultHost.replaceChildren(alertBox('warn', '先输入关键词'))
            return
        }
        lastKeyword = next
        keyword = next
        // 换关键词 = 上一次的结果作废；第一批回来后 `remember()` 会把缓存重新填上
        searchCache = null
        perSource = []
        searched = 0
        totalSources = 0
        pageLimit = SEARCH_PAGE_SIZE
        busy = false
        resultHost.replaceChildren(skeletonList(4, 'grid'))

        try {
            await loadPage()
        } catch (err) {
            resultHost.replaceChildren(alertBox('error', '搜索失败', err.message))
            return
        }
        if (searched === 0 && totalSources === 0) {
            resultHost.replaceChildren(
                alertBox('warn', '没有可用的书源', '一份书源都没有，或者都被停用了。'),
            )
            return
        }
        paint(true)
    }

    /**
     * 进来先把上一次的结果摆出来
     *
     * 这一步是**不发请求**的：结果、页码、`继续加载` 的进度全在上次的缓存里。
     * 想重新搜一遍，点上面的「搜索」或者回车就行。
     */
    if (searchCache) {
        keyword = searchCache.keyword
        perSource = searchCache.perSource
        searched = searchCache.searched
        totalSources = searchCache.totalSources
        pageLimit = searchCache.pageLimit
        // 缓存里的范围优先于偏好里那份：缓存代表的就是「屏幕上这批结果是按哪个范围搜的」
        if (Array.isArray(searchCache.selected)) {
            selected = normalizeSelection(searchCache.selected, pickable)
            paintScope()
        }
        input.value = keyword
        paint(true)
    } else if (lastKeyword !== '') {
        await run()
    }
    input.focus()
}

// ---------------------------------------------------------------- 书源管理

/**
 * 一次铺开多少行之内就把分组都展开
 *
 * 线上那份语料是 816 条。全展开意味着一次性建八千多个节点，手机上要等几秒才出得来，
 * 而多数时候用户只想看某一组。超过这个数就先把分组收起来，界面上一开始只有十几个
 * 分组头（各自带着条数），点哪组展开哪组 —— 行是**点开那一刻才建**的。
 */
const SOURCE_EXPAND_LIMIT = 120

export async function viewSources(host) {
    host.replaceChildren(el('h1', { class: 'page-title', text: '书源' }), skeletonList(3))

    let data
    try {
        data = await loadSources()
    } catch (err) {
        host.replaceChildren(
            el('h1', { class: 'page-title', text: '书源' }),
            alertBox('error', '读取失败', err.message),
        )
        return
    }

    let sources = data.sources ?? []
    let counts = tally(sources)

    /** 筛选条件就地改，改完只重画列表 —— 整页重来会把刚敲进搜索框的字一起清掉 */
    const state = { ...DEFAULT_FILTER }

    const listHost = el('div', { class: 'source-groups' })
    const tallyHost = el('p', { class: 'muted tiny source-tally' })
    const bulkHost = el('div', { class: 'row tight source-bulk' })
    const controlsHost = el('div', { class: 'source-controls' })
    const toolbar = el('div', { class: 'card source-toolbar' }, [controlsHost, tallyHost, bulkHost])

    // 由 `paintControls()` 填，`paint()` 读 —— 书源清单变了（导入 / 删除）要一起重建：
    // 分组下拉的选项与各档上的条数都跟着变
    let statusChips = null
    let abilityChips = null
    let groupSelectNode = null
    let resetButton = null

    /**
     * 重新取一份书源清单，并在**原地**重画
     *
     * 为什么不整页重来：导入卡片里刚显示的「新增 N 条，更新 M 条」会被重渲染直接冲掉 ——
     * 用户什么都看不到（这是原先的实情）。只重画列表与控制条，报告就留得下来。
     */
    async function refetch() {
        invalidateSources()
        try {
            sources = (await loadSources()).sources ?? []
        } catch {
            /* 读不到就沿用手里这份：界面不至于空掉，下次操作还会再试一次 */
        }
        counts = tally(sources)
        paintControls()
        paint()
    }

    /** 筛选控件（随清单一起重建，理由见 `refetch`） */
    function paintControls() {
        const keywordBox = el('input', {
            type: 'search',
            class: 'source-search',
            placeholder: '按名字或分组筛',
            value: state.keyword,
            oninput: (event) => {
                state.keyword = event.target.value
                paint()
            },
        })
        groupSelectNode = groupSelect(sources, state.group, (value) => {
            state.group = value
            paint()
        })
        statusChips = chipRow(
            [
                [STATUS_ALL, `全部 ${counts.total}`],
                [STATUS_ON, `已启用 ${counts.on}`],
                [STATUS_OFF, `已停用 ${counts.off}`],
            ],
            (value) => {
                state.status = value
                paint()
            },
        )
        abilityChips = chipRow(
            [
                [ABILITY_ALL, '不限能力'],
                [ABILITY_SEARCH, `可搜索 ${counts.search}`],
                [ABILITY_EXPLORE, `可发现 ${counts.explore}`],
                [ABILITY_LOGIN, `可登录 ${counts.login}`],
            ],
            (value) => {
                state.ability = value
                paint()
            },
        )
        resetButton = el('button', {
            class: 'btn sm ghost',
            text: '清空筛选',
            onclick: () => {
                Object.assign(state, DEFAULT_FILTER)
                keywordBox.value = ''
                paint()
            },
        })

        setChildren(controlsHost, [
            el('div', { class: 'row source-filter-main' }, [
                keywordBox,
                groupSelectNode,
                resetButton,
            ]),
            el('div', { class: 'row tight source-filter-sub' }, [
                statusChips.node,
                abilityChips.node,
            ]),
        ])
    }

    function paint() {
        const matched = filterSources(sources, state)
        const filtering = isFiltering(state)

        tallyHost.textContent = filtering
            ? `筛出 ${matched.length} 条 / 共 ${sources.length} 条`
            : `${sources.length} 条 · 已启用 ${counts.on} · 可搜索 ${counts.search} · 书源是全局的，所有人共用`

        statusChips.sync(state.status)
        abilityChips.sync(state.ability)
        groupSelectNode.value = state.group
        resetButton.hidden = !filtering
        toolbar.hidden = sources.length === 0

        setChildren(
            listHost,
            matched.length === 0
                ? [
                      emptyState(
                          filtering ? '没有匹配的书源' : '还没有书源',
                          filtering
                              ? '换个关键词，或者把筛选条件清掉。'
                              : '导入一份 Legado 书源 JSON 就能开始用。',
                      ),
                  ]
                : groupSources(sources, state).map((group) =>
                      sourceGroupNode(group, matched.length <= SOURCE_EXPAND_LIMIT, refetch),
                  ),
        )
        setChildren(bulkHost, bulkBar(matched, refetch))
    }

    paintControls()
    setChildren(host, [
        el('h1', { class: 'page-title', text: '书源' }),
        renderImport(refetch),
        toolbar,
        listHost,
    ])
    paint()
}

/**
 * 分组下拉
 *
 * 用 `<select>` 而不是一排 chips：分组有十几个（线上语料 16 个 + 未分组），
 * 铺成 chips 就是一面药丸墙，还会把下面的列表顶下去一大截。
 *
 * 条数拿**未筛选**的那份算（`groupOptions` 的注释里有理由）。
 */
function groupSelect(sources, value, onChange) {
    const options = groupOptions(sources)
    const select = el(
        'select',
        {
            class: 'group-select',
            title: '按分组筛',
            onchange: (event) => onChange(event.target.value),
        },
        [
            el('option', { value: GROUP_ALL, text: `全部分组 ${sources.length}` }),
            ...options.map(({ name, count }) =>
                el('option', { value: name, text: `${groupLabel(name)} ${count}` }),
            ),
        ],
    )
    // 选中的那一组可能已经不在清单里了（比如书源被删光了）：落回「全部分组」，
    // 否则 `<select>` 会停在一个不存在的选项上，`value` 变成空串
    const known = new Set(options.map((one) => one.name))
    select.value = value === GROUP_ALL || known.has(value) ? value : GROUP_ALL
    return select
}

/**
 * 一排档位按钮（「全部 / 已启用 / 已停用」这种）
 *
 * 就地改 `active` 而不是重建节点：这一排挂在筛选条上，重建会把键盘焦点和 hover
 * 一起丢掉 —— 输入框那侧更明显，每敲一个字就重来一次。
 */
function chipRow(items, onPick) {
    const buttons = new Map()
    const row = el('div', { class: 'row tight chip-row' })
    for (const [value, label] of items) {
        const button = el('button', {
            class: 'chip',
            type: 'button',
            text: label,
            onclick: () => onPick(value),
        })
        buttons.set(value, button)
        row.append(button)
    }
    const sync = (current) => {
        for (const [value, button] of buttons) {
            const active = value === current
            button.classList.toggle('active', active)
            button.setAttribute('aria-pressed', active ? 'true' : 'false')
        }
    }
    return { node: row, sync }
}

/**
 * 一个分组：分组头 + 这一组的行
 *
 * 行**点开才建**（`fill`）。收起的分组一个节点都不建 —— 816 条全铺开是八千多个节点，
 * 而用户多数时候只看其中一组。
 */
function sourceGroupNode({ name, items }, open, reload) {
    const body = el('div', { class: 'source-list' })
    const details = el('details', { class: 'source-group', open }, [
        el('summary', { class: 'source-group-head' }, [
            el('span', { class: 'source-group-name', text: groupLabel(name) }),
            el('span', { class: 'badge ghost', text: `${items.length} 条` }),
        ]),
        body,
    ])

    const fill = () => {
        if (body.childElementCount > 0) return
        for (const source of items) body.append(sourceRowNode(source, reload))
    }
    if (open) fill()
    details.addEventListener('toggle', () => {
        if (details.open) fill()
    })
    return details
}

/**
 * 一行书源 + 它下面的登录面板
 *
 * 行上的分组徽章**只显示第一个标签之外的**：第一个标签已经在分组头里写着
 * （见上方分组渲染），每行再重复一遍就是一片噪音。多值字段的其余标签照样显示，
 * 信息没丢。筛选时所有标签都参与匹配，那件事在 `sourceFilter.js` 里。
 */
function sourceRowNode(source, reload) {
    const panel = el('div', { class: 'login-slot', hidden: true })
    let panelOpen = false
    // 「现在是不是已登录」—— 面板里按完按钮会就地更新它，不必整页重渲染
    //（用户常常要连着按两三个：先「获取验证码」，再「登录」）
    const stateBadge = source.hasLogin
        ? el('span', {
              class: `badge ${source.loggedIn ? 'ok' : 'ghost'}`,
              text: source.loggedIn ? '已登录' : '未登录',
          })
        : null
    const extraGroups = splitGroups(source.group).slice(1)

    const row = el('article', { class: 'source-row' }, [
        el('div', { class: 'source-main' }, [
            el('h3', { class: 'source-name', text: source.name }),
            el('p', { class: 'source-meta' }, [
                el('span', { class: 'badge', text: typeLabel(source.type) }),
                ...extraGroups.map((name) => el('span', { class: 'badge ghost', text: name })),
                source.hasSearch ? el('span', { class: 'badge ok', text: '可搜索' }) : null,
                source.hasExplore ? el('span', { class: 'badge ok', text: '可发现' }) : null,
                stateBadge,
                source.builtin ? el('span', { class: 'badge ghost', text: '内置' }) : null,
            ]),
        ]),
        el('div', { class: 'source-actions' }, [
            source.hasLogin
                ? el('button', {
                      class: 'btn sm ghost',
                      text: '登录',
                      onclick: () => {
                          panelOpen = !panelOpen
                          panel.hidden = !panelOpen
                          // 只在第一次展开时读一次界面：每次点都重读会把已经填好的
                          // 账号密码清掉
                          if (panelOpen && panel.childElementCount === 0) {
                              void renderLoginPanel(panel, source, stateBadge)
                          }
                      },
                  })
                : null,
            /**
             * 开关只在**能改的**源上出现
             *
             * 内置测试源是只读的（代码的一部分，库里没有对应行，服务端 `assertUserSource`
             * 会拒），原先也给它画了个开关 —— 点下去只会弹一句「内置书源不能修改」。
             * 画一个必然失败的控件比不画更糟。
             */
            source.builtin
                ? null
                : el(
                      'label',
                      { class: 'switch', title: source.enabled ? '点击停用' : '点击启用' },
                      [
                          el('input', {
                              type: 'checkbox',
                              checked: source.enabled,
                              onchange: async (event) => {
                                  const enabled = event.target.checked
                                  try {
                                      /**
                                       * 必须走 **PATCH**
                                       *
                                       * `POST /api/sources` 是**导入**那条路由（请求体是书源 JSON），
                                       * 拿 `{ id, enabled }` 打过去只会得到一句「导入内容必须是书源数组」。
                                       * 这个开关早先就是这么坏的 —— 看着能点，一点就报一个莫名其妙的错，
                                       * 于是「书源怎么不能停用」成了一个查不出来的现象。
                                       */
                                      await patchJson('/api/sources', { id: source.id, enabled })
                                      invalidateSources()
                                      toast(
                                          enabled
                                              ? `已启用：${source.name}`
                                              : `已停用：${source.name}`,
                                      )
                                      await reload()
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
                              await api(`/api/sources?id=${encodeURIComponent(source.id)}`, {
                                  method: 'DELETE',
                              })
                              toast(`已删除：${source.name}`)
                              await reload()
                          } catch (err) {
                              toast(`删除失败：${err.message}`, 'error')
                              event.target.disabled = false
                          }
                      },
                  }),
        ]),
    ])
    return el('div', { class: 'source-item' }, [row, panel])
}

/**
 * 批量启用 / 停用（作用于**当前筛出来的那一批**）
 *
 * 这是「分组」真正的用处：想只留「快速书源」那 227 条，就得有个一次改一批的办法。
 * 逐条发请求的话，点一下要等两百多次往返 —— 中途断一次还不知道改到哪儿了。
 * 所以服务端那条 PATCH 也认 `ids` 数组（见 `src/index.ts`）。
 */
function bulkBar(matched, reload) {
    const ids = mutableIds(matched)
    if (ids.length === 0) return []

    const action = (label, enabled, style) =>
        el('button', {
            class: `btn sm ${style}`,
            text: label,
            onclick: async (event) => {
                const verb = enabled ? '启用' : '停用'
                if (!confirm(`把当前这 ${ids.length} 条书源全部${verb}？`)) return
                event.target.disabled = true
                try {
                    const report = await patchJson('/api/sources', { ids, enabled })
                    toast(`已${verb} ${report.changed ?? ids.length} 条`)
                    await reload()
                } catch (err) {
                    toast(`${verb}失败：${err.message}`, 'error')
                    event.target.disabled = false
                }
            },
        })

    return [
        el('span', { class: 'muted tiny', text: `当前筛选 ${ids.length} 条` }),
        el('div', { class: 'spacer' }),
        action('全部启用', true, 'primary'),
        action('全部停用', false, 'ghost'),
    ]
}

function typeLabel(type) {
    return { 0: '文本', 1: '音频', 2: '图片', 3: '文件' }[type] ?? '文本'
}

/**
 * 书源的**登录面板**
 *
 * 界面由书源自己写的 `loginUi` 决定（`GET /api/sources/login-ui`，语料 35 条源有），
 * 这里如实渲染它说的控件：
 *
 *   `text` / `password` → 输入框
 *   带 `chars` 的（`select` 与 `toggle` 都是）→ 下拉
 *   `button` 的 `action` 是**函数名** → 调 `/api/sources/login-action`（App 里也是这么做的：
 *     那些「获取验证码」「切换线路」「检测登录态」都挂在按钮上，不点它就用不了）
 *   `button` 的 `action` 是 http 地址 → 新开标签页
 *   `button` 的 `action` 是空串 → 只当一块说明牌
 *
 * 主按钮「登录」走 `/api/sources/login`：书源写了 `login()` 的话由服务端补上那次调用
 * （见 EXPERIENCE.md 第五十七轮）。**地址型 `loginUrl`**（App 里用 WebView 打开的那种）
 * 会在这一步拿到一句明白话，直接显示出来 —— 不是静默失败。
 */
async function renderLoginPanel(host, source, stateBadge) {
    host.replaceChildren(el('p', { class: 'muted', text: '正在读取登录界面…' }))

    let data
    try {
        data = await api(`/api/sources/login-ui?id=${encodeURIComponent(source.id)}`)
    } catch (err) {
        host.replaceChildren(alertBox('error', '读取登录界面失败', err.message))
        return
    }

    const status = el('div', { class: 'login-status' })
    const inputs = []

    const fieldNodes = (data.fields ?? []).map((field) => {
        // 带 chars 的是下拉（select / toggle 在服务端已经归一成同一个 type）
        const node =
            field.type === 'select'
                ? el(
                      'select',
                      {},
                      (field.chars ?? []).map((one) =>
                          el('option', {
                              value: one,
                              text: one,
                              selected: one === field.default,
                          }),
                      ),
                  )
                : el('input', {
                      type: field.type === 'password' ? 'password' : 'text',
                      autocomplete: 'off',
                  })
        inputs.push({ name: field.name, node })
        return el('label', { class: 'field' }, [
            el('span', {
                class: 'field-label',
                // 未知的 type（语料里有 toggle / input）标出来，别让人以为是我们写错了
                text:
                    field.rawType === field.type ? field.name : `${field.name}（${field.rawType}）`,
            }),
            node,
        ])
    })

    const collect = () => {
        const out = {}
        for (const one of inputs) out[one.name] = one.node.value
        return out
    }

    const show = (result) => {
        if (result?.loggedIn !== undefined && stateBadge) {
            stateBadge.className = `badge ${result.loggedIn ? 'ok' : 'ghost'}`
            stateBadge.textContent = result.loggedIn ? '已登录' : '未登录'
        }
        const message = String(result?.message ?? '').trim()
        status.replaceChildren(
            alertBox(
                result?.loggedIn ? 'ok' : 'warn',
                // 书源自己那句话优先 —— 它比我们清楚登没登上
                message || (result?.loggedIn ? '已登录' : '跑完了，但书源没说结果'),
                result?.loggedIn === undefined
                    ? ''
                    : `登录态：${result.loggedIn ? '已登录' : '未登录'}`,
            ),
        )
    }

    const run = async (event, path, body, label) => {
        const button = event.target
        button.disabled = true
        status.replaceChildren(el('p', { class: 'muted', text: `正在执行「${label}」…` }))
        try {
            const result = await postJson(path, body)
            show(result)
            // 登录态存在书源那一行上（`login_header` / `login_info`），而 `/api/sources`
            // 的 `loggedIn` 就是读那两列 —— 变了必须让缓存作废，
            // 否则离开再回到书源页，徽标还是「未登录」
            if (result?.loggedIn !== undefined) invalidateSources()
        } catch (err) {
            // 这里是「地址型 loginUrl」那句明白话能露出来的地方
            status.replaceChildren(alertBox('error', `「${label}」没成`, err.message))
        } finally {
            button.disabled = false
        }
    }

    const actionNodes = (data.buttons ?? []).map((button) => {
        if (button.url) {
            return el('button', {
                class: 'btn sm ghost',
                text: button.name,
                onclick: () => window.open(button.url, '_blank', 'noopener'),
            })
        }
        if (button.action === '') {
            return el('span', { class: 'badge ghost', text: button.name })
        }
        return el('button', {
            class: 'btn sm ghost',
            text: button.name,
            onclick: (event) =>
                run(
                    event,
                    '/api/sources/login-action',
                    { id: source.id, action: button.action, fields: collect() },
                    button.name,
                ),
        })
    })

    host.replaceChildren(
        el('div', { class: 'login-body' }, [
            fieldNodes.length > 0 ? el('div', { class: 'login-fields' }, fieldNodes) : null,
            data.hasUi === false
                ? el('p', {
                      class: 'muted',
                      text: '这个书源没写登录界面（loginUi）—— 直接点「登录」就行，脚本自己会读它要的东西。',
                  })
                : null,
            data.note
                ? el('p', {
                      class: 'muted',
                      text: `登录界面解析不出控件，原样贴出来：${data.note}`,
                  })
                : null,
            el('div', { class: 'row login-actions' }, [
                el('button', {
                    class: 'btn primary sm',
                    text: '登录',
                    onclick: (event) =>
                        run(
                            event,
                            '/api/sources/login',
                            { id: source.id, fields: collect() },
                            '登录',
                        ),
                }),
                ...actionNodes,
            ]),
            status,
        ]),
    )
}

/**
 * 导入书源
 *
 * 四件小事凑起来，就是「能用」与「好用」的差别：
 *
 * 1. **一次能选多个文件** —— 社区合集常被拆成好几份（`合集(1).json`、`(2)…`），
 *    一次一个地选，选完还得自己记住导到第几个了。
 * 2. **能把文件拖进来** —— 桌面端最顺手的动作，不接就白瞎了。
 * 3. **分批时报进度** —— 几 MB 的合集要切成好几批提交，中间没有反馈的话，用户会
 *    以为卡住了，然后再点一次（于是同一份导两遍）。
 * 4. **导完的报告留得住** —— 报告是画在这张卡片里的，而原先导完会整页重渲染，
 *    把「新增 N 条，更新 M 条」当场冲掉，用户其实什么都没看见（见 `refetch`）。
 *
 * 分组不用在这里操心：Legado 书源自己带着 `bookSourceGroup`，导入之后「书源」页
 * 自动按它归组（多值字段的拆法见 `sourceFilter.js`）。
 */
function renderImport(onDone) {
    const status = el('div', { class: 'import-status' })

    const file = el('input', {
        type: 'file',
        accept: '.json,application/json',
        multiple: true,
        onchange: async (event) => {
            const chosen = [...(event.target.files ?? [])]
            event.target.value = '' // 先清空：选同一个文件两次也要能再触发 change
            if (chosen.length > 0) await runFiles(chosen)
        },
    })
    const textarea = el('textarea', {
        rows: 5,
        placeholder: '把书源 JSON 粘在这里（数组或 {"sources":[…] } 都行）',
    })

    /**
     * 拖放区
     *
     * 只在 `dragover` 上 `preventDefault` 才会收到 `drop` —— 不拦的话浏览器会按
     * 「用这个文件去导航」处理，整页跳走，这个应用连同正在输入的内容一起没了。
     */
    const dropZone = el('label', { class: 'drop-zone' }, [
        el('span', { class: 'drop-hint', text: '把 .json 文件拖到这里，或点这里选文件（可多选）' }),
        file,
    ])
    dropZone.addEventListener('dragover', (event) => {
        event.preventDefault()
        dropZone.classList.add('over')
    })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'))
    dropZone.addEventListener('drop', async (event) => {
        event.preventDefault()
        dropZone.classList.remove('over')
        const dropped = [...(event.dataTransfer?.files ?? [])]
        if (dropped.length > 0) await runFiles(dropped)
    })

    /** 读一批文件，一个接一个地导 —— 并发导只会让进度条变成一团乱麻 */
    async function runFiles(files) {
        for (const [index, one] of files.entries()) {
            const label =
                files.length > 1
                    ? `${one.name}（${index + 1}/${files.length}）`
                    : `文件 ${one.name}`
            const ok = await runImport(await one.text(), label)
            // 一个文件坏了就停下：接着导只会把同一条错误刷上好几遍
            if (!ok) return
        }
        await onDone()
    }

    /** 导一份；成功返回 true（失败时错误已经画在 `status` 上） */
    async function runImport(raw, label) {
        setChildren(status, [el('p', { class: 'muted', text: `正在导入 ${label}…` })])
        try {
            const report = await importChunked(raw, (done, total) => {
                if (total < 2) return
                setChildren(status, [
                    el('p', {
                        class: 'muted',
                        text: `正在导入 ${label}…（第 ${done}/${total} 批）`,
                    }),
                ])
            })
            setChildren(status, [importReport(report)])
            return true
        } catch (err) {
            setChildren(status, [alertBox('error', '导入失败', err.message)])
            return false
        }
    }

    return el('details', { class: 'card import-card' }, [
        el('summary', { text: '导入书源' }),
        el('div', { class: 'import-body' }, [
            el('div', { class: 'row drop-row' }, [dropZone]),
            el('label', { class: 'field' }, [
                el('span', { class: 'field-label', text: '或直接粘贴 JSON' }),
                textarea,
            ]),
            el('div', { class: 'row' }, [
                el('button', {
                    class: 'btn primary',
                    text: '导入粘贴的内容',
                    onclick: async () => {
                        const raw = textarea.value.trim()
                        if (raw === '') {
                            setChildren(status, [alertBox('warn', '先粘贴书源 JSON')])
                            return
                        }
                        if (await runImport(raw, '粘贴的内容')) await onDone()
                    },
                }),
                el('div', { class: 'spacer' }),
                el('button', {
                    class: 'btn ghost',
                    text: '从网址导入',
                    onclick: async () => {
                        const url = prompt('书源 JSON 的网址：', '')
                        if (!url) return
                        setChildren(status, [el('p', { class: 'muted', text: '正在下载…' })])
                        try {
                            const response = await fetch(url, { credentials: 'omit' })
                            if (!response.ok) throw new Error(`HTTP ${response.status}`)
                            if (await runImport(await response.text(), url)) await onDone()
                        } catch (err) {
                            setChildren(status, [
                                alertBox(
                                    'error',
                                    '下载失败',
                                    `${err.message}。如果是跨域限制，请先把文件下载到本地再用上面的文件选择。`,
                                ),
                            ])
                        }
                    },
                }),
            ]),
            status,
        ]),
    ])
}

/** 导入结果：一句话 + 被拒的那些（点开才看原因，正常导入时它不占地方） */
function importReport(report) {
    const rejected = report.rejected ?? []
    const box = alertBox('ok', `导入完成：新增 ${report.imported} 条，更新 ${report.updated} 条`)
    append(box, [
        rejected.length === 0
            ? el('div', {
                  class: 'alert-extra',
                  text: '分组取自书源自带的 bookSourceGroup，已经自动归好组。',
              })
            : el('details', { class: 'failures' }, [
                  el('summary', { text: `${rejected.length} 条被拒（点开看原因）` }),
                  el(
                      'ul',
                      {},
                      rejected
                          .slice(0, 20)
                          .map((one) => el('li', { text: one.reason ?? one.name ?? '未知原因' })),
                  ),
              ]),
    ])
    return box
}

/**
 * 分批导入
 *
 * 导入接口对单次请求体有上限（护住 Worker 内存），而社区合集动辄好几 MB，
 * 一次传不进去。所以按大小切片分批提交，再把结果合并。
 *
 * `onProgress(第几批, 共几批)` 只在真的要分批时才回调 —— 一份 200 KB 的书源
 * 用不着报「第 1/1 批」，那是句废话。
 */
async function importChunked(raw, onProgress) {
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
    const total = Math.ceil(list.length / perBatch)
    let done = 0
    for (let start = 0; start < list.length; start += perBatch) {
        done += 1
        onProgress?.(done, total)
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
        // 地址里可能带着从搜索/书架点进来时的书名作者（见 `bookUrl`），先带上，
        // 详情页算出来之后再补一份更准的 —— 规则里 `book.name` 54 处 / 39 源在用
        const hint = {
            name: route.get('name') ?? '',
            author: route.get('author') ?? '',
            bookUrl: target,
        }
        info = await api(`/api/book?${paramsOf({ sourceId, url: target, ...contextParams(hint) })}`)
        if (info.tocUrl) {
            const toc = await api(
                `/api/toc?${paramsOf({
                    sourceId,
                    url: info.tocUrl,
                    ...contextParams({
                        name: info.name || hint.name,
                        author: info.author || hint.author,
                        bookUrl: target,
                    }),
                })}`,
            )
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
                coverNode(coverSrc(info), name, 'cover large'),
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
