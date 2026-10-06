/*
 * 前端基础设施：DOM 构造、接口调用、登录态、偏好、以及几个共用组件。
 *
 * 三条硬规矩：
 * 1. **一律不拼 HTML 字符串**。书名、作者、正文、分类名全来自第三方站点与书源，
 *    用 innerHTML 等于把外部内容当代码执行。所有外部文本都走 textContent（见 el()）。
 * 2. 路由用 hash 而不是 History API：hash 不需要服务端配合回退，
 *    少一处「刷新页面 404」的坑，也省掉一份 SPA 回退配置的维护。
 * 3. **子节点一律走 `el()` / `append()` / `setChildren()`**，不要直接调原生
 *    `replaceChildren()` / `append()`。`null` 与 `undefined` 在原生方法里会被
 *    `String()` 成文本 —— 于是页面上真的渲染出一个 `null`（详情页出现过一次）。
 *    这三个封装把空值吃掉，调用处不必层层判断。
 */

// ---------------------------------------------------------------- DOM

export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'style') node.setAttribute('style', value)
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
        else if (key === 'dataset') Object.assign(node.dataset, value)
        else node.setAttribute(key, value === true ? '' : String(value))
    }
    append(node, children)
    return node
}

/** 统一的子节点追加：把 null / false / 数组都吃掉，调用处不必层层判断 */
export function append(node, children) {
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue
        node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
}

/**
 * 清空并重设子节点 —— 原生 `replaceChildren(...)` 的安全版本
 *
 * 三元表达式里写 `cond ? node : null` 是最顺手的写法，而原生的 `replaceChildren` /
 * `append` 会把那个 `null` 变成字符串 `"null"` 渲染出来。要让**所有**子节点都过一遍
 * `append()` 的过滤，就只有走这里。
 */
export function setChildren(host, children = []) {
    host.replaceChildren()
    return append(host, children)
}

export const frag = (...children) => append(document.createDocumentFragment(), children)

/** 一个能在正文里安全使用的文本节点（`el('p', {text})` 的简写） */
export const text = (value) => document.createTextNode(String(value ?? ''))

export const paramsOf = (obj) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
    }
    return search.toString()
}

/** 去掉空值（undefined / null / 空串）；全空时返回 null */
function compactObject(obj) {
    if (!obj) return null
    const out = {}
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined || value === null || value === '') continue
        out[key] = value
    }
    return Object.keys(out).length > 0 ? out : null
}

/**
 * 取书接口（/api/book、/api/toc、/api/content）要带的 `book` / `chapter` 参数
 *
 * 这两样**只有客户端知道**：引擎求值 `ruleBookInfo` 时正在算的就是书名与作者，
 * 章节名与序号同理。而书源规则里偏偏用得很密 —— `book.name` 54 处 / 39 源、
 * `chapter.title` 32 处 / 30 源、`book.author` 27 处 / 18 源。
 * 不带上去的话那些规则拿到的是空串（以前是 undefined，会拼出「【undefined】」）。
 *
 * 全空的字段直接省掉：服务端把「没传」与「传了空串」当同一件事处理，多传无益。
 * `index` 为 0 是有效值，别被当作空（`compactObject` 只滤 undefined/null/空串）。
 */
export const contextParams = (book, chapter) => {
    const out = {}
    const b = compactObject(book)
    if (b) out.book = JSON.stringify(b)
    const c = compactObject(chapter)
    if (c) out.chapter = JSON.stringify(c)
    return out
}

export const go = (hash) => {
    if (location.hash === hash) return
    location.hash = hash
}

export function alertBox(kind, message, extra) {
    return el('div', { class: `alert ${kind}` }, [
        el('div', { class: 'alert-title', text: message }),
        extra ? el('div', { class: 'alert-extra', text: extra }) : null,
    ])
}

// ---------------------------------------------------------------- 临时提示

let toastTimer = null

/** 底部浮出一条提示，2.6 秒后自己消失（多个提示共用一条，避免叠成一片） */
export function toast(message, kind = 'ok') {
    const host = document.querySelector('#toast')
    if (!host) return
    const node = alertBox(kind, message)
    node.classList.add('toast-item')
    host.replaceChildren(node)
    host.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
        host.hidden = true
    }, 2600)
}

// ---------------------------------------------------------------- 骨架屏

