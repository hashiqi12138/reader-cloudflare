/**
 * 极简 JSONPath
 *
 * Legado 书源里的 JSONPath 规则（`@json:` 或 `$.` 开头）实际只用得到一小撮语法，
 * 引一个通用库反而要背上它整个表达式引擎的体积。这里只实现够用的部分：
 *
 *   $.data.list[*].title     逐层取键、通配
 *   $.data.list[0].name      取第 n 个
 *   $.data.list[:10]         切片（前 10 个）；`$[2:]`、`$[1:3]` 同理
 *   $.[*]                    点号后直接跟方括号（等价于 `$[*]`，书源里很常见）
 *   $['a-b'].c               键名含特殊字符时用引号
 *   $..name                  递归下降，取任意层级的 name
 *   $..[?(@.type=="audio")]  简单过滤器（见下）
 *
 * **过滤器只实现两种形态**，因为线上 816 条书源里一共只有 8 处，全都是这两种：
 *
 *   ?(@.bookName)            存在性判断
 *   ?(@.type=="audio")       等值 / 数值比较（== != > < >= <=）
 *
 * `&&`、`||`、嵌套表达式遇到时**明确抛错**，而不是当作没匹配到：
 * 后者会让整条书源表现成「搜不到书」，且不报任何错，排查成本极高。
 */

import { UnsupportedRuleError } from './types'

type FilterToken = {
    type: 'filter'
    path: string
    op: string | null
    value: string | number | boolean | null
}

type Token =
    | { type: 'key'; name: string }
    | { type: 'index'; index: number }
    | { type: 'wildcard' }
    | { type: 'slice'; start: number | null; end: number | null }
    | { type: 'deep'; name: string }
    | FilterToken

/**
 * JSONPath 用到了本引擎没实现的能力
 *
 * 继承 `UnsupportedRuleError` 是为了让上层把它映射成 422「规则不支持」，
 * 而不是 500「服务器内部错误」—— 后者会让人以为是我们这边坏了，
 * 而实际上是这条书源用了没实现的能力。
 */
export class JsonPathUnsupportedError extends UnsupportedRuleError {}

/** 支持的操作符。多字符的写在前面，否则 `>=` 会被先按 `>` 切开 */
const FILTER_OPS = ['==', '!=', '>=', '<=', '>', '<'] as const

/** 过滤器里的字面量：带引号的字符串、true/false/null、数字，其余按裸字符串 */
function parseLiteral(raw: string): string | number | boolean | null {
    const t = raw.trim()
    const quoted =
        t.length >= 2 &&
        ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    if (quoted) return t.slice(1, -1)
    if (t === 'true') return true
    if (t === 'false') return false
    if (t === 'null') return null
    const n = Number(t)
    return t !== '' && Number.isFinite(n) ? n : t
}

