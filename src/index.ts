/**
 * Worker 入口与 API 路由
 *
 * 设计上刻意让**每个书源独立失败**：聚合搜索时挂掉两三个源是常态，
 * 不该让整次搜索返回错误。所以搜索接口按源返回结果，每个源自带 ok / error。
 */

import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'

import {
    countUserSources,
    deleteUserSource,
    importSources,
    recordSourceHealth,
    setSourceEnabled,
    type SourceOutcome,
} from './data/db'
import {
    findSource,
    listEnabledSourcePage,
    listEnabledSources,
    listEnabledSourcesByIds,
    listSources,
    persistSourceVariable,
} from './data/sources'
import type { RegistryOptions, RegisteredSource } from './data/sources'
import { addToShelf, getProgress, listShelf, removeFromShelf, saveProgress } from './data/library'
import type { AddToShelfInput, SaveProgressInput } from './data/library'
import { addBookmark, listBookmarks, removeBookmark, updateBookmarkNote } from './data/bookmarks'
import type { BookmarkInput } from './data/bookmarks'
import { addNote, listNotes, removeNote, updateNoteText } from './data/notes'
import type { NoteInput } from './data/notes'
import {
    SESSION_TTL_MS,
    anonymousDataExists,
    authenticate,
    changePassword,
    claimAnonymousData,
    createAccount,
    createSession,
    ownerForUser,
    pruneSessions,
    revokeSession,
    updateDisplayName,
    userForToken,
} from './data/accounts'
import type { AccountUser } from './data/accounts'
import { exportBackup, importBackup } from './data/transfer'
import { bookmarkFileName, loadBookmarkRows, renderCsv, renderMarkdown } from './data/bookmarkList'
import { parseReplaceRules, readReplaceRules, writeReplaceRules } from './data/replaceRules'
import { buildHomeSections, readHomeCache, writeHomeCache } from './data/home'
import { DataError, bookKey } from './data/types'
import { getOrCreateMediaSecret } from './data/settings'
import { UnsupportedRuleError } from './engine/analyze'
import { SOURCE_TYPE, type MediaLink, type RuleContext } from './engine/types'
import { SandboxError, createSandboxSession, runInSandbox, type SandboxSession } from './engine/js'
import { javaSurfaceSummary } from './engine/platform'
import { parseHtml } from './engine/select'
import { handleFixture } from './fixture'
import { exploreBooks, listExploreCategories } from './legado/explore'
import { fetchBookInfo, fetchChapters, searchBooks } from './legado/ops'
import { fetchChapterContent } from './legado/media'
import { mediaRequestHeaders } from './legado/source'
import { UpstreamError } from './lib/http'
import { USER_HEADER } from './lib/identity'
import { MediaTokenError, signMediaToken, verifyMediaToken } from './lib/signing'
import type { MediaTokenPayload } from './lib/signing'

const app = new Hono<{ Bindings: Env }>()

/**
 * 导入接口的请求体上限。
 *
 * 一份完整书源集合通常几百 KB；给到 4 MB 是留足余量，同时挡住
 * 「误把整个网站当书源贴进来」这种情况 —— 那种体积在 JSON.parse 阶段就会吃掉大量内存。
 */
const MAX_IMPORT_BODY_BYTES = 4 * 1024 * 1024

/**
 * 备份文件的请求体上限，比书源导入宽松
 *
 * 按记录条数估：书签一条约 300 字节、两万条约 6 MB；笔记一条是一段话、
 * 按 1 KB 估，5000 条约 5 MB。两者**同时**堆到上限就超过这个数了 ——
 * 那一次导入会回 413 并说清是体积超了，而不是悄悄少写几条
 * （上限之间的这种关系在 `data/transfer.ts` 里也写了一遍，改动时要一起看）。
 */
const MAX_BACKUP_BODY_BYTES = 8 * 1024 * 1024

/**
 * 替换净化规则的请求体上限
 *
 * 规则条数上限 200、单字段上限 2000 字符（见 `data/replaceRules.ts`），
 * 最坏情况约 1.6 MB，留一倍余量。**与书源导入的 4 MiB 分开写**是有意的：
 * 两个上限服务于两件事（书源是整批导入，规则是私人配置），
 * 合成一个常量的话，改其中一个的人不会知道自己动了另一个的边界。
 */
const MAX_REPLACE_BODY_BYTES = 2 * 1024 * 1024

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 504