/**
 * 骨架屏而不是「正在加载…」四个字
 *
 * 列表类界面用骨架屏，是因为它把「大概会出来什么」先画出来了 ——
 * 内容到位时页面不会整体跳一下，观感差别很明显。纯文字提示做不到这一点。
 */
export function skeletonList(count = 6, kind = 'row') {
    const box = el('div', { class: `skeleton-list ${kind}` })
    for (let i = 0; i < count; i += 1) {
        box.append(
            el('div', { class: 'skeleton-card' }, [
                el('div', { class: 'skeleton skeleton-cover' }),
                el('div', { class: 'skeleton-lines' }, [
                    el('div', { class: 'skeleton skeleton-line w70' }),
                    el('div', { class: 'skeleton skeleton-line w40' }),
                ]),
            ]),
        )
    }
    return box
}

export function skeletonBlock(label) {
    return el('div', { class: 'skeleton-block' }, [
        el('div', { class: 'skeleton skeleton-line w50' }),
        el('div', { class: 'skeleton skeleton-line' }),
        el('div', { class: 'skeleton skeleton-line' }),
        el('div', { class: 'skeleton skeleton-line w70' }),
        label ? el('div', { class: 'muted center', text: label }) : null,
    ])
}

// ---------------------------------------------------------------- 封面

/**
 * 封面：有图用图，没图（或图挂了）给一个按书名生成的渐变底 + 首字
 *
 * 真实书源里 coverUrl 缺失或防盗链失败都是常态。没有兜底的话，
 * 书架会变成一片「无封面」的灰块 —— 那比一个带首字的色块难看得多。
 */
export function coverNode(url, name, className = 'cover') {
    const label = (name ?? '').trim()
    const placeholder = () =>
        el('div', { class: `${className} cover-fallback`, dataset: { seed: seedOf(label) } }, [
            el('span', { text: label.slice(0, 1) || '书' }),
        ])

    if (!url) return placeholder()

    const img = el('img', {
        class: className,
        src: url,
        alt: '',
        loading: 'lazy',
        referrerpolicy: 'no-referrer',
        onerror: (event) => event.target.replaceWith(placeholder()),
    })
    return img
}

/** 稳定的伪随机种子：同一本书每次都是同一个颜色，而不是每次刷新都换 */
function seedOf(text) {
    let hash = 0
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 997
    return String(hash % 8)
}

/**
 * 一本书的封面地址：**有代取地址就用代取地址**
 *
 * 书源给 `coverUrl` 写了 `,{"headers":{"Referer":…}}` 的封面（防盗链）浏览器直接
 * 加载必然 403 —— 后端会为这种封面签发 `coverProxyUrl`（走 `/api/media`，
 * 由服务端把 `Referer` 补上，见 `src/index.ts` 的 `withCoverProxy`）。
 * 其余封面没有这个字段，直接用 `coverUrl` 让浏览器加载。
 */
export function coverSrc(book) {
    return (book && (book.coverProxyUrl || book.coverUrl)) || ''
}

// ---------------------------------------------------------------- 偏好

const prefKeys = {
    theme: (v) => (v === 'dark' ? 'dark' : 'light'),
    fontSize: (v) => String(Math.min(30, Math.max(14, Number(v) || 19))),
    lineHeight: (v) => String(Math.min(2.2, Math.max(1.4, Number(v) || 1.85))),
    readerMode: (v) => (v === 'scroll' ? 'scroll' : 'page'),
    /**
     * 强调色
     *
     * 必须**按白名单校验**。早先是 `/^[a-z]+$/.test(String(v))`，看着挺严，
     * 但 `String(undefined)` 就是 `'undefined'` —— 它也全小写字母，于是「没设过」
     * 被当成合法值，`<html>` 上落下 `data-accent="undefined"`。
     * 浅色下因为 `:root` 自带一套琥珀色还能糊过去，深色下就找不到
     * `[data-theme=dark][data-accent=…]` 那条规则了，强调色一直是没调过的浅色版。
     */
    themeColor: (v) => (ACCENTS.includes(String(v)) ? String(v) : 'amber'),
    /**
     * 阅读背景色（纸色）
     *
     * `auto` 表示「跟着主题色的纸色走」—— 老用户的行为不变。
     * 其余取值在 CSS 里各有一组 `[data-paper=…]`，只影响阅读界面，不动外层界面。
     */
    readerPaper: (v) => (PAPERS.includes(String(v)) ? String(v) : 'auto'),
    /** 翻页动画：覆盖 / 滑动 / 无 */
    turnMode: (v) => (['cover', 'slide', 'none'].includes(String(v)) ? String(v) : 'cover'),
    /** 目录里每章标题最多显示多少字（长的目录名会把列表撑烂） */
    chapterTitleLimit: (v) => String(Math.min(60, Math.max(10, Number(v) || 24))),
    /**
     * 搜索时只搜哪几个书源（存 id，**换行分隔**；空串 = 不限定，按健康度分批来）
     *
     * 用换行而不是逗号：书源 id 形如 `user:https://…#禁漫API`，里面本来就可能带逗号。
     * 收拢成字符串而不是数组，是为了沿用 `prefKeys` 这套「一个键一个收拢函数」的形状。
     */
    searchScope: (v) => String(v ?? '').trim(),
}

