/*
 * 入口：路由与骨架
 *
 * 路由用 hash。除了「不需要服务端配合回退」这个好处，它还让阅读界面能被
 * 直接分享/收藏（`#/read?sourceId=…&url=…`），刷新后仍在原处。
 */

import {
    alertBox,
    applyPrefs,
    claimAnonymous,
    currentUser,
    el,
    go,
    loadSession,
    loadVersion,
    setUnauthorizedHandler,
    toast,
} from './js/core.js'
import { viewRead } from './js/reader.js'
import {
    invalidateShelf,
    viewAbout,
    viewAccount,
    viewBook,
    viewExplore,
    viewHome,
    viewLogin,
    viewSearch,
    viewShelf,
    viewSources,
} from './js/views.js'

const TABS = [
    { route: 'home', label: '首页' },
    { route: 'shelf', label: '书架' },
    { route: 'explore', label: '发现' },
    { route: 'search', label: '搜索' },
    { route: 'sources', label: '书源' },
]

const VIEWS = {
    home: viewHome,
    shelf: viewShelf,
    explore: viewExplore,
    search: viewSearch,
    sources: viewSources,
    book: viewBook,
    read: viewRead,
    account: viewAccount,
    about: viewAbout,
}

function parseRoute() {
    const raw = location.hash.replace(/^#\/?/, '')
    const [path, query] = raw.split('?')
    return { path: path === '' ? 'home' : path, query: query ?? '' }
}

/**
 * 会话失效（401）时把界面切到登录页，而不是让每个视图各自处理
 *
 * `replace`：这是**换个界面**，不是又往前走一页。压历史的话，返回键会退回那个
 * 已经 401 的页面、它再 401、再被送到登录页 —— 返回键就成了原地打转。
 */
setUnauthorizedHandler(() => {
    toast('登录状态已失效，请重新登录', 'error')
    go('#/login', { replace: true })
})

function renderTabs(active) {
    const nav = document.querySelector('#nav')
    nav.replaceChildren(
        ...TABS.map((tab) =>
            el('button', {
                class: `tab ${tab.route === active ? 'active' : ''}`,
                text: tab.label,
                onclick: () => go(`#/${tab.route}`),
            }),
        ),
    )

    const bottom = document.querySelector('#bottom-nav')
    bottom.replaceChildren(
        ...TABS.map((tab) =>
            el(
                'button',
                {
                    class: `bnav-item ${tab.route === active ? 'active' : ''}`,
                    onclick: () => go(`#/${tab.route}`),
                },
                [
                    el('span', { class: `bnav-dot ${tab.route}` }),
                    el('span', { class: 'bnav-label', text: tab.label }),
                ],
            ),
        ),
    )
}

/**
 * 顶栏右上角：进账号页
 *
 * 这里以前是「`显示名 · 退出`，点一下直接退出登录」—— 于是账号页根本不存在，
 * 也就**没有任何入口能改密码**。改成点名字进账号页，退出登录挪进那一页里。
 */
function renderAccount() {
    const slot = document.querySelector('#account')
    const user = currentUser()
    slot.replaceChildren(
        user
            ? el('button', {
                  class: 'btn sm ghost',
                  text: user.displayName,
                  title: '账号设置（显示名 / 密码 / 退出登录）',
                  onclick: () => go('#/account'),
              })
            : el('button', {
                  class: 'btn sm primary',
                  text: '登录',
                  onclick: () => go('#/login'),
              }),
    )
}

// 账号页改了显示名 → 顶栏那份也要跟着变（跨模块，用一个事件解耦）
window.addEventListener('reader:account-changed', renderAccount)

/**
 * 页脚那行版本号
 *
 * **刻意不 `await`**：它只影响页脚一个按钮上的字，不该挡住任何页面。
 * 离线时这个请求必然失败，那时页脚留着占位那两个字，点进去的「关于」页
 * 会自己把失败原因说清楚 —— 在页脚刷一句红字反而更吵。
 */
function renderVersion() {
    const node = document.querySelector('#version')
    if (!node) return
    loadVersion()
        .then((info) => {
            node.textContent = `v${info.version}`
        })
        .catch(() => {
            /* 连不上就先不显示版本，页脚不是报错的地方 */
        })
}

/** 升级提示：本机还有一份匿名书架没并进账号 */
function claimBanner() {
    return el('div', { class: 'claim-banner' }, [
        el('div', {}, [
            el('strong', { text: '本机还留着一份旧书架' }),
            el('p', {
                class: 'muted tiny',
                text: '这是升级到账号之前、按浏览器保存的那一份。并进账号后就能跨设备看到它。',
            }),
        ]),
        el('div', { class: 'spacer' }),
        el('button', {
            class: 'btn primary sm',
            text: '并入账号',
            onclick: async (event) => {
                event.target.disabled = true
                try {
                    const result = await claimAnonymous()
                    invalidateShelf()
                    toast(
                        `已并入：书架 ${result.merged.shelf} 条、进度 ${result.merged.progress} 条`,
                    )
                    await render()
                } catch (err) {
                    toast(`并入失败：${err.message}`, 'error')
                    event.target.disabled = false
                }
            },
        }),
        el('button', {
            class: 'btn ghost sm',
            text: '忽略',
            onclick: (event) => event.target.closest('.claim-banner').remove(),
        }),
    ])
}

async function render() {
    const { path } = parseRoute()
    const host = document.querySelector('#view')
    const shell = document.body

    let session
    try {
        session = await loadSession()
    } catch (err) {
        host.replaceChildren(alertBox('error', '连不上服务', err.message))
        return
    }

    /**
     * 阅读界面全屏：把导航、页脚收起来
     *
     * **必须等会话加载完再判断**。早先这段在 `loadSession()` 之前，
     * 而首次加载时 `currentUser()` 还是 null —— 于是「直接打开或刷新一个阅读链接」
     * 算出来不是阅读页，`data-reader` 停在 0：导航栏留在屏幕上，
     * 而它的 `z-index` 比阅读界面高，**正好盖住阅读界面的顶栏按钮**，
     * 表现为「收藏、目录、设置点了没反应」。从书页点进来时会话已经加载过，
     * 所以只有刷新这一条路径会踩到，特别难自己发现。
     */
    shell.dataset.reader = path === 'read' && session.user ? '1' : '0'

    renderTabs(path)
    renderAccount()
    renderVersion()

    if (!session.user) {
        /**
         * 「关于」在没登录时也要能打开
         *
         * 它回答的是「这台部署跑的是哪一版、最近改了什么」，与有没有账号无关 ——
         * 而刚打开应用、还没登录的人，恰恰最可能想先确认这一点。
         */
        if (path === 'about') {
            renderTabs('')
            host.replaceChildren()
            await viewAbout(host)
            return
        }
        renderTabs('')
        host.replaceChildren()
        await viewLogin(host, path === 'login' ? '' : '先登录，再开始阅读。')
        return
    }

    if (path === 'login') {
        // 已经登录的人落到登录页 = 一次**重定向**，不是一次跳转：用 `replace`，
        // 免得历史里留下「登录页 ←→ 首页」这一对互相弹的入口，返回键按不动
        go('#/home', { replace: true })
        return
    }

    const view = VIEWS[path] ?? viewHome
    host.replaceChildren()
    try {
        await view(host)
    } catch (err) {
        host.replaceChildren(
            alertBox('error', '页面出错', err?.message ?? String(err)),
            el('div', { class: 'row' }, [
                el('button', { class: 'btn ghost', text: '回到首页', onclick: () => go('#/home') }),
            ]),
        )
    }

    if (session.claimable && path !== 'read') {
        host.prepend(claimBanner())
    }
}

// 页脚那个版本号点开是「关于」（版本 + 更新记录）
document.querySelector('#version')?.addEventListener('click', () => go('#/about'))

window.addEventListener('hashchange', render)
window.addEventListener('DOMContentLoaded', () => {
    applyPrefs()
    void render()
})

/**
 * 注册 Service Worker（离线外壳 + 读过的章节，见 `sw.js` 与 `js/swPolicy.js`）
 *
 * 三条原则：
 *   1. **失败不影响任何功能** —— 它只负责「断网还能开」，在线时可有可无。老浏览器
 *      不认 `type: 'module'` 的 SW，注册会抛，这里吞掉（页面照常）。
 *   2. **等 `load` 之后再注册** —— 首屏的带宽先留给样式、脚本和首页数据。
 *   3. 不做「有新版本就弹窗让用户刷新」那一套：这个应用的策略是**网络优先**
 *      （见 `swPolicy.js` 里为什么），新版本下一次打开就是新的，没有「请手动刷新」这一步。
 */
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { type: 'module' }).catch((err) => {
            console.warn('[sw] 注册失败（不影响使用）：', err?.message ?? err)
        })
    })
}
