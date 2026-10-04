/**
 * 书源的 cookie 罐
 *
 * 三件事分开看，缺一件整个机制就是空转：
 *
 *   1. **收**：每个响应的 `Set-Cookie` 都进罐（原项目的 CookieJar 行为）。
 *      `src/lib/http.ts` 的取网层是唯一出口，所以在那一处收就够。
 *   2. **发**：同一个站的后续请求自动带上罐里的 `Cookie` 头。书源自己声明了 `Cookie`
 *      时以书源为准（有些站点要专用 cookie，不能被罐子覆盖）。
 *   3. **存**：罐子按书源落库（`sources.cookies`）。这一条是**我们的架构决定的**：
 *      搜索 / 详情 / 目录 / 正文在这里是**四次互不相干的 HTTP 请求**，而站点给的
 *      会话 cookie 是在「搜索」那一趟下发的 —— 不落库，「读目录」那一趟就带不上，
 *      表现是「搜索能搜到、点进去 403」。
 *
 * 只有 `enabledCookieJar === true` 的书源才建罐子（816 条源里 457 条开着）。
 * 关掉的源拿不到罐子，`cookie.*` 退回「只活本次求值」的老行为 —— 与它们自己声明的一致。
 *
 * 键是**主机名**（小写、无端口），不是完整地址。这是与原项目的一处刻意分歧：
 * 原项目的 `CookieStore` 按传来的整条 url 存，真实的收发则靠 OkHttp 的 CookieJar
 * 按 domain/path 做。我们只有一层，按完整地址存的话，`setCookie('https://a.com/x', …)`
 * 之后向 `https://a.com/y` 发请求就带不上；而书源里最常见的 `cookie.removeCookie(source.getKey())`
 * （72 处 / 67 源）想要的正是「清掉这个站的 cookie」。按主机名归并，两种意图都对得上。
 *
 * 代价是**没有 path 与 domain 属性**：`Set-Cookie` 里除 `名字=值` 之外的属性全部丢掉，
 * 发请求时按「目标主机 + 它的各级父域」逐级取（`m.a.com` 会带上 `a.com` 上存的那份）。
 * 这比原项目宽一点（浏览器会按 path 与 Domain 精确匹配），但对书源够用，且不会漏发。
 */

/** 主机名 → `k=v; k2=v2` */
export interface CookieJar {
    hosts: Record<string, string>
}

export function emptyJar(): CookieJar {
    return { hosts: {} }
}

/** 从库里那一列读回罐子；坏了就当空罐 —— cookie 是可有可无的状态，不该让它挡住整条链路 */
export function parseJar(raw: string | null | undefined): CookieJar {
    const jar = emptyJar()
    if (!raw) return jar
    try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'string' && value !== '') jar.hosts[host.toLowerCase()] = value
            }
        }
    } catch {
        /* 库里那一份坏了就当空罐 */
    }
    return jar
}

export function dumpJar(jar: CookieJar): string {
    return JSON.stringify(jar.hosts)
}

/**
 * 从地址里取主机名；**裸域名也认**
 *
 * `cookie.getKey("qidian.com", "_csrfToken")`（🏷起点 / 🏷阅文集团）与
 * `cookie.getKey("https://qidian.com", …)` 两种写法都要落到同一个键上，
 * 而 `new URL("qidian.com")` 是抛错的 —— 所以第一遍失败时补一个 `http://` 再试。
 */
export function hostOf(url: string): string {
    const raw = String(url ?? '').trim()
    if (raw === '') return ''
    try {
        return new URL(raw).hostname.toLowerCase()
    } catch {
        /* 不是绝对地址，按裸域名再试一次 */
    }
    try {
        return new URL(`http://${raw}`).hostname.toLowerCase()
    } catch {
        return ''
    }
}

/**
 * 目标主机 + 它的各级父域，**从具体到宽泛**（`m.a.com` → `m.a.com`、`a.com`）
 *
 * 这是「哪些主机算同一个站」的**收发规则**：站点把 cookie 下在父域上（`Domain=a.com`），
 * 子域的请求就该带上它，反过来不该带。`Path` 与 `Secure` 一概不管 —— 书源场景里
 * 多带一个 cookie 的代价远小于少带一个（少带 = 会话丢了 = 403）。
 *
 * 注意沙箱里的 `cookie.*` 用的是**更宽**的一张表（还往下找子域，见 `GLOBALS_PRELUDE`）：
 * 那里是「脚本看这个站的 cookie」，不是「这次请求发什么」，两件事的取舍不同。
 */