/** 可选的阅读背景。与 style.css 里的 `[data-paper=…]` 一一对应 */
export const PAPERS = ['auto', 'white', 'sepia', 'green', 'blue', 'pink', 'gray', 'night', 'black']

export const PAPER_LABELS = {
    auto: '跟随主题',
    white: '纯白',
    sepia: '米黄',
    green: '护眼绿',
    blue: '淡蓝',
    pink: '樱粉',
    gray: '浅灰',
    night: '夜间',
    black: '纯黑',
}

/** 强调色。与 style.css 里的 `[data-accent=…]` 一一对应 */
export const ACCENTS = ['amber', 'green', 'blue', 'rose']

export const ACCENT_LABELS = {
    amber: '琥珀',
    green: '松绿',
    blue: '靛蓝',
    rose: '玫红',
}

export const prefs = {
    get(key) {
        const stored = localStorage.getItem(`pref.${key}`)
        return prefKeys[key] ? prefKeys[key](stored) : stored
    },
    set(key, value) {
        localStorage.setItem(`pref.${key}`, prefKeys[key] ? prefKeys[key](value) : String(value))
        applyPrefs()
    },
}

/** 主题、字号、行高都落在 <html> 的自定义属性上，CSS 里统一消费 */
export function applyPrefs() {
    const root = document.documentElement
    root.dataset.theme = prefs.get('theme')
    root.dataset.accent = prefs.get('themeColor') || 'amber'
    root.style.setProperty('--reader-font-size', `${prefs.get('fontSize')}px`)
    root.style.setProperty('--reader-line-height', prefs.get('lineHeight'))

    // 阅读背景：`auto` 时把属性摘掉，交回给主题色的纸色（老行为不变）
    const paper = prefs.get('readerPaper') || 'auto'
    if (paper === 'auto') delete root.dataset.paper
    else root.dataset.paper = paper

    // 翻页动画交给 CSS：`data-turn=none` 时翻页只有位移、没有过渡
    root.dataset.turn = prefs.get('turnMode') || 'cover'
}

// ---------------------------------------------------------------- 接口

/**
 * 最近一次请求是不是「连不上」（而不是服务端答了个错）
 *
 * 为什么不用 `navigator.onLine`：它说的是**网卡有没有连上网络**，跟「我们这个服务端
 * 现在答不答话」是两件事 —— 实测把本地服务停掉，`navigator.onLine` 仍然是 `true`。
 * 这里以「自己这条请求真的抛了传输错误」为准，才是我们关心的那件事。
 *
 * 谁用它：阅读页保存进度（见 reader.js 的 `saveProgress`）。离线时那条 PUT 必然失败，
 * 而它每翻一页就发一次，不管的话屏幕上会一直弹「进度没记上」，看着像坏了。
 */
let offline = false
export const isOffline = () => offline

/**
 * 本机匿名身份
 *
 * 升级到账号之前，书架挂在浏览器随机生成的 token 上。这个 token 现在只剩一个用途：
 * 登录之后一次性把它名下的书架/进度并进账号（见 /api/auth/claim）。
 * 之所以还留着，是因为**直接把老数据变成孤儿**才是更糟的选择。
 */
const ANON_KEY = 'readerUser'
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,64}$/

export function anonToken() {
    let token = localStorage.getItem(ANON_KEY) ?? ''
    if (!TOKEN_SHAPE.test(token)) {
        token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
        localStorage.setItem(ANON_KEY, token)
    }
    return token
}

export function forgetAnonToken() {
    localStorage.removeItem(ANON_KEY)
}

