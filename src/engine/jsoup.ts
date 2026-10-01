/**
 * Legado「JSOUP 默认规则」的解析
 *
 * 规则形如 `class.odd.0@tag.a.0@text`：
 *   - `@` 分段，从头到尾逐级向下筛选
 *   - 每段最多三部分：类型、名称、位置。类型有 class / id / tag / text / children
 *   - 最后一段通常是「取什么」：text / textNodes / ownText / html / href / src / 任意属性名
 *   - 位置写法有三种：`class.odd.0`（点号）、`tag.div[0]`（方括号）、`[!1,3]`（排除）
 *   - 规则最前面加 `-` 表示把整个结果列表倒置（有些站的目录是倒着排的）
 *
 * 这里只做**解析**，不碰 cheerio：把规则翻译成一份与解析器无关的计划，
 * 由 select.ts 负责执行。这样换解析实现不会牵动这里。
 */

import { EXTRACT_KINDS } from './types'

/** 选择步骤的类型 */
export type StepBy = 'class' | 'id' | 'tag' | 'text' | 'children'

/** 位置选择：单点、区间、或排除 */
export interface IndexSpec {
  /** 要保留的位置。数字表示单个序号，三元组表示 [start, end, step] 区间；null 表示该端省略 */
  picks?: Array<number | [number | null, number | null, number | null]>
  /** 要排除的序号。为了不把语义搞混，排除只支持单个序号，不支持区间 */
  excludes?: number[]
}

export interface JsoupStep {
  by: StepBy
  /** class/id/tag 的名称；text 表示用来匹配的文本；children 时为空 */
  name: string
  index: IndexSpec | null
}

export interface JsoupPlan {
  steps: JsoupStep[]
  /** 取值方式，缺省 text */
  extract: string
  /** 结果列表是否倒置 */
  reverse: boolean
}

/**
 * 这些词在第一段位置上是「选择类型」，不能被当成取值
 *
 * 注意这里**故意不含 `text`**：`text` 有两种语义，取决于位置 ——
 *   `text.下一页@href`  → 前段，按文本内容找元素
 *   `tag.a.0@text`      → 末段，取值（取文本）
 * 所以判断放在 `isExtractToken` 里按「是否带点」来区分，而不是在这里一刀切。
 */
const SELECT_KEYWORDS = new Set(['class', 'id', 'tag', 'children'])

const EXTRACT_SET = new Set<string>(EXTRACT_KINDS)

/** 判断某一段是「取值」而不是「选择」 */
function isExtractToken(token: string): boolean {
  if (token === '') return false
  // 带点或方括号的一定是选择器（`text.下一页`、`tag.a.0`、`.1`）
  if (token.includes('.') || token.includes('[')) return false
  // children 是选择步骤，不是取值
  if (SELECT_KEYWORDS.has(token)) return false
  // 已知取值名（text / href / textNodes ...），或任意属性名
  return EXTRACT_SET.has(token) || /^[A-Za-z_][\w:-]*$/.test(token)
}

function numOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const t = raw.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** 解析方括号/点号里的位置表达式，如 `0`、`-1`、`!1,3`、`-1:0`、`1:10:2` */
export function parseIndexExpr(expr: string): IndexSpec | null {
  const t = expr.trim()
  if (t === '') return null

  if (t.startsWith('!')) {
    const nums = t
      .slice(1)
      .split(',')
      .map((x) => numOrNull(x))
      .filter((n): n is number => n !== null)
    return nums.length ? { excludes: nums } : null
  }

  const picks: IndexSpec['picks'] = []
  for (const part of t.split(',')) {
    const p = part.trim()
    if (p === '') continue
    if (p.includes(':')) {
      const [s, e, st] = p.split(':')
      picks.push([numOrNull(s), numOrNull(e), numOrNull(st)])
    } else {
      const n = numOrNull(p)
      if (n !== null) picks.push(n)
    }
  }
  return picks.length ? { picks } : null
}