/** 把各类失败映射成明确的 HTTP 状态，而不是一律 500 */
function statusFor(err: unknown): { status: ErrorStatus; code: string } {
    if (err instanceof UnsupportedRuleError) return { status: 422, code: 'unsupported_rule' }
    if (err instanceof SandboxError) return { status: 422, code: 'sandbox_error' }
    if (err instanceof MediaTokenError) return { status: 403, code: 'bad_media_token' }
    if (err instanceof UpstreamError) return { status: 502, code: 'upstream_error' }
    if (err instanceof DataError) return { status: err.status as ErrorStatus, code: err.code }
    return { status: 500, code: 'internal_error' }
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

/** 统一的失败响应 */
function fail(
    c: { json: (body: unknown, status: ErrorStatus) => Response },
    err: unknown,
): Response {
    const { status, code } = statusFor(err)
    return c.json({ error: describe(err), code }, status)
}

/** 本次请求的注册表选项 */
function registryOf(env: Env): RegistryOptions {
    return { includeFixture: env.ENABLE_FIXTURE === 'true' }
}

/**
 * 一次 API 调用要用到的规则求值上下文
 *
 * **每个请求创建一个沙箱会话**：一次请求里的所有书源求值共用它。
 * 这是唯一可行的形状 —— 同一模块实例不能并发求值，而跨请求又不能互相等
 * （Workers 禁止跨请求的 promise 链），细节见 `engine/js.ts` 的 `SandboxSession`。
 *
 * 用函数而不是让每个路由自己写 `{ baseUrl, sandbox }`：漏掉 `sandbox` 不会报错，
 * 只会让那次求值临时多实例化一个 WASM 模块 —— 一种「能跑但更贵」的静默退化，
 * 统一从这里出就能避免。`persistSourceVariable` 同理：漏掉它不会报错，
 * 只是 `source.setVariable()` 变成「设置成功、下次进来又没了」。
 *
 * `db` 与 `source` 都要传进来，是因为书源变量的落库只有这一层知道（见 data/sources.ts）。
 */
function evalContext(
    db: D1Database,
    source: RegisteredSource,
    sandbox?: SandboxSession,
): RuleContext {
    return {
        baseUrl: source.bookSourceUrl,
        sandbox: sandbox ?? createSandboxSession(),
        persistSourceVariable: (value) => persistSourceVariable(db, source, value),
    }
}

/**
 * 会话 cookie 名
 *
 * 用 **HttpOnly cookie** 而不是像以前那样把身份放在自定义头里：
 * 会话是凭证，凭证放在 localStorage 里等于把「XSS 一次 = 长期冒充」这条路留着。
 * HttpOnly 的 cookie 脚本读不到，SameSite=Lax 又挡住了跨站带 cookie 的请求。
 */
const SESSION_COOKIE = 'rc_session'

/** 下发 / 清除会话 cookie 的公共选项 */
function sessionCookieOptions(c: Context<{ Bindings: Env }>) {
    return {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax' as const,
        // 本地 wrangler dev 跑在 http 上，加 Secure 会让浏览器直接丢掉这个 cookie；
        // 线上是 https，必须加 —— 所以按协议判断，而不是按环境变量
        secure: new URL(c.req.url).protocol === 'https:',
    }
}

/** 本次请求的登录账号；没登录返回 null */
async function currentUser(c: Context<{ Bindings: Env }>): Promise<AccountUser | null> {
    return userForToken(c.env.DB, getCookie(c, SESSION_COOKIE))
}

/** 本次请求的登录账号；没登录直接 401，由 fail() 统一成响应 */
async function requireUser(c: Context<{ Bindings: Env }>): Promise<AccountUser> {
    const user = await currentUser(c)
    if (!user) throw new DataError('请先登录', 401, 'unauthenticated')
    return user
}

/**
 * 书架与阅读进度挂在**账号**上
 *
 * 书源仍然是全局的：书源是「这份实例怎么取网」的配置，属于部署者；
 * 书架与进度是使用者自己的数据。两者混在一起管，只会让
 * 「换个浏览器书架空了、书源却还在」这种预期外的行为变多。
 */
async function ownerOf(c: Context<{ Bindings: Env }>): Promise<string> {
    return ownerForUser(await requireUser(c))
}

/**
 * 运行时自检
 *
 * 回答本项目的三个底层不确定性：cheerio 能否在 workerd 里解析 HTML、
 * QuickJS 的 WASM 能否在 workerd 里加载并执行脚本、D1 绑定是否真的连上了。
 * 固定成可回归的探针。
 */
app.get('/api/probe', async (c) => {
    const $ = parseHtml('<div class="title"><a href="/book/1">斗破苍穹</a></div>')

    const cheerioText = $('div.title a').text()
    const cheerioHref = $('div.title a').attr('href') ?? ''

    let quickjsValue = ''
    let quickjsError = ''
    try {
        quickjsValue = String(
            await runInSandbox(
                `result.replace(/[\\s\\S]/, function (m) { return m + '（经 QuickJS 处理）' })`,
                {
                    result: cheerioText,
                },
                { session: createSandboxSession() },
            ),
        )
    } catch (err) {
        quickjsError = describe(err)
    }

    let sourceCount: number | null = null
    let dbError = ''
    try {
        sourceCount = await countUserSources(c.env.DB)
    } catch (err) {
        dbError = describe(err)
    }

    return c.json({
        cheerio: { text: cheerioText, href: cheerioHref },
        quickjs: { value: quickjsValue, error: quickjsError },
        d1: { userSourceCount: sourceCount, error: dbError },
        version: c.env.ENGINE_VERSION ?? 'unknown',
        /**
         * 「java 平台」兼容层的规模：面有多大、实现了多少
         *
         * 放在探活接口里，是因为「这版引擎到底支持哪些 java.*」是个会变的事实，
         * 而线上唯一能看到它的地方就是这里（见 engine/platform.ts）。
         */
        java: javaSurfaceSummary(),
    })
})

app.get('/api/health', (c) => c.json({ ok: true }))

/** 当前可用的书源 */
app.get('/api/sources', async (c) => {
    const origin = new URL(c.req.url).origin
    const sources = await listSources(c.env.DB, origin, registryOf(c.env))
    return c.json({
        sources: sources.map((s) => ({
            id: s.id,
            name: s.bookSourceName,
            group: s.bookSourceGroup ?? '',
            type: s.bookSourceType ?? 0,
            builtin: s.builtin,
            enabled: s.enabled !== false,
            hasSearch: Boolean(s.searchUrl && s.ruleSearch?.bookList),
            // 「发现」页要按这个字段筛出能探索的书源，否则前端得逐个试一遍
            hasExplore: Boolean(s.exploreUrl && s.ruleExplore?.bookList),
        })),
    })
})

/**
 * 导入书源
 *
 * 请求体就是 Legado 书源 JSON 原文：既可以是裸数组，也可以是 `{"sources":[...]}`。
 * 直接吃原文而不是先解析成对象，是为了让「从文件导入」和「粘贴文本」走同一条路 ——
 * 用户从别处复制的书源就是一坨 JSON，多一层包装只会多一处出错的地方。
 */
app.post('/api/sources', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_IMPORT_BODY_BYTES) {
        return c.json(
            {
                error: `请求体 ${Math.round(declared / 1024 / 1024)} MB，超过上限 ${MAX_IMPORT_BODY_BYTES / 1024 / 1024} MB`,
                code: 'body_too_large',
            },
            413,
        )
    }

    const text = await c.req.text()
    if (text.trim() === '') {
        return c.json({ error: '请求体是空的，没有可导入的内容' }, 400)
    }

    try {
        const report = await importSources(c.env.DB, text)
        return c.json({
            ...report,
            total: await countUserSources(c.env.DB),
        })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 启用 / 停用书源
 *
 * id 走请求体而不是路径参数：用户书源的 id 里嵌着站点 URL（`user:https://...`），
 * 放进路径就要处理 `%2F` 这类转义，而中间层（代理、CDN、日志）对编码路径的
 * 处理并不一致，很容易在某一跳被拆开。放进 body 就没有这个问题。
 */
app.patch('/api/sources', async (c) => {
    let body: { id?: unknown; enabled?: unknown }
    try {
        body = await c.req.json()
    } catch {
        return c.json(
            { error: '请求体必须是 JSON，形如 {"id":"user:https://...","enabled":false}' },
            400,
        )
    }

    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') return c.json({ error: '缺少 id' }, 400)
    if (typeof body.enabled !== 'boolean') {
        return c.json({ error: 'enabled 必须是布尔值' }, 400)
    }

    try {
        await setSourceEnabled(c.env.DB, id, body.enabled)
        return c.json({ id, enabled: body.enabled })
    } catch (err) {
        return fail(c, err)
    }
})

/** 删除书源。内置源不可删 */
app.delete('/api/sources', async (c) => {
    const id = c.req.query('id') ?? ''
    if (id === '') return c.json({ error: '缺少 id 参数' }, 400)

    try {
        await deleteUserSource(c.env.DB, id)
        return c.json({ id, deleted: true, total: await countUserSources(c.env.DB) })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 书架
 *
 * 与搜索一样，书架条目本身不在这里校验书源是否存在 —— 书源是可增删的，
 * 书架记的是「这本书来自哪个源、地址是什么」。源被删掉之后书架条目还在，
 * 打开时由前端按源是否可用给出提示，而不是让书架悄悄少几本。
 *
 * 这几个接口都要求带身份头（见 ownerOf）。
 */
app.get('/api/shelf', async (c) => {
    const entries = await listShelf(c.env.DB, await ownerOf(c))
    return c.json({ count: entries.length, entries })
})

app.post('/api/shelf', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }

    let body: AddToShelfInput
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const { entry, created } = await addToShelf(c.env.DB, owner, body)
        return c.json({ entry, created }, created ? 201 : 200)
    } catch (err) {
        return fail(c, err)
    }
})

app.delete('/api/shelf', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }
    const key = c.req.query('key') ?? ''
    if (key === '') return c.json({ error: '缺少 key 参数' }, 400)

    try {
        const removed = await removeFromShelf(c.env.DB, owner, key)
        return c.json({ removed: removed.bookKey, name: removed.name })
    } catch (err) {
        return fail(c, err)
    }
})