/** 会话失效时由 app.js 接管跳转，核心层不直接操作路由 */
let onUnauthorized = null
export const setUnauthorizedHandler = (fn) => {
    onUnauthorized = fn
}

/**
 * `authAttempt` 标记「这次请求本来就没有会话」
 *
 * 登录、注册的 401 意思是**账号或密码不对**，不是「会话过期了」。
 * 两者都走全局的失效处理，用户输错一次密码就会看到「登录状态已失效，请重新登录」，
 * 于是以为系统坏了、反复重试 —— 线上真实出现过这个误导。
 * 所以这类请求自己把错误显示在表单上，不触发跳转。
 */
export async function api(path, options = {}) {
    const { authAttempt = false, ...rest } = options
    let response
    try {
        response = await fetch(path, {
            ...rest,
            // 会话是 HttpOnly cookie，同源请求会自动带上
            credentials: 'same-origin',
            headers: { ...(rest.headers ?? {}), 'x-reader-user': anonToken() },
        })
    } catch (err) {
        // 连不上（离线 / 服务端挂了）：`fetch` 抛的是 TypeError，没有 HTTP 状态码。
        // 记下来给 `isOffline()` 用，再照原样抛。
        offline = true
        throw err
    }

    const raw = await response.text()
    let json = null
    try {
        json = raw === '' ? null : JSON.parse(raw)
    } catch {
        /* 非 JSON：按状态码统一处理 */
    }

    if (!response.ok) {
        // 非 JSON 的错误体几乎都是 Cloudflare 自己生成的（1102 资源超限、502 等），
        // 原样拼进提示只会是一堆 HTML。这里换成一句能看懂的，并把状态码留着便于排查。
        const fallback =
            json === null && response.status >= 500
                ? `服务暂时不可用（HTTP ${response.status}），请稍后再试`
                : `请求失败（HTTP ${response.status}）`
        const error = new Error(json?.error ?? fallback)
        error.code = json?.code ?? 'http_error'
        error.status = response.status
        /**
         * 带上解析好的响应体（解析不出来就是 `null`）
         *
         * 有些错误**本身就是一次数据交换**：替换净化同步撞版本时，服务端回 409
         * 并把现在那份规则放在响应体里，调用方要拿它把选择权交给用户
         * （见 `replaceSync.js`）。只给一句错误消息的话，用户能做的只有再试一次。
         */
        error.body = json
        if (response.status === 401 && !authAttempt) onUnauthorized?.(error)
        throw error
    }
    return json
}

export const postJson = (path, body, options = {}) =>
    api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...options,
    })

/** 与 postJson 相同，但 401 由调用方自己处理（见 api 的 authAttempt 说明） */
export const postAuth = (path, body) => postJson(path, body, { authAttempt: true })

export const patchJson = (path, body) =>
    api(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })

// ---------------------------------------------------------------- 版本

/**
 * 版本号与更新记录（`/api/version`）
 *
 * 结果缓存住：版本号在一次页面生命周期里不会变，而页脚与「关于」页都要它 ——
 * 不缓存就是同一份东西问两遍。
 *
 * **失败不缓存**（与 `sourcesCache` 同一条道理）：离线时这个请求必然失败，
 * 把失败记下来会让回到线上之后也一直读不到。
 */
let versionInfo = null

export async function loadVersion() {
    if (versionInfo) return versionInfo
    versionInfo = await api('/api/version')
    return versionInfo
}

/**
 * 这个部署的能力开关（`/api/version` 的 `features`）
 *
 * 读不到（还没加载、离线、老服务端）时给一份**保守**的默认 —— 空对象，各开关都按关处理。
 * 宁可界面上少一个便利，也不要在「一次搜不完」的部署上夸这个口：
 * 那种「界面说一次全搜、实际被掐成 503」的谎最难查。
 */
export function versionFeatures() {
    return versionInfo?.features ?? {}
}

// ---------------------------------------------------------------- 登录态

/**
 * 上一次问到的账号，记在本地
 *
 * 只为了让**离线时界面还能渲染**：`/api/auth/me` 是唯一一个「问不到就什么都显示不了」
 * 的接口（见 app.js 的 `render`），而离线时它必然失败 —— 于是整个界面只剩一个
 * 「连不上服务」的红框，连缓存里存着的章节都读不到。
 *
 * 记的只是身份（用户名、显示名，没有凭据），凭据仍然只在 HttpOnly cookie 里。
 * **只在「连不上」时用它**：服务端答了 401 就是真没登录，那必须清掉，
 * 不能拿旧的顶上。回到线上时 `/me` 会再问一次，以服务端为准。
 */
