/**
 * 升级前的「本机身份」
 *
 * 书架与阅读进度是**用户数据**，必须按人隔离；书源是**配置**，仍然是全局的。
 *
 * 在账号体系（见 `data/accounts.ts`、迁移 `0005`）之前，隔离靠的就是这里：
 * 前端首次访问时生成一串随机 token 存 localStorage，之后每个请求带在头上。
 * 现在数据已经挂在账号上（`owner = 'u:<id>'`），这个模块只剩一个用途 ——
 * **让升级前的旧数据能被认领**：`/api/auth/me` 用它在旧 token 名下探一下有没有数据
 * （决定要不要提示），`/api/auth/claim` 用旧 token 把那份数据搬进账号。
 *
 * 换句话说：新的读写路径不再经过它，它只是迁移的入口。等旧数据都并完了可以整个删掉。
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