/** 解析 `?(...)` */
function parseFilter(inner: string, expr: string): FilterToken {
    const body = inner.trim()
    if (!body.startsWith('?(') || !body.endsWith(')')) {
        throw new JsonPathUnsupportedError(`无法解析过滤器：[${inner}]（${expr}）`)
    }
    const text = body.slice(2, -1).trim()
    if (text === '') throw new JsonPathUnsupportedError(`过滤器是空的：[${inner}]`)
    if (/&&|\|\||\(/.test(text)) {
        throw new JsonPathUnsupportedError(`暂不支持复合过滤器：[${inner}]`)
    }

    const opPattern = FILTER_OPS.join('|')
    const m = new RegExp(`^([@$][^\\s=!<>]*)\\s*(${opPattern})\\s*([\\s\\S]+)$`).exec(text)
    if (m) {
        return { type: 'filter', path: m[1]!, op: m[2]!, value: parseLiteral(m[3]!) }
    }
    // 只有路径：存在性判断
    if (/^[@$][^\s=!<>]*$/.test(text)) {
        return { type: 'filter', path: text, op: null, value: null }
    }
    throw new JsonPathUnsupportedError(`无法解析过滤器：[${inner}]`)
}

function tokenize(expr: string): Token[] {
    let i = 0
    const s = expr.trim()
    if (s.startsWith('$')) i = 1

    const tokens: Token[] = []
    while (i < s.length) {
        const ch = s[i]!

        if (ch === '.') {
            if (s[i + 1] === '.') {
                // 递归下降
                i += 2
                if (s[i] === '*') {
                    tokens.push({ type: 'deep', name: '*' })
                    i++
                    continue
                }
                const start = i
                while (i < s.length && /[\w$@-]/.test(s[i]!)) i++
                // `$..[?(...)]`：递归下降后面直接跟方括号，等价于「取所有后代再筛」。
                // 不认这种写法的话，`$..[?(@.type=="audio")]` 会整条报「无法解析」
                // —— asmr 那类接口站点的章节列表就是这么写的。
                if (i === start) {
                    if (s[i] === '[') {
                        tokens.push({ type: 'deep', name: '*' })
                        continue
                    }
                    throw new JsonPathUnsupportedError(`无法解析 JSONPath：${expr}`)
                }
                tokens.push({ type: 'deep', name: s.slice(start, i) })
                continue
            }
            i++
            if (s[i] === '*') {
                tokens.push({ type: 'wildcard' })
                i++
                continue
            }
            // `$.[*]` / `$.[0]`：点号后面直接跟方括号，点号只是个分隔符。
            // 线上这个写法有 7 处以上（🏷晋江文学、📂笔下文学、🎨看漫画、🎨W漫画…），
            // 不认它就会整条抛「无法解析 JSONPath」，那些源的列表直接取空。
            if (s[i] === '[') continue
            const start = i
            while (i < s.length && /[\w$@-]/.test(s[i]!)) i++
            if (i === start) throw new JsonPathUnsupportedError(`无法解析 JSONPath：${expr}`)
            tokens.push({ type: 'key', name: s.slice(start, i) })
            continue
        }

        if (ch === '[') {
            // 过滤器 `[?(...)]` 里可能带引号，先按 `)]` 找右边界
            const isFilter = s[i + 1] === '?'
            const close = isFilter ? s.indexOf(')]', i) : s.indexOf(']', i)
            if (close === -1) {
                throw new JsonPathUnsupportedError(
                    isFilter ? `过滤器缺少收尾的 )：${expr}` : `方括号未闭合：${expr}`,
                )
            }
            const inner = isFilter ? s.slice(i + 1, close + 1).trim() : s.slice(i + 1, close).trim()
            i = isFilter ? close + 2 : close + 1

            if (inner === '*') {
                tokens.push({ type: 'wildcard' })
            } else if (/^-?\d+$/.test(inner)) {
                tokens.push({ type: 'index', index: Number(inner) })
            } else if (/^-?\d*:-?\d*$/.test(inner)) {
                // 切片：`$[:10]`（前 10 个）、`$[2:]`、`$[1:3]`。线上 `🎨阿吧漫画` 的
                // 搜索列表用的就是 `$[:10]`；不认它整条抛错，搜索直接 0 条。
                const [a, b] = inner.split(':')
                tokens.push({
                    type: 'slice',
                    start: a === '' ? null : Number(a),
                    end: b === '' ? null : Number(b),
                })
            } else if (/^'.*'$/.test(inner) || /^".*"$/.test(inner)) {
                tokens.push({ type: 'key', name: inner.slice(1, -1) })
            } else if (inner.startsWith('?')) {
                tokens.push(parseFilter(inner, expr))
            } else {
                throw new JsonPathUnsupportedError(`无法解析方括号内容：[${inner}]`)
            }
            continue
        }

        // 出现了无法识别的内容，直接停下而不是猜
        break
    }

    return tokens
}

function collectDeep(node: unknown, name: string, out: unknown[]): void {
    if (Array.isArray(node)) {
        for (const item of node) collectDeep(item, name, out)
        return
    }
    if (node === null || typeof node !== 'object') return

    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (name === '*' || k === name) out.push(v)
        collectDeep(v, name, out)
    }
}