const ACCOUNT_KEY = 'readerAccount'

const rememberUser = (user) => {
    try {
        if (user) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(user))
        else localStorage.removeItem(ACCOUNT_KEY)
    } catch {
        /* 隐私模式等写不进去就算了：退化成「离线时回到登录页」 */
    }
}

const rememberedUser = () => {
    try {
        const raw = localStorage.getItem(ACCOUNT_KEY)
        return raw ? JSON.parse(raw) : null
    } catch {
        return null
    }
}

let session = { loaded: false, user: null, claimable: false }

export const currentUser = () => session.user

export async function loadSession(force = false) {
    if (session.loaded && !force) return session
    let data
    try {
        data = await api('/api/auth/me')
    } catch (err) {
        // 连不上（离线）：用上一次记下的身份把界面撑起来，读缓存里的章节去。
        // 有 `status` 的是服务端在答话（401 之类），照旧抛给调用方走失效处理。
        if (err?.status) throw err
        session = { loaded: true, user: rememberedUser(), claimable: false }
        return session
    }
    // 这一条**从不进缓存**（见 swPolicy 的 cacheNameFor），所以它答了就是真的通了
    offline = false
    session = { loaded: true, user: data.user ?? null, claimable: Boolean(data.claimable) }
    rememberUser(session.user)
    return session
}

export function clearSession() {
    session = { loaded: true, user: null, claimable: false }
    // 退出登录也要把记下的身份抹掉，否则「登出后离线打开」会又把人放进去
    rememberUser(null)
}

export async function register(username, password) {
    const data = await postAuth('/api/auth/register', { username, password })
    session = { loaded: true, user: data.user, claimable: false }
    rememberUser(session.user)
    return data.user
}

export async function login(username, password) {
    const data = await postAuth('/api/auth/login', { username, password })
    // 登录成功后重新问一次 /me：它会顺带告诉本机有没有可并入的旧匿名书架
    session = { loaded: false, user: data.user, claimable: false }
    rememberUser(data.user)
    return loadSession(true)
}

export async function logout() {
    try {
        await postJson('/api/auth/logout', {})
    } finally {
        clearSession()
    }
}

/**
 * 改显示名
 *
 * 成功后就地把会话里的用户换成服务端返回的那一份：顶栏的名字立刻是新的，
 * 不必再问一次 `/api/auth/me`。用户名不变（它是登录凭据）。
 */
export async function saveDisplayName(displayName) {
    const data = await patchJson('/api/account', { displayName })
    if (data?.user) session.user = data.user
    return data?.user ?? null
}

/**
 * 改密码
 *
 * 走普通的 `postJson` 而不是 `postAuth`：当前密码填错时服务端回的是 **400**
 * （表单错误），而 401 只可能是会话本身失效 —— 后者理应触发全局的重新登录提示。
 * 两件事分得开，就不必像登录页那样把它标记成 authAttempt。
 */
export async function savePassword(currentPassword, newPassword) {
    return postJson('/api/account/password', { currentPassword, newPassword })
}

/**
 * 导入一份备份文件
 *
 * 在浏览器里读成文本再 POST：导出的就是一个 JSON 文件，中间不必包一层 multipart ——
 * 多一层编码就多一处能出错的地方，而这里没有任何需要流式处理的理由。
 * 解析放前端做一次，是为了让「选错文件」当场就能说清楚，而不是等服务器回一句
 * 「请求体不是合法 JSON」。
 */
export async function importBackupFile(file) {
    const text = await file.text()
    let parsed = null
    try {
        parsed = JSON.parse(text)
    } catch {
        throw new Error('这不是一份 JSON 文件，请选择之前导出的那份备份')
    }
    return postJson('/api/backup', parsed)
}

/** 把本机匿名身份名下的书架与进度并入当前账号 */
export async function claimAnonymous() {
    const result = await postJson('/api/auth/claim', { token: anonToken() })
    forgetAnonToken()
    session.claimable = false
    return result
}

// ---------------------------------------------------------------- 格式化

export function relativeTime(timestamp) {
    if (!timestamp) return ''
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
    if (seconds < 60) return '刚刚'
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
    if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`
    return new Date(timestamp).toLocaleDateString('zh-CN')
}

export const countText = (n, unit) => `${n} ${unit}`
