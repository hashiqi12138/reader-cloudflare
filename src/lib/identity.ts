/**
 * 请求身份
 *
 * 书架与阅读进度是**用户数据**，必须按人隔离；书源是**配置**，仍然是全局的。
 * 这一版不做账号体系，而是用一个「本机身份」：前端首次访问时生成一串随机 token
 * 存在 localStorage 里，之后每个请求带在头上。
 *
 * 为什么是这个方案而不是登录：
 *   - 需求是「隔离」，不是「访问控制」。随机 token 本身就不可猜（128 位熵量级），
 *     别人拿不到就等于隔离成立；再叠一层用户名密码，收益是防住「自己人用同一台设备」，
 *     而那恰恰是要共享的场景。
 *   - 它同时是通往账号体系的一块地基：将来把 token 换成一个真正的会话即可，
 *     书架那几张表不用再改。
 *
 * 另外要说清楚这**不是**访问控制：知道 token 的人就能读写那份书架，
 * 所以它只能通过 HTTPS 传输，也不能当成密码到处贴。
 */

/**
 * 身份的请求头名
 *
 * 用自定义头而不是 cookie：cookie 会自动带上，跨站请求里容易被顺走；
 * 自定义头需要请求方显式设置，配合同源策略更难被利用。
 */
export const USER_HEADER = 'x-reader-user'

/** token 的形状：只允许 URL 安全字符，长度 20～64（够长才够难猜） */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/

/** 升级前那份无归属的数据，迁移时归到它名下（见 migrations/0003） */
export const LEGACY_OWNER = 'legacy'

/**
 * 校验并取出身份 token
 *
 * 非法就抛错，**不做「缺了就当作某个默认用户」的兜底**：那会让所有没带头的请求
 * 悄悄共用同一份书架，看起来一切正常，实际是在互相覆盖数据 —— 静默错数据里最难查的一种。
 *
 * token 由前端生成（`crypto.randomUUID()` 拼两段即可满足长度要求）。
 * 之所以不放在服务端生成：那需要多一次往返，而 token 本身不需要任何服务端状态，
 * 客户端用系统级随机源生成就足够。
 */
export function parseUserToken(raw: string | null | undefined): string {
    const token = (raw ?? '').trim()
    if (token === '') {
        throw new Error(`请求缺少 ${USER_HEADER} 头，无法确定这份书架属于谁`)
    }
    if (!TOKEN_PATTERN.test(token)) {
        throw new Error(`${USER_HEADER} 的格式不对：需要 20～64 位 URL 安全字符`)
    }
    return token
}
