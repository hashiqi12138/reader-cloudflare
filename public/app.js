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
    setUnauthorizedHandler,
    toast,
} from './js/core.js'
import { viewRead } from './js/reader.js'
import {
    invalidateShelf,
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
}

function parseRoute() {
    const raw = location.hash.replace(/^#\/?/, '')
    const [path, query] = raw.split('?')
    return { path: path === '' ? 'home' : path, query: query ?? '' }
}

/** 会话失效（401）时把界面切到登录页，而不是让每个视图各自处理 */
setUnauthorizedHandler(() => {
    toast('登录状态已失效，请重新登录', 'error')
    go('#/login')
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

    if (!session.user) {
        renderTabs('')
        host.replaceChildren()
        await viewLogin(host, path === 'login' ? '' : '先登录，再开始阅读。')
        return
    }

    if (path === 'login') {
        go('#/home')
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

window.addEventListener('hashchange', render)
window.addEventListener('DOMContentLoaded', () => {
    applyPrefs()
    void render()
})