/** 阅读位置。不在书架里的书也记 —— 否则「读了两章再搜回来」就得从头翻 */
app.get('/api/progress', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }
    const sourceId = c.req.query('sourceId') ?? ''
    const bookUrl = c.req.query('bookUrl') ?? ''
    if (sourceId === '' || bookUrl === '') {
        return c.json({ error: '缺少 sourceId 或 bookUrl 参数' }, 400)
    }

    const progress = await getProgress(c.env.DB, owner, bookKey(sourceId, bookUrl))
    return c.json({ progress: progress ?? null })
})

app.put('/api/progress', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }

    let body: SaveProgressInput
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const progress = await saveProgress(c.env.DB, owner, body)
        return c.json({ progress })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 书签
 *
 * 与阅读进度是两件事：进度只有一条、跟着你走；书签是**攒下来的**，
 * 一条一处，可以有很多条、可以带备注、可以被单独删掉。
 * 因此接口按「一本书的全部书签」为单位读写，而不是像进度那样单条覆盖。
 *
 * 书签挂在账号上（与书架同源），所以每个动作都要先要身份。
 */
app.get('/api/bookmarks', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }
    const sourceId = c.req.query('sourceId') ?? ''
    const bookUrl = c.req.query('bookUrl') ?? ''
    if (sourceId === '' || bookUrl === '') {
        return c.json({ error: '缺少 sourceId 或 bookUrl 参数' }, 400)
    }

    const bookmarks = await listBookmarks(c.env.DB, owner, bookKey(sourceId, bookUrl))
    return c.json({ count: bookmarks.length, bookmarks })
})

app.post('/api/bookmarks', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }

    let body: BookmarkInput
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const bookmark = await addBookmark(c.env.DB, owner, body)
        return c.json({ bookmark }, 201)
    } catch (err) {
        return fail(c, err)
    }
})

/** 改备注。位置不动 —— 改位置等于换一处书签，那是删除再新增 */
app.put('/api/bookmarks', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }

    let body: { id?: unknown; note?: unknown }
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') return c.json({ error: '缺少 id' }, 400)

    try {
        const bookmark = await updateBookmarkNote(c.env.DB, owner, id, body.note)
        return c.json({ bookmark })
    } catch (err) {
        return fail(c, err)
    }
})