/** 切片端点归一化：负数从末尾数，越界夹到 `[0, len]` */
function normalizeIndex(index: number, len: number): number {
    return index < 0 ? Math.max(len + index, 0) : Math.min(index, len)
}

/** 把 JSONPath 取值，返回所有命中的节点（可能是 0 个、1 个或多个） */
export function queryJsonPath(root: unknown, expr: string): unknown[] {
    const tokens = tokenize(expr)
    let current: unknown[] = [root]

    for (const token of tokens) {
        const next: unknown[] = []
        for (const node of current) {
            switch (token.type) {
                case 'key': {
                    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
                        const v = (node as Record<string, unknown>)[token.name]
                        if (v !== undefined) next.push(v)
                    }
                    break
                }
                case 'index': {
                    if (Array.isArray(node)) {
                        const idx = token.index < 0 ? node.length + token.index : token.index
                        if (idx >= 0 && idx < node.length) next.push(node[idx])
                    }
                    break
                }
                case 'wildcard': {
                    if (Array.isArray(node)) next.push(...node)
                    else if (node !== null && typeof node === 'object')
                        next.push(...Object.values(node))
                    break
                }
                case 'slice': {
                    if (Array.isArray(node)) {
                        const len = node.length
                        const from = token.start === null ? 0 : normalizeIndex(token.start, len)
                        const to = token.end === null ? len : normalizeIndex(token.end, len)
                        next.push(...node.slice(from, Math.max(from, to)))
                    }
                    break
                }
                case 'deep': {
                    collectDeep(node, token.name, next)
                    break
                }
                case 'filter': {
                    next.push(...applyFilter(node, token))
                    break
                }
            }
        }
        current = next
    }

    return current
}

/** 取候选节点上过滤器路径的值。`@.a.b` 与 `$.a.b` 等价 */
function filterValue(candidate: unknown, path: string): unknown {
    return queryJsonPath(candidate, `$${path.slice(1)}`)[0]
}

function matchesFilter(candidate: unknown, token: FilterToken): boolean {
    if (candidate === null || typeof candidate !== 'object') return false

    const actual = filterValue(candidate, token.path)
    // 只有路径的过滤器就是存在性判断：取得到值就算命中
    if (token.op === null) return actual !== undefined
    if (actual === undefined || actual === null) return false

    // 等值比较按字符串比：书源里 `@.volume==false`、`@.id==1` 与 `"1"` 混着写，
    // 按类型严格比会把本该匹配的条目漏掉
    if (token.op === '==') return String(actual) === String(token.value)
    if (token.op === '!=') return String(actual) !== String(token.value)

    const left = Number(actual)
    const right = Number(token.value)
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        throw new JsonPathUnsupportedError(`过滤器 ${token.op} 只能用于可比较的数值：${token.path}`)
    }
    switch (token.op) {
        case '>':
            return left > right
        case '<':
            return left < right
        case '>=':
            return left >= right
        default:
            return left <= right
    }
}

/**
 * 应用一个过滤器
 *
 * 数组按元素过滤；对象则判断它自己是否命中（RFC 9535 的语义）。
 *
 * 结果按**引用去重**：`$..` 会把数组和它的元素都收进候选，
 * 同一个对象因此可能被选中两次（一次作为对象自己、一次作为数组元素）。
 * 不去重的话，`$..[?(@.type=="audio")]` 这种写法会给出重复的章节。
 */
function applyFilter(node: unknown, token: FilterToken): unknown[] {
    const out: unknown[] = []
    const seen = new Set<unknown>()

    const keep = (candidate: unknown) => {
        if (!matchesFilter(candidate, token)) return
        if (candidate !== null && typeof candidate === 'object') {
            if (seen.has(candidate)) return
            seen.add(candidate)
        }
        out.push(candidate)
    }

    if (Array.isArray(node)) {
        for (const item of node) keep(item)
    } else if (node !== null && typeof node === 'object') {
        keep(node)
    }
    return out
}

/** 把 JSONPath 结果转成字符串列表 */
export function jsonPathToStrings(root: unknown, expr: string): string[] {
    return queryJsonPath(root, expr)
        .filter((v) => v !== null && v !== undefined)
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
}