/** 解析 `class.odd.0` / `tag.div[-1:0]` / `children` 这类单段 */
function parseSegment(seg: string): JsoupStep | null {
  // 纯索引段：`.1` 或 `[1]`，等价于 children[1]
  if (seg.startsWith('.') || seg.startsWith('[')) {
    const inner = seg.startsWith('[') ? seg.replace(/^\[/, '').replace(/\]$/, '') : seg.slice(1)
    return { by: 'children', name: '', index: parseIndexExpr(inner) }
  }

  const m = /^(class|id|tag|text|children)(?:\.(.*))?$/.exec(seg)
  if (!m) {
    // 没写类型的裸名字按**标签名**处理。Legado 明确把
    // `head@.1@text` 与 `head@children[1]@text` 视为等价，
    // 所以 `head`、`div`、`ul[1]` 这类写法必须认。
    const bare = /^([A-Za-z][\w:-]*?)(?:\.(-?\d+)|\[([^\]]*)\])?$/.exec(seg)
    if (!bare) return null
    return {
      by: 'tag',
      name: bare[1] ?? '',
      index: parseIndexExpr(bare[2] ?? bare[3] ?? ''),
    }
  }

  const by = m[1] as StepBy
  let rest = m[2] ?? ''
  let index: IndexSpec | null = null

  // 尾部方括号形式的位置
  const br = /^(.*)\[([^\]]*)\]$/.exec(rest)
  if (br) {
    rest = br[1] ?? ''
    index = parseIndexExpr(br[2] ?? '')
  } else {
    // 点号形式的位置：`odd.0` 里最后的 `.0`
    const dm = /^(.*)\.(-?\d+)$/.exec(rest)
    if (dm) {
      rest = dm[1] ?? ''
      index = parseIndexExpr(dm[2] ?? '')
    }
  }

  return { by, name: rest, index }
}

/** 把一条 JSOUP 默认规则解析成计划 */
export function parseJsoupRule(rule: string): JsoupPlan {
  let body = rule.trim()
  let reverse = false

  // 规则最前面的 `-` 表示列表倒置，对应「目录是倒着排的」那种站点。
  // 用 `(?!\d)` 把它和「以负数索引开头的规则」区分开：`-class.item` 是倒置，
  // `-1@text` 不是。判断错了会把负索引规则的选择器整个吃掉。
  if (/^-(?!\d)/.test(body)) {
    reverse = true
    body = body.slice(1)
  }

  const segs = body
    .split('@')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  let extract = 'text'
  if (segs.length > 0) {
    const last = segs[segs.length - 1]!
    if (isExtractToken(last)) {
      extract = last
      segs.pop()
    }
  }

  const steps: JsoupStep[] = []
  for (const seg of segs) {
    const step = parseSegment(seg)
    if (step) steps.push(step)
  }

  return { steps, extract, reverse }
}

/**
 * 对一批元素套用位置选择
 *
 * 负数是「从末尾数」：-1 是最后一个。区间两端都是闭区间，
 * `[-1:0]` 会自动变成倒序（start 大于 end 时步长默认取 -1）。
 */
export function applyIndex<T>(items: T[], spec: IndexSpec | null): T[] {
  if (!spec) return items
  const n = items.length
  let out = items

  if (spec.excludes && spec.excludes.length > 0) {
    const drop = new Set(spec.excludes.map((i) => (i < 0 ? n + i : i)))
    out = out.filter((_, i) => !drop.has(i))
  }

  if (spec.picks && spec.picks.length > 0) {
    const picked: T[] = []
    for (const p of spec.picks) {
      if (typeof p === 'number') {
        const i = p < 0 ? n + p : p
        if (i >= 0 && i < n) picked.push(items[i]!)
        continue
      }
      const [s, e, st] = p
      const start = s === null ? 0 : s < 0 ? n + s : s
      const end = e === null ? n - 1 : e < 0 ? n + e : e
      const step = st === null ? (start <= end ? 1 : -1) : st
      if (step === 0) continue
      if (step > 0) {
        for (let i = start; i <= end; i += step) if (i >= 0 && i < n) picked.push(items[i]!)
      } else {
        for (let i = start; i >= end; i += step) if (i >= 0 && i < n) picked.push(items[i]!)
      }
    }
    out = picked
  }

  return out
}