app.delete('/api/bookmarks', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }
    const id = c.req.query('id') ?? ''
    if (id === '') return c.json({ error: '缺少 id 参数' }, 400)

    try {
        const removed = await removeBookmark(c.env.DB, owner, id)
        return c.json({ removed: removed.id, chapterName: removed.chapterName })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 笔记
 *
 * 与书签分开成两张表与两组接口，但形状一致（见迁移 `0010` 的注释）：
 * 书签记的是**位置**，笔记记的是**一段话**。所以这里按「一本书的全部笔记」读写，
 * 每条各自可改可删 —— 与「进度只有一条」那种单条覆盖不是一类东西。
 *
 * 与书签唯一的行为差别在**正文必填**：空正文直接 400（见 `data/notes.ts`）。
 */
app.get('/api/notes', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }
    const sourceId = c.req.query('sourceId') ?? ''
    const bookUrl = c.req.query('bookUrl') ?? ''
    if (sourceId === '' || bookUrl === '') {
        return c.json({ error: '缺少 sourceId 或 bookUrl 参数' }, 400)
    }

    const notes = await listNotes(c.env.DB, owner, bookKey(sourceId, bookUrl))
    return c.json({ count: notes.length, notes })
})

app.post('/api/notes', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }

    let body: NoteInput
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const note = await addNote(c.env.DB, owner, body)
        return c.json({ note }, 201)
    } catch (err) {
        return fail(c, err)
    }
})

/** 改正文。位置与摘录不动 —— 改它们等于换一处笔记，那是删掉重写 */
app.put('/api/notes', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }

    let body: { id?: unknown; text?: unknown }
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') return c.json({ error: '缺少 id' }, 400)

    try {
        const note = await updateNoteText(c.env.DB, owner, id, body.text)
        return c.json({ note })
    } catch (err) {
        return fail(c, err)
    }
})

app.delete('/api/notes', async (c) => {
    let owner: string
    try {
        owner = await ownerOf(c)
    } catch (err) {
        return fail(c, err)
    }
    const id = c.req.query('id') ?? ''
    if (id === '') return c.json({ error: '缺少 id 参数' }, 400)

    try {
        const removed = await removeNote(c.env.DB, owner, id)
        return c.json({ removed: removed.id, chapterName: removed.chapterName })
    } catch (err) {
        return fail(c, err)
    }
})

// ---------------------------------------------------------------- 账号

/**
 * 注册
 *
 * 注册成功即登录：新用户不该先填一遍表单、再填一遍同样的表单。
 * 会话 cookie 直接下发，前端拿到 user 就能进主界面。
 */
app.post('/api/auth/register', async (c) => {
    let body: { username?: string; password?: string }
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const user = await createAccount(c.env.DB, body.username, body.password)
        const { token, expiresAt } = await createSession(
            c.env.DB,
            user.id,
            c.req.header('user-agent') ?? '',
        )
        setCookie(c, SESSION_COOKIE, token, {
            ...sessionCookieOptions(c),
            maxAge: Math.floor(SESSION_TTL_MS / 1000),
        })
        return c.json({ user, expiresAt }, 201)
    } catch (err) {
        return fail(c, err)
    }
})

app.post('/api/auth/login', async (c) => {
    let body: { username?: string; password?: string }
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const user = await authenticate(c.env.DB, body.username, body.password)
        // 顺手清一次过期会话：登录是唯一必然会发生的动作，不需要额外的定时任务
        await pruneSessions(c.env.DB)
        const { token, expiresAt } = await createSession(
            c.env.DB,
            user.id,
            c.req.header('user-agent') ?? '',
        )
        setCookie(c, SESSION_COOKIE, token, {
            ...sessionCookieOptions(c),
            maxAge: Math.floor(SESSION_TTL_MS / 1000),
        })
        return c.json({ user, expiresAt })
    } catch (err) {
        return fail(c, err)
    }
})

app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token) await revokeSession(c.env.DB, token)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
})

/**
 * 当前登录状态
 *
 * 除了「我是谁」，还要回答「本机上有没有一份升级前的匿名书架可以并进来」——
 * 没有这个提示，老用户升上来只会看到书架空了，却不知道为什么。
 */
app.get('/api/auth/me', async (c) => {
    const user = await currentUser(c)
    const legacyToken = (c.req.header(USER_HEADER) ?? '').trim()
    let claimable = false
    if (user && legacyToken !== '') {
        try {
            claimable = await anonymousDataExists(c.env.DB, legacyToken)
        } catch {
            /* 表还没建好等情况不该让 /me 失败：claimable 保持 false 即可 */
        }
    }
    return c.json({ user: user ?? null, claimable })
})

/**
 * 改显示名
 *
 * 用户名不跟着改：它是登录凭据，改它等于把「改名」和「换个账号登」绑在一起。
 */
