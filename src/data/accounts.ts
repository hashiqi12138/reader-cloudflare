/**
 * 账号、会话与「把本机身份并入账号」
 *
 * 这一层只跟 D1 打交道，口令哈希与令牌生成在 `lib/password.ts`（那边是纯函数、可单测）。
 *
 * 两条贯穿始终的规则：
 *
 * 1. **登录失败只回一句话**。「用户不存在」和「密码不对」必须给出同一个响应 ——
 *    区分开来等于提供了一个用户名枚举接口。
 * 2. **会话 token 只在创建时返回一次**，库里存的就是它本身（而不是哈希）：
 *    它需要能按值查出用户，这是 D1 上最直接的写法。代价是拿到库的人能冒充别人，
 *    所以它必须有有效期、也必须只能通过 HttpOnly cookie 传（见 index.ts 的下发处）。
 */

import { DataError } from './types'
import { hashPassword, randomToken, verifyPassword, type PasswordRecord } from '../lib/password'

export interface AccountUser {
    id: number
    username: string
    displayName: string
    createdAt: number
}

/** 会话有效期 30 天：够长到不用天天登，够短到丢了的设备会自己失效 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 同一用户名在窗口内最多失败几次 */
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 15 * 60 * 1000

const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,32}$/
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 200

/** 账号数据在 shelf / reading_progress 里的 owner 值 */
export function ownerForUser(user: Pick<AccountUser, 'id'>): string {
    return `u:${user.id}`
}

/** 用户名一律小写存储与比较，避免 Alice / alice 变成两个账号 */
export function normalizeUsername(raw: unknown): string {
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (text === '') throw new DataError('用户名不能为空', 400, 'invalid_username')
    if (!USERNAME_PATTERN.test(text)) {
        throw new DataError(
            '用户名只能是 3～32 位的字母、数字、下划线或连字符',
            400,
            'invalid_username',
        )
    }
    return text
}

/**
 * 口令校验。注册与改密码共用
 *
 * 刻意导出：两处的下限必须**同一份代码**。各写一遍的话，改密码那条路就成了一次
 * 绕过注册限制的机会（把密码改成 1 位）。
 */
export function normalizePassword(raw: unknown): string {
    const text = typeof raw === 'string' ? raw : ''
    if (text.length < MIN_PASSWORD_LENGTH) {
        throw new DataError(`密码至少 ${MIN_PASSWORD_LENGTH} 位`, 400, 'invalid_password')
    }
    if (text.length > MAX_PASSWORD_LENGTH) {
        throw new DataError(`密码最多 ${MAX_PASSWORD_LENGTH} 位`, 400, 'invalid_password')
    }
    return text
}

/** 显示名长度上限。比用户名宽松：它只出现在界面上，不进 URL、不进日志 */
const DISPLAY_NAME_MAX = 24

/**
 * 显示名规范化
 *
 * 与用户名**刻意不同**：用户名会进 URL、日志与 `owner` 值，所以限死 ASCII；
 * 显示名只出现在界面上，用户想叫「张三」就叫「张三」。只做两件必要的事 ——
 * 去掉首尾空白；挡掉控制字符（换行会把界面撑破，而 U+202E 这类双向覆写字符
 * 能让一行文字显示成完全相反的顺序，是经典的伪装手法）。
 */
export function normalizeDisplayName(raw: unknown): string {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '') throw new DataError('显示名不能为空', 400, 'invalid_display_name')
    if (text.length > DISPLAY_NAME_MAX) {
        throw new DataError(`显示名最多 ${DISPLAY_NAME_MAX} 个字`, 400, 'invalid_display_name')
    }
    if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(text)) {
        throw new DataError('显示名里不能有控制字符', 400, 'invalid_display_name')
    }
    return text
}

interface UserRow {
    id: number
    username: string
    display_name: string
    created_at: number
}

/** 带口令参数的行。列名与库一致，映射到 PasswordRecord 在 authenticate 里做 */
interface CredentialRow extends UserRow {
    password_hash: string
    salt: string
    iterations: number
}

