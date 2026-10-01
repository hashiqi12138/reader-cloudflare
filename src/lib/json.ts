/**
 * 宽容一点的 JSON 解析
 *
 * 社区书源里 `{'method': 'POST', 'body': 'keyword={{key}}'}` 这种单引号、不带引号的键
 * 很常见 —— Legado 用的是宽松解析器（Gson 的 lenient 模式），所以这些书源在 Legado 里
 * 是能跑的。严格 JSON.parse 会把它们全部拒掉，而这类书源不在少数，一律拒掉等于
 * 白白丢掉一大批可用书源。
 *
 * 只做三件低风险的修补（单引号转双引号、给裸键补引号、去尾逗号），然后交给 JSON.parse。
 * **修补后仍然解析不了就抛出严格解析时那个错误** —— 不做「猜一个能用的值」那种降级：
 * 解析结果常常是一个地址或请求体，猜错就会静默打到错误的地方，
 * 是本项目最不想要的那类问题。
 *
 * 放在 lib/ 而不是书源模块里，是为了让它保持「无依赖的纯函数」，能被单元测试直接覆盖。
 */

const SINGLE_QUOTED_STRING = /'((?:\\.|[^'\\])*)'/g
const BARE_KEY = /([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g
const TRAILING_COMMA = /,(\s*[}\]])/g

export function parseLooseJson<T>(text: string): T {
    const trimmed = text.trim()
    try {
        return JSON.parse(trimmed) as T
    } catch (strictError) {
        const repaired = trimmed
            // 单引号字符串 → 双引号字符串
            .replace(SINGLE_QUOTED_STRING, (_match, inner: string) =>
                JSON.stringify(inner.replace(/\\'/g, "'")),
            )
            // 裸键 → 带引号的键
            .replace(BARE_KEY, '$1"$2"$3')
            // 尾逗号
            .replace(TRAILING_COMMA, '$1')

        try {
            return JSON.parse(repaired) as T
        } catch {
            // 抛出**严格解析**时的错误：它描述的是用户实际写下的内容，
            // 比修补之后那份「已经不像原文」的报错更好定位
            throw strictError
        }
    }
}