app.patch('/api/account', async (c) => {
    let body: { displayName?: string }
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const user = await requireUser(c)
        const updated = await updateDisplayName(c.env.DB, user.id, body.displayName)
        return c.json({ user: updated })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 改密码
 *
 * 必须带当前密码；成功后**其它设备上的会话全部失效**，当前这条留着
 * （否则用户改完密码会发现自己也被踢下线了）。返回踢掉了几条，
 * 界面上可以直接说清「其它 2 台设备需要重新登录」。
 */
app.post('/api/account/password', async (c) => {
    let body: { currentPassword?: string; newPassword?: string }
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const user = await requireUser(c)
        const result = await changePassword(
            c.env.DB,
            user,
            body.currentPassword,
            body.newPassword,
            getCookie(c, SESSION_COOKIE) ?? null,
        )
        return c.json({ ok: true, ...result })
    } catch (err) {
        return fail(c, err)
    }
})

// ---------------------------------------------------------------- 备份（导出 / 导入）

/**
 * 导出：书架 + 阅读进度 + 书签 + 笔记，一个文件
 *
 * 回的是**文件**（`Content-Disposition: attachment`），前端只要一个普通链接 ——
 * 会话是 HttpOnly cookie，同源链接天然带得上，不必先 fetch 再拼 Blob。
 */
app.get('/api/backup', async (c) => {
    try {
        const user = await requireUser(c)
        const backup = await exportBackup(c.env.DB, user)
        const stamp = new Date(backup.exportedAt).toISOString().slice(0, 10)
        return c.json(backup, 200, {
            'Content-Disposition': `attachment; filename="reader-backup-${stamp}.json"`,
        })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 导出**书签清单**（Markdown / CSV）
 *
 * 与 `/api/backup` 的分工：那个是「整份数据、能导回来」，这个是「能读、能贴、能进表格」。
 * 所以回的是纯文本 + 中文文件名（走 RFC 5987 的 `filename*`），不是 JSON。
 *
 * `?format=md|csv`（默认 md），可选 `?sourceId=&bookUrl=` 只导某一本。
 * 过滤**必须两个参数一起给**：只给一个的话按「全部」处理，而不是猜 ——
 * 「以为导的是这一本、其实导了全部」这种错没人会去核对。
 */
app.get('/api/export/bookmarks', async (c) => {
    try {
        const user = await requireUser(c)
        const format = c.req.query('format') === 'csv' ? 'csv' : 'md'
        const sourceId = c.req.query('sourceId')
        const bookUrl = c.req.query('bookUrl')
        const filter = sourceId && bookUrl ? { sourceId, bookUrl } : {}

        const rows = await loadBookmarkRows(c.env.DB, user, filter)
        const at = Date.now()
        const body = format === 'csv' ? renderCsv(rows) : renderMarkdown(rows, at)
        return c.body(body, 200, {
            'Content-Type':
                format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8',
            'Content-Disposition': contentDisposition(bookmarkFileName(rows, format, at)),
        })
    } catch (err) {
        return fail(c, err)
    }
})

// ---------------------------------------------------------------- 替换净化（跟着账号走）

/**
 * 读一份替换净化规则
 *
 * 没同步过的账号回 `{rules: [], updatedAt: 0}`，而不是 404 ——
 * 「还没同步过」是一个正常状态，不是「资源不存在」。
 */
app.get('/api/replace', async (c) => {
    try {
        const user = await requireUser(c)
        return c.json(await readReplaceRules(c.env.DB, user))
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 写一份替换净化规则（带冲突检测）
 *
 * 客户端必须带 `baseUpdatedAt`（它这份规则是基于服务端哪个版本改的）。
 * 对不上就回 409 + 服务端现在那份，由用户决定「取回」还是「覆盖」——
 * 而不是安静地把另一台设备上的编辑抹掉。理由见 `data/replaceRules.ts`。
 */
app.put('/api/replace', async (c) => {
    try {
        const user = await requireUser(c)
        const declared = Number(c.req.header('content-length') ?? '0')
        if (Number.isFinite(declared) && declared > MAX_REPLACE_BODY_BYTES) {
            return c.json(
                {
                    error: `请求体 ${Math.round(declared / 1024)} KB，超过上限 ${MAX_REPLACE_BODY_BYTES / 1024} KB`,
                    code: 'body_too_large',
                },
                413,
            )
        }

        let body: { rules?: unknown; baseUpdatedAt?: unknown }
        try {
            body = await c.req.json()
        } catch {
            return c.json(
                {
                    error: '请求体必须是 JSON，形如 {"rules":[…],"baseUpdatedAt":0}',
                    code: 'invalid_json',
                },
                400,
            )
        }

        const rules = parseReplaceRules(body.rules)
        const outcome = await writeReplaceRules(
            c.env.DB,
            user,
            rules,
            Number(body.baseUpdatedAt ?? 0),
        )
        if (outcome.kind === 'conflict') {
            return c.json(
                {
                    error: '服务端有一份更新的替换规则（可能来自另一台设备）。先取回看看，确认要覆盖再传一次。',
                    code: 'replace_rules_conflict',
                    server: outcome.server,
                },
                409,
            )
        }
        return c.json({ updatedAt: outcome.updatedAt })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 导入：把一份备份合并进当前账号
 *
 * 请求体就是导出的那份文件原文。合并规则见 `data/transfer.ts`，一句话：
 * **书架已有的不动、进度按「谁更新」取、书签与笔记按 id 去重** —— 于是同一份文件
 * 导两次是幂等的，而把旧设备的备份导进新设备不会把读到的新章节倒回去。
 */
app.post('/api/backup', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_BACKUP_BODY_BYTES) {
        return c.json(
            {
                error: `请求体 ${Math.round(declared / 1024 / 1024)} MB，超过上限 ${MAX_BACKUP_BODY_BYTES / 1024 / 1024} MB`,
                code: 'body_too_large',
            },
            413,
        )
    }

    const text = await c.req.text()
    if (text.trim() === '') {
        return c.json({ error: '请求体是空的，没有可导入的内容' }, 400)
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return c.json(
            { error: '这不是一份 JSON 文件，请选择导出的那份备份', code: 'invalid_json' },
            400,
        )
    }

    try {
        const user = await requireUser(c)
        const report = await importBackup(c.env.DB, user, parsed)
        return c.json({ ok: true, imported: report })
    } catch (err) {
        return fail(c, err)
    }
})

/** 把本机匿名身份名下的书架与进度并入当前账号（一次性动作，可重复调用） */
app.post('/api/auth/claim', async (c) => {
    let body: { token?: string }
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400)
    }

    try {
        const user = await requireUser(c)
        const merged = await claimAnonymousData(c.env.DB, String(body.token ?? ''), user)
        return c.json({ merged })
    } catch (err) {
        return fail(c, err)
    }
})

// ---------------------------------------------------------------- 发现（书源探索）

/** 一个书源的发现页分类 */
app.get('/api/explore', async (c) => {
    const sourceId = c.req.query('sourceId') ?? ''
    const origin = new URL(c.req.url).origin
    const source = await findSource(c.env.DB, origin, sourceId, registryOf(c.env))
    if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)

    try {
        const categories = await listExploreCategories(source, evalContext(c.env.DB, source))
        return c.json({
            sourceId: source.id,
            sourceName: source.bookSourceName,
            count: categories.length,
            categories,
        })
    } catch (err) {
        return fail(c, err)
    }
})

/** 某个分类下的书 */
app.get('/api/explore/books', async (c) => {
    const sourceId = c.req.query('sourceId') ?? ''
    const target = c.req.query('url') ?? ''
    const page = Number(c.req.query('page') ?? '1')
    const origin = new URL(c.req.url).origin

    const source = await findSource(c.env.DB, origin, sourceId, registryOf(c.env))
    if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)
    if (target === '') return c.json({ error: '缺少 url 参数' }, 400)

    try {
        const result = await exploreBooks(source, target, page, evalContext(c.env.DB, source))
        return c.json({
            sourceId: source.id,
            sourceName: source.bookSourceName,
            count: result.books.length,
            books: result.books,
            nextUrl: result.nextUrl,
            // 分类地址里带 {{page}} 时，分页由模板表达，前端一直往下翻即可
            hasMore: result.nextUrl !== null || result.templated,
        })
    } catch (err) {
        return fail(c, err)
    }
})

// ---------------------------------------------------------------- 首页

/**
 * 首页：继续阅读 + 推荐位
 *
 * 推荐位来自各书源的**发现页**，缓存 30 分钟（见 data/home.ts）；
 * 「继续阅读」是个人数据，每次实时读，不进缓存。
 */
app.get('/api/home', async (c) => {
    let owner: string
    let entries: Awaited<ReturnType<typeof listShelf>>
    try {
        owner = await ownerOf(c)
        entries = await listShelf(c.env.DB, owner)
    } catch (err) {
        return fail(c, err)
    }

    const continueReading = entries.filter((e) => e.chapterUrl !== null).slice(0, 8)

    const refresh = c.req.query('refresh') === '1'
    let payload = refresh ? null : await readHomeCache(c.env.DB)

    if (!payload) {
        const origin = new URL(c.req.url).origin
        const all = await listEnabledSources(c.env.DB, origin, registryOf(c.env))
        // 书架里出现过的书源排在前面：最轻量的「个人化」，且能一句话解释清楚
        const preferred = [...new Set(entries.map((e) => e.sourceId))]
        const built = await buildHomeSections(all, preferred, (s) => s.id)
        payload = { sections: built.sections, failures: built.failures, builtAt: Date.now() }
        try {
            await writeHomeCache(c.env.DB, payload)
        } catch {
            // 缓存写失败不该让首页失败，下次重建就是
        }
    }

    return c.json({ ...payload, continueReading, count: entries.length })
})

/** 搜索分页：一页默认搜几个书源（界面默认也是这个数，改这里要同步 searchPlan.js） */
const SEARCH_PAGE_SIZE = 3

/** 一页的上限 —— 兜住「客户端硬要一次搜 500 个」 */
const SEARCH_MAX_PAGE = 50

function clampPage(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return SEARCH_PAGE_SIZE
    return Math.min(Math.floor(value), SEARCH_MAX_PAGE)
}

/**
 * 聚合搜索
 *
 * 书源之间并发请求，单个源失败只影响它自己那一条结果。
 * **每个请求只搜一页**：免费计划每个请求只有 10 ms CPU，把全部书源（真实安装是
 * 594 个）读出来再求值必然被掐（见 README「第二十六轮」）。界面默认一页 3 个，
 * 用户点「继续加载」再要下一页 —— 额度按人的节奏花，而不是被一次搜索烧光。
 * 顺序由 `listUserSourcePage` 按「健康度」定，先把额度花在还活着的源上。
 */
app.post('/api/search', async (c) => {
    let body: { keyword?: string; sourceIds?: string[]; offset?: number; limit?: number }
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: '请求体必须是 JSON，形如 {"keyword":"..."}' }, 400)
    }

    const keyword = (body.keyword ?? '').trim()
    if (keyword === '') return c.json({ error: 'keyword 不能为空' }, 400)

    const origin = new URL(c.req.url).origin
    const limit = clampPage(Math.floor(Number(body.limit) || SEARCH_PAGE_SIZE))
    const offset = Math.max(0, Math.floor(Number(body.offset) || 0))

    const page = body.sourceIds?.length
        ? await listEnabledSourcesByIds(c.env.DB, origin, body.sourceIds, registryOf(c.env)).then(
              (sources) => ({ sources, total: sources.length }),
          )
        : await listEnabledSourcePage(c.env.DB, origin, registryOf(c.env), { offset, limit })
    const wanted = page.sources
    const total = page.total

    /**
     * 全部书源共用**一个** session
     *
     * 书源之间是并发的（一个失败不影响别人），但沙箱求值会在 session 里串起来：
     * 同一模块实例不能并发，而给每个源各开一个模块又会把 CPU 预算吃掉。
     * 取网不经过沙箱，所以并发的收益仍然在。
     */
    const session = createSandboxSession()

    const results = await Promise.all(
        wanted.map(async (source) => {
            const started = Date.now()
            try {
                const books = await searchBooks(source, keyword, {
                    ...evalContext(c.env.DB, source, session),
                    key: keyword,
                })
                return {
                    sourceId: source.id,
                    sourceName: source.bookSourceName,
                    ok: true,
                    count: books.length,
                    elapsedMs: Date.now() - started,
                    books,
                }
            } catch (err) {
                return {
                    sourceId: source.id,
                    sourceName: source.bookSourceName,
                    ok: false,
                    count: 0,
                    elapsedMs: Date.now() - started,
                    error: describe(err),
                    errorCode: statusFor(err).code,
                }
            }
        }),
    )

    // 回写健康度：搜到书算 ok、报错算 fail、没报错也没结果不动（见 db.ts）
    try {
        await recordSourceHealth(
            c.env.DB,
            results.map((item) => ({
                id: item.sourceId,
                outcome: (item.ok ? (item.count > 0 ? 'ok' : 'idle') : 'fail') as SourceOutcome,
            })),
        )
    } catch {
        // 健康度只影响「下次怎么排序」，写不进去不该让这次搜索白跑
    }

    return c.json({
        keyword,
        offset,
        limit,
        totalSources: total,
        searched: results.length,
        sourceCount: results.length,
        totalBooks: results.reduce((sum, r) => sum + r.count, 0),
        sources: results,
    })
})

/** 书籍详情（主要为了拿目录地址） */
app.get('/api/book', async (c) => {
    const sourceId = c.req.query('sourceId') ?? ''
    const target = c.req.query('url') ?? ''
    const origin = new URL(c.req.url).origin
    const source = await findSource(c.env.DB, origin, sourceId, registryOf(c.env))
    if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)
    if (!target) return c.json({ error: '缺少 url 参数' }, 400)

    try {
        const info = await fetchBookInfo(source, target, evalContext(c.env.DB, source))
        return c.json({ sourceId: source.id, ...info })
    } catch (err) {
        return fail(c, err)
    }
})