function domainChain(host: string): string[] {
    const parts = host.split('.')
    const out: string[] = []
    for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'))
    return out.length > 0 ? out : [host]
}

/** 把 `k=v; k2=v2` 拆成对；不合法或没名字的段直接丢 */
function pairs(cookieString: string): [string, string][] {
    const out: [string, string][] = []
    for (const part of String(cookieString).split(';')) {
        const seg = part.trim()
        const eq = seg.indexOf('=')
        if (eq <= 0) continue
        const name = seg.slice(0, eq).trim()
        if (name === '') continue
        out.push([name, seg.slice(eq + 1).trim()])
    }
    return out
}

/** 按名字合并两串 cookie（后写覆盖；**顺序按首次出现定**，不受覆盖影响） */
function mergePairs(existing: string, incoming: [string, string][]): [string, string][] {
    const order: string[] = []
    const map = new Map<string, string>()
    for (const [name, value] of [...pairs(existing), ...incoming]) {
        if (!map.has(name)) order.push(name)
        map.set(name, value)
    }
    return order.map((name) => [name, map.get(name)!])
}

function joinPairs(list: [string, string][]): string {
    return list.map(([name, value]) => `${name}=${value}`).join('; ')
}

/** `Expires` 已经过去（站点用它删 cookie） */
function expired(raw: string): boolean {
    const matched = /expires\s*=\s*([^;]+)/i.exec(raw)
    if (!matched?.[1]) return false
    const at = Date.parse(matched[1].trim())
    return Number.isFinite(at) && at <= Date.now()
}

/**
 * 把一个响应里的 `Set-Cookie` 收进罐子；返回罐子**有没有变**
 *
 * 只留 `名字=值`，其余属性（Path / Domain / Secure / HttpOnly …）全丢：我们按主机名
 * 收发，留着它们反而会在拼 `Cookie` 头时把属性当键发出去。
 *
 * `Max-Age=0` 与已过期的 `Expires` 是例外 —— 那是站点在**删**这个 cookie
 * （退出登录就靠它），必须照做，否则「退出登录」在书源看来没生效。
 */
export function mergeSetCookie(jar: CookieJar, url: string, values: string[]): boolean {
    const host = hostOf(url)
    if (host === '' || values.length === 0) return false

    const current = new Map(mergePairs(jar.hosts[host] ?? '', []))
    const order = [...current.keys()]
    let changed = false

    for (const raw of values) {
        const text = String(raw)
        const head = text.split(';')[0] ?? ''
        const eq = head.indexOf('=')
        if (eq <= 0) continue
        const name = head.slice(0, eq).trim()
        const value = head.slice(eq + 1).trim()
        if (name === '') continue

        if (/max-age\s*=\s*0\b/i.test(text) || expired(text)) {
            if (current.delete(name)) changed = true
            continue
        }
        if (!current.has(name)) order.push(name)
        if (current.get(name) !== value) changed = true
        current.set(name, value)
    }

    if (!changed) return false
    const merged = joinPairs(
        order.filter((name) => current.has(name)).map((name) => [name, current.get(name)!]),
    )
    if (merged === '') delete jar.hosts[host]
    else jar.hosts[host] = merged
    return true
}

/**
 * 发请求时该带的 cookie 串；没有就回空串
 *
 * **只给取网层用**。沙箱里的 `cookie.getCookie(url)` / `getKey` 走的是预置脚本里
 * 自己那一份（QuickJS 里没法 import 这一份），而且那一份比这里宽 —— 见 `domainChain`。
 */
export function cookieHeaderFor(jar: CookieJar | undefined, url: string): string {
    if (!jar) return ''
    const host = hostOf(url)
    if (host === '') return ''
    const seen = new Set<string>()
    const out: string[] = []
    for (const candidate of domainChain(host)) {
        const value = jar.hosts[candidate]
        if (!value) continue
        for (const [name, pair] of pairs(value)) {
            if (seen.has(name)) continue
            seen.add(name)
            out.push(`${name}=${pair}`)
        }
    }
    return out.join('; ')
}