function rowToUser(row: UserRow): AccountUser {
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name || row.username,
        createdAt: row.created_at,
    }
}

/** 注册。用户名重复时给出明确的 409，而不是含糊的失败 */
export async function createAccount(
    db: D1Database,
    usernameRaw: unknown,
    passwordRaw: unknown,
): Promise<AccountUser> {
    const username = normalizeUsername(usernameRaw)
    const password = normalizePassword(passwordRaw)
    const record = await hashPassword(password)
    const now = Date.now()

    try {
        const result = await db
            .prepare(
                `INSERT INTO users (username, display_name, password_hash, salt, iterations, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(username, username, record.hash, record.salt, record.iterations, now)
            .run()
        const id = Number(result.meta?.last_row_id ?? 0)
        if (!id) throw new DataError('注册后拿不到账号 id', 500, 'account_write_failed')
        return { id, username, displayName: username, createdAt: now }
    } catch (err) {
        if (err instanceof DataError) throw err
        // UNIQUE 约束冲突是这里唯一可预期的失败，其余一律按存储错误上报
        if (/UNIQUE/i.test(String(err))) {
            throw new DataError('这个用户名已经有人用了', 409, 'username_taken')
        }
        throw err
    }
}

async function failuresInWindow(db: D1Database, username: string): Promise<number> {
    const row = await db
        .prepare('SELECT count, first_at FROM login_failures WHERE username = ?')
        .bind(username)
        .first<{ count: number; first_at: number }>()
    if (!row) return 0
    if (Date.now() - row.first_at > FAILURE_WINDOW_MS) return 0
    return row.count
}

async function noteFailure(db: D1Database, username: string): Promise<void> {
    const now = Date.now()
    const current = await failuresInWindow(db, username)
    if (current === 0) {
        await db
            .prepare(
                `INSERT INTO login_failures (username, count, first_at) VALUES (?, 1, ?)
                 ON CONFLICT(username) DO UPDATE SET count = 1, first_at = excluded.first_at`,
            )
            .bind(username, now)
            .run()
        return
    }
    await db
        .prepare('UPDATE login_failures SET count = count + 1 WHERE username = ?')
        .bind(username)
        .run()
}

async function clearFailures(db: D1Database, username: string): Promise<void> {
    await db.prepare('DELETE FROM login_failures WHERE username = ?').bind(username).run()
}

/** 登录失败时统一用这一条，不区分「没这个人」和「密码不对」 */
function badCredentials(): DataError {
    return new DataError('用户名或密码不对', 401, 'bad_credentials')
}

/**
 * 校验口令并返回账号
 *
 * 失败计数按**用户名**记：够挡住针对某个账号的暴力猜解，
 * 而且不像按 IP 记那样会误伤同一出口 IP 下的其他人。
 */
export async function authenticate(
    db: D1Database,
    usernameRaw: unknown,
    passwordRaw: unknown,
): Promise<AccountUser> {
    let username: string
    try {
        username = normalizeUsername(usernameRaw)
    } catch {
        // 用户名格式不对也是「用户名或密码不对」，不给枚举留口子
        throw badCredentials()
    }

    const password = typeof passwordRaw === 'string' ? passwordRaw : ''
    if (password === '') throw badCredentials()

    const failures = await failuresInWindow(db, username)
    if (failures >= MAX_FAILURES) {
        throw new DataError(
            `登录失败次数过多，请 ${Math.ceil(FAILURE_WINDOW_MS / 60000)} 分钟后再试`,
            429,
            'too_many_attempts',
        )
    }

    const row = await db
        .prepare(
            `SELECT id, username, display_name, created_at, password_hash, salt, iterations
               FROM users WHERE username = ?`,
        )
        .bind(username)
        .first<CredentialRow>()

    if (!row) {
        // 账号不存在也要走一遍同等量级的哈希计算：不然「立刻失败」与「算了 100ms 才失败」
        // 的耗时差异本身就能用来枚举用户名
        await hashPassword(password)
        await noteFailure(db, username)
        throw badCredentials()
    }

    const record: PasswordRecord = {
        hash: row.password_hash,
        salt: row.salt,
        iterations: row.iterations,
    }
    if (!(await verifyPassword(password, record))) {
        await noteFailure(db, username)
        throw badCredentials()
    }

    await db.batch([
        db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(Date.now(), row.id),
        db.prepare('DELETE FROM login_failures WHERE username = ?').bind(username),
    ])
    return rowToUser(row)
}

/**
 * 改显示名
 *
 * 只动 `display_name`，**用户名不变** —— 用户名是登录凭据与数据归属（`owner = u:<id>`
 * 用的是 id，所以改名不会丢数据），让它跟着改只会多出一种「改完之后登不上」的故障。
 */
export async function updateDisplayName(
    db: D1Database,
    userId: number,
    raw: unknown,
): Promise<AccountUser> {
    const displayName = normalizeDisplayName(raw)
    const result = await db
        .prepare('UPDATE users SET display_name = ? WHERE id = ?')
        .bind(displayName, userId)
        .run()
    if (Number(result.meta?.changes ?? 0) === 0) {
        throw new DataError('账号不存在', 404, 'account_missing')
    }
    const row = await db
        .prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?')
        .bind(userId)
        .first<UserRow>()
    if (!row) throw new DataError('账号不存在', 404, 'account_missing')
    return rowToUser(row)
}

/**
 * 改密码
 *
 * 三件事必须做对：
 *
 * 1. **要求当前密码**。会话 token 可能是从一台忘了退出的设备上捡到的（或者从
 *    cookie 里漏出来的）；只凭它就能改密码，等于那条会话一旦泄露就能永久占住账号。
 * 2. **失败也计进登录失败计数**。不然这里就成了一个不限速的口令猜测入口 ——
 *    比登录页更好用，因为这里不需要用户名。
 * 3. **改完踢掉其它会话，唯独留下当前这条**。密码改了而别处的会话还能用，
 *    「改密码」就失去了「把别人赶出去」的意义；把当前这条也踢掉，等于把自己踢下线。
 */
export async function changePassword(
    db: D1Database,
    user: Pick<AccountUser, 'id'>,
    currentRaw: unknown,
    nextRaw: unknown,
    keepToken: string | null,
): Promise<{ revoked: number }> {
    const current = typeof currentRaw === 'string' ? currentRaw : ''
    const next = normalizePassword(nextRaw)

    const row = await db
        .prepare(
            `SELECT id, username, display_name, created_at, password_hash, salt, iterations
               FROM users WHERE id = ?`,
        )
        .bind(user.id)
        .first<CredentialRow>()
    if (!row) throw new DataError('账号不存在', 404, 'account_missing')

    const failures = await failuresInWindow(db, row.username)
    if (failures >= MAX_FAILURES) {
        throw new DataError(
            `尝试次数过多，请 ${Math.ceil(FAILURE_WINDOW_MS / 60000)} 分钟后再试`,
            429,
            'too_many_attempts',
        )
    }

    const record: PasswordRecord = {
        hash: row.password_hash,
        salt: row.salt,
        iterations: row.iterations,
    }
    if (!(await verifyPassword(current, record))) {
        await noteFailure(db, row.username)
        throw new DataError('当前密码不对', 400, 'bad_password')
    }
    // 新密码与旧密码相同：多半是「以为改了、其实没改」。直接说清楚，
    // 比默默成功然后用户下次还用旧密码登录要少一次困惑
    if (await verifyPassword(next, record)) {
        throw new DataError('新密码不能和当前密码一样', 400, 'same_password')
    }

    const hashed = await hashPassword(next)
    const results = await db.batch([
        db
            .prepare('UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?')
            .bind(hashed.hash, hashed.salt, hashed.iterations, user.id),
        db
            .prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?')
            .bind(user.id, keepToken ?? ''),
        db.prepare('DELETE FROM login_failures WHERE username = ?').bind(row.username),
    ])

    return { revoked: Number(results[1]?.meta?.changes ?? 0) }
}

/** 建会话。token 只在这一次返回，之后库里查得到、客户端只知道它自己 */
export async function createSession(
    db: D1Database,
    userId: number,
    userAgent = '',
): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken(32)
    const now = Date.now()
    const expiresAt = now + SESSION_TTL_MS

    await db
        .prepare(
            `INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent)
             VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(token, userId, now, expiresAt, userAgent.slice(0, 300))
        .run()

    return { token, expiresAt }
}

/** 用会话 token 取账号。过期即视为不存在，并顺手删掉那一行 */
export async function userForToken(
    db: D1Database,
    token: string | null | undefined,
): Promise<AccountUser | null> {
    const value = (token ?? '').trim()
    if (value === '') return null

    const row = await db
        .prepare(
            `SELECT u.id, u.username, u.display_name, u.created_at, s.expires_at
               FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token = ?`,
        )
        .bind(value)
        .first<UserRow & { expires_at: number }>()

    if (!row) return null
    if (row.expires_at <= Date.now()) {
        await db.prepare('DELETE FROM sessions WHERE token = ?').bind(value).run()
        return null
    }
    return rowToUser(row)
}

export async function revokeSession(db: D1Database, token: string): Promise<void> {
    if (token === '') return
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
}

/**
 * 把「本机身份」名下的书架与进度并入账号
 *
 * 升级到账号之前，书架挂在浏览器随机生成的 token 上。直接切过去等于把那份数据
 * 变成孤儿 —— 用户看到的是「书架空了」。所以给一个一次性入口：
 * 把旧 token 名下的数据搬到账号名下。
 *
 * 冲突（同一本书已在账号书架里）时**保留账号里那条**：账号数据是用户明确的归属，
 * 不该被一个匿名身份的旧记录覆盖。进度同理。
 */
export async function claimAnonymousData(
    db: D1Database,
    anonymousToken: string,
    user: AccountUser,
): Promise<{ shelf: number; progress: number }> {
    const from = anonymousToken.trim()
    if (from === '' || from === ownerForUser(user)) return { shelf: 0, progress: 0 }

    const shelf = await db
        .prepare(
            `INSERT INTO shelf (owner, book_key, source_id, book_url, name, author, cover_url, created_at, updated_at)
             SELECT ?, book_key, source_id, book_url, name, author, cover_url, created_at, updated_at
               FROM shelf WHERE owner = ?
             ON CONFLICT(owner, book_key) DO NOTHING`,
        )
        .bind(ownerForUser(user), from)
        .run()

    const progress = await db
        .prepare(
            `INSERT INTO reading_progress (owner, book_key, chapter_url, chapter_name, chapter_index, updated_at, page_index)
             SELECT ?, book_key, chapter_url, chapter_name, chapter_index, updated_at, page_index
               FROM reading_progress WHERE owner = ?
             ON CONFLICT(owner, book_key) DO NOTHING`,
        )
        .bind(ownerForUser(user), from)
        .run()

    return {
        shelf: Number(shelf.meta?.changes ?? 0),
        progress: Number(progress.meta?.changes ?? 0),
    }
}

/** 本机身份名下有没有可并入的数据（决定要不要在界面上提示） */
export async function anonymousDataExists(db: D1Database, token: string): Promise<boolean> {
    const value = token.trim()
    if (value === '') return false
    const row = await db
        .prepare(
            `SELECT (SELECT COUNT(*) FROM shelf WHERE owner = ?)
                  + (SELECT COUNT(*) FROM reading_progress WHERE owner = ?) AS n`,
        )
        .bind(value, value)
        .first<{ n: number }>()
    return Number(row?.n ?? 0) > 0
}

/** 清掉过期会话。登录时顺手做一次，不需要定时任务 */
export async function pruneSessions(db: D1Database): Promise<void> {
    await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()).run()
}