/** 目录 */
app.get('/api/toc', async (c) => {
    const sourceId = c.req.query('sourceId') ?? ''
    const target = c.req.query('url') ?? ''
    const origin = new URL(c.req.url).origin
    const source = await findSource(c.env.DB, origin, sourceId, registryOf(c.env))
    if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)
    if (!target) return c.json({ error: '缺少 url 参数' }, 400)

    try {
        // 文件源（bookSourceType=3）通常**没有目录**：它的下载地址挂在书籍详情页上，
        // 规则里 ruleToc 是空对象。硬去跑目录规则只会得到「未配置目录列表规则」，
        // 于是整本书打不开 —— 明明搜索和详情都是好的，却卡在目录那一步。
        // 这里把书籍地址本身当作唯一一章，前端才有一个可点的下载入口。
        if (
            (source.bookSourceType ?? SOURCE_TYPE.text) === SOURCE_TYPE.file &&
            !source.ruleToc?.chapterList
        ) {
            return c.json({
                sourceId: source.id,
                count: 1,
                synthetic: true,
                chapters: [{ name: '获取下载地址', url: target }],
            })
        }

        const { chapters, warning } = await fetchChapters(
            source,
            target,
            evalContext(c.env.DB, source),
        )
        return c.json({
            sourceId: source.id,
            count: chapters.length,
            chapters,
            // 翻页中途失败时把原因带出去：前端要能告诉用户「这份目录不完整」
            ...(warning ? { warning } : {}),
        })
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 媒体地址的有效期
 *
 * 每打开一章都会重新签发，所以不需要长有效期；短一点能缩小凭证被转发的窗口。
 * 24 小时足够覆盖「打开一章、慢慢看完、中间刷新几次」。
 */
const MEDIA_TOKEN_TTL_SECONDS = 24 * 60 * 60

/** 把一条上游媒体地址换成本站的代取地址（原因见 lib/signing.ts） */
async function proxiedMedia(
    db: D1Database,
    sourceId: string,
    link: MediaLink,
): Promise<MediaLink & { proxyUrl: string }> {
    const secret = await getOrCreateMediaSecret(db)
    const token = await signMediaToken(secret, { sourceId, url: link.url }, MEDIA_TOKEN_TTL_SECONDS)
    return { ...link, proxyUrl: `/api/media/${token}` }
}

/** 允许原样透传的媒体类型。其余一律降级，理由见 mediaResponseHeaders */
const SAFE_MEDIA_TYPE =
    /^(?:image|audio|video|font)\/|^application\/(?:pdf|epub\+zip|zip|x-rar|x-7z-compressed|octet-stream|vnd\.apple\.mpegurl|x-mpegurl|ogg)|^text\/plain\b/i

/** 上游没给 content-type 时按扩展名补一个 */
const MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    txt: 'text/plain; charset=utf-8',
    epub: 'application/epub+zip',
    pdf: 'application/pdf',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
}

function extensionOf(url: string): string {
    try {
        const last = new URL(url).pathname.split('/').pop() ?? ''
        return last.includes('.') ? (last.split('.').pop() ?? '').toLowerCase() : ''
    } catch {
        return ''
    }
}

function fileNameOf(url: string, fallback: string): string {
    try {
        const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
        return last === '' ? fallback : decodeURIComponent(last)
    } catch {
        return fallback
    }
}

function contentDisposition(name: string): string {
    // 中文文件名必须走 filename*：头部里出现非 ASCII 会被直接拒绝
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * 组装媒体的响应头
 *
 * 有一处必须小心：**不能把上游的 HTML 以 text/html 透传回来**。这个接口是同源的，
 * 若某个书源的「图片地址」其实指向一段 HTML，用户点开就等于在我们自己的域上
 * 执行了别人的脚本，而 localStorage 里正放着身份令牌。所以只放行媒体类型，
 * 其余一律降级成 octet-stream 并强制下载。
 */
function mediaResponseHeaders(upstream: Response, target: string, isFileSource: boolean): Headers {
    const headers = new Headers()
    const upstreamType = upstream.headers.get('content-type') ?? ''

    let contentType = 'application/octet-stream'
    let safe = false

    if (SAFE_MEDIA_TYPE.test(upstreamType)) {
        contentType = upstreamType
        safe = true
    } else if (upstreamType === '' || /^application\/octet-stream/i.test(upstreamType)) {
        // 上游没表态，按扩展名猜；猜不出来才用 octet-stream
        contentType = MIME_BY_EXT[extensionOf(target)] ?? 'application/octet-stream'
        safe = true
    }

    headers.set('Content-Type', contentType)
    headers.set('X-Content-Type-Options', 'nosniff')

    // 音频拖动进度条要靠这几个头，漏了就只能从头听到尾
    for (const name of ['content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name)
        if (value) headers.set(name, value)
    }

    if (!safe) {
        headers.set('Content-Disposition', contentDisposition(fileNameOf(target, 'download')))
        headers.set('Cache-Control', 'no-store')
        return headers
    }

    if (isFileSource) {
        headers.set('Content-Disposition', contentDisposition(fileNameOf(target, 'download')))
    }
    headers.set('Cache-Control', isFileSource ? 'private, max-age=600' : 'public, max-age=86400')
    return headers
}

/**
 * 正文
 *
 * 返回形态由书源类型决定：文本源给 `content`，图片源给 `images`，
 * 音频源给 `audio`，文件源给 `downloads`。**媒体一律换成 /api/media 的签名地址**，
 * 原因见 lib/signing.ts（防盗链、混合内容、跨域）。
 */
app.get('/api/content', async (c) => {
    const sourceId = c.req.query('sourceId') ?? ''
    const target = c.req.query('url') ?? ''
    const origin = new URL(c.req.url).origin
    const source = await findSource(c.env.DB, origin, sourceId, registryOf(c.env))
    if (!source) return c.json({ error: `找不到书源：${sourceId}` }, 404)
    if (!target) return c.json({ error: '缺少 url 参数' }, 400)

    try {
        const content = await fetchChapterContent(source, target, evalContext(c.env.DB, source))
        const head = { sourceId: source.id, url: target, kind: content.kind }

        switch (content.kind) {
            case 'text':
                return c.json({ ...head, length: content.text.length, content: content.text })

            case 'images': {
                const images = await Promise.all(
                    content.images.map((link) => proxiedMedia(c.env.DB, source.id, link)),
                )
                return c.json({ ...head, count: images.length, images })
            }

            case 'audio':
                return c.json({
                    ...head,
                    audio: await proxiedMedia(c.env.DB, source.id, content.audio),
                })

            default: {
                const downloads = await Promise.all(
                    content.downloads.map((link) => proxiedMedia(c.env.DB, source.id, link)),
                )
                return c.json({ ...head, count: downloads.length, downloads })
            }
        }
    } catch (err) {
        return fail(c, err)
    }
})

/**
 * 媒体代取
 *
 * 浏览器不能直接取上游的图片/音频（防盗链、混合内容、跨域），所以由这里代取。
 * **只有本站自己签发的地址才认**，否则它就是一个对全网开放的反向代理。
 *
 * 响应体直接转发上游的流，不做缓冲：音频动辄几十 MB，
 * 全读进内存既慢又逼近 Worker 的内存上限。
 */
app.get('/api/media/:token', async (c) => {
    let payload: MediaTokenPayload
    try {
        payload = await verifyMediaToken(
            await getOrCreateMediaSecret(c.env.DB),
            c.req.param('token'),
        )
    } catch (err) {
        return fail(c, err)
    }

    // 书源被删掉之后，之前签出去的地址也该失效，否则等于留下一个永久后门
    const origin = new URL(c.req.url).origin
    const source = await findSource(c.env.DB, origin, payload.sourceId, registryOf(c.env))
    if (!source) return c.json({ error: `找不到书源：${payload.sourceId}` }, 404)

    let target: URL
    try {
        target = new URL(payload.url)
    } catch {
        return c.json({ error: '媒体地址不是合法 URL' }, 400)
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return c.json({ error: `不支持的媒体协议：${target.protocol}` }, 400)
    }

    const headers = mediaRequestHeaders(source, payload.url)
    // 透传 Range，音频才能拖进度条
    const range = c.req.header('range')
    if (range) headers.Range = range

    let upstream: Response
    try {
        upstream = await fetch(payload.url, { headers, redirect: 'follow' })
    } catch (err) {
        return c.json({ error: `取媒体失败：${describe(err)}` }, 502)
    }

    if (!upstream.ok || !upstream.body) {
        return c.json({ error: `上游取媒体返回 HTTP ${upstream.status}` }, 502)
    }

    const isFileSource = (source.bookSourceType ?? SOURCE_TYPE.text) === SOURCE_TYPE.file
    return new Response(upstream.body, {
        status: upstream.status,
        headers: mediaResponseHeaders(upstream, payload.url, isFileSource),
    })
})

/** 其余路径交给静态资源（含 SPA 回退） */
app.get('*', async (c) => {
    const path = new URL(c.req.url).pathname

    // 未命中的接口必须回 JSON 404，**不能**被 SPA 回退喂成 index.html。
    // 后者状态码是 200、内容是 HTML，前端拿到会 JSON.parse 失败，
    // 报出来的是「解析出错」而不是「接口不存在」，排查方向直接被带偏。
    if (path.startsWith('/api/')) {
        return c.json({ error: '接口不存在', path }, 404)
    }

    return c.env.ASSETS.fetch(c.req.raw)
})

/** 非 GET 方法命中不了的路径走这里 */
app.notFound((c) => {
    const path = new URL(c.req.url).pathname
    return c.json({ error: '接口不存在', path }, 404)
})

app.onError((err, c) => fail(c, err))

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url)

        // 内置测试站点：默认关闭，只在本地开发与 CI 里打开
        if (env.ENABLE_FIXTURE === 'true') {
            // 测试站点里有需要读请求体的端点（POST 表单搜索），所以是异步的
            const handled = await handleFixture(request, url)
            if (handled) return handled
        }

        return app.fetch(request, env, ctx)
    },
} satisfies ExportedHandler<Env>
