/**
 * 书源请求头的解析与三层叠加（纯函数）
 *
 * 单独成模块的原因与 `./urlOptions` 一样：这里必须能被单测逐条钉住，
 * 而 `./source` 会连带引入带 WASM 的沙箱（`src/engine/js.ts`），Node 里跑不起来。
 *
 * 三层请求头，**后面的盖前面的**：
 *
 *   1. 登录头（`source.putLoginHeader(...)` 存下来的）—— 站点不会替你发
 *   2. 默认头（UA / Accept / Referer）—— 不写就一点伪装都没有
 *   3. 书源自己写的 `header` —— 书源明确表过态的最优先
 *
 * 登录头放最前面是有意的：它只是「补上缺的那几个头」，
 * 书源自己写过的 UA / Cookie 不该被登录时的快照盖掉。
 */

import type { BookSource } from '../engine/types'
import { defaultHeaders } from '../lib/http'
import { parseLooseJson } from '../lib/json'

/**
 * 把书源级别的请求头解析出来
 *
 * 注意这里**只认 JSON**：书源里 `header` 也可以写成 `<js>...</js>` 让脚本动态生成，
 * 那种情况目前会被当作「没有请求头」静默丢掉（见 README 的「已知缺口」）。
 * 丢请求头会让站点返回不同版本甚至拒绝服务，症状是「搜不到书」而不是报错 ——
 * 这是当前实现里的一处已知短板，不是有意设计。
 */
export function parseSourceHeaders(raw: string | undefined): Record<string, string> {
    // 与登录头只差一处：这里**不**剔掉 null / undefined 的值（保原行为，字符串化成 "null"）
    return parseHeaderObject(raw, false)
}

/**
 * 把书源存下来的**登录头**（一段 JSON）解析成请求头
 *
 * 语料里 15 处 `source.putLoginHeader(...)` 全写 JSON（`{"Cookie":"…"}` / `{"Authorization":"…"}`），
 * 落库在 `sources.login_header`。这里是它**真正起作用**的地方 ——
 * 站点不会替你发这个头，不发就等于没登录。
 *
 * 解析失败就当没有：一个坏掉的登录头不该让整条链路报错（它本来只意味着「还没登录」）。
 * 语料里有一条源（🎨🔞18色漫画）往这里塞的是**自己的配置**、
 * 还带了个 `#` 前缀（`#{…}`），那种内容解析不出来、也不会被当成请求头 —— 正合适。
 */
export function parseLoginHeaders(raw: string | undefined): Record<string, string> {
    return parseHeaderObject(raw, true)
}

/** 两条解析走的是同一套：认 JSON 对象、值统一成字符串、坏的一律当没有 */
function parseHeaderObject(raw: string | undefined, skipNull: boolean): Record<string, string> {
    if (!raw) return {}
    try {
        const parsed = parseLooseJson<unknown>(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const out: Record<string, string> = {}
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (skipNull && (value === undefined || value === null)) continue
                out[key] = String(value)
            }
            return out
        }
    } catch {
        /* 书源里的 header / 登录头写坏很常见，当没有即可 */
    }
    return {}
}

/** 页面请求的三层请求头：登录头 → 默认头 → 书源自己的 `header` */
export function requestHeadersFor(
    absoluteUrl: string,
    source: Pick<BookSource, 'loginHeader' | 'header'>,
): Record<string, string> {
    return {
        ...parseLoginHeaders(source.loginHeader),
        ...defaultHeaders(absoluteUrl),
        ...parseSourceHeaders(source.header),
    }
}
