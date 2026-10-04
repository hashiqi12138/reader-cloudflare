/**
 * 规则里的**变量指令**：`@put:{键:规则,…}` 与 `@get:{键}`
 *
 * 它们是 Legado 的「infoMap」在**规则文本**里的写法，与 `java.put` / `java.get(key)`
 * 共用**同一张表**（按请求活的会话变量，见 `js.ts` 的 `SandboxSession.vars`）。
 * 这一点是这套实现的关键：书源里很常见的写法是一边写另一边读 ——
 *
 *   ruleBookInfo.init:     @put:{n:"[property$=book_name]@content", a:…, c:…}
 *   ruleBookInfo.name:     @get:{n}
 *   ruleBookInfo.author:   @get:{a}
 *
 * 也有些源在 `<js>` 里 `java.put('btype', num)`、字段规则再 `@get:{btype}` 读回来。
 * 两条路各存一份表的话，这两种写法都会**静默**读到空串 —— 不报错，只是字段空着。
 *
 * 语料（816 条源）：`@get:` **184 处 / 40 个源**、`@put:` **52 处 / 46 个源**、
 * `ruleBookInfo.init` **116 处 / 109 个源**（其中顶格 `@put:{...}` 23 处）。
 *
 * 这个文件只做**解析**与表的读写，不碰求值 —— 求值会引入沙箱（`analyze.ts`），
 * Node 单测里跑不起来。所以 `@put:` 的值规则由 `analyze.ts` 求值后回填。
 */

import type { BookSource, RuleContext } from './types'

/**
 * 读一个变量
 *
 * 三级，顺序不能换：
 *   1. `ctx.vars`（调用方显式注入的那一张）
 *   2. 会话表（本次请求里 `java.put` / `@put:` 写过的）
 *   3. **书的变量**（`book_variables` 里存着的）—— 跨请求那一路
 *
 * 第 3 级是「跨请求的 put / get」的读端：`ruleBookInfo` 里写的 `bid`，
 * 到 `ruleToc` 那次请求才读 —— 会话早没了，只能落到这本书上（见 `writeInfoVar`）。
 * 前两处与 `globals.ts` 注入沙箱那份的优先级保持一致（`ctx.vars` 覆盖会话表）：
 * 两处不一致的话，`java.get(k)` 与 `@get:{k}` 会读到不同的值。
 */
export function readInfoVar(ctx: RuleContext, key: string): string {
    const fromCtx = ctx.vars?.[key]
    if (fromCtx !== undefined) return fromCtx
    const fromSession = ctx.sandbox?.vars?.[key]
    if (fromSession !== undefined) return fromSession
    return ctx.bookVars?.[key] ?? ''
}

/**
 * 写一个变量
 *
 * 有会话（正常请求）就写会话表 —— 这样**下一个求值**（哪怕是 `<js>` 里的
 * `java.get`）也读得到；没有会话（单测、纯规则求值）就退到 `ctx.vars`，
 * 保证同一次求值里的后一个 `@get:` 仍然读得到。
 *
 * **跨请求的键另外落一次库**（`ctx.infoVarCrossKeys` 里那几个）：这是唯一能穿过
 * 「搜索 / 详情 / 目录 / 正文是四次请求」的通道，走的是「书的变量」（`book_variables`，
 * 按书存、按书取）。三条约束都是必要的：
 *   - **只在有书上下文的请求里落**：搜索没有这本书，`ruleSearch` 里逐条写同一个键
 *     本来就是有损的（最后一条覆盖前面），落库也救不回来，还会写 N 次
 *   - **只落「别的请求会读」的键**（由调用方算好）：全量落会把目录那种逐章求值的
 *     写法变成几百次 D1 写
 *   - **每个键一次请求只落一次**（取第一个值）：把上一条再兜一层
 */
export function writeInfoVar(ctx: RuleContext, key: string, value: string): void {
    if (ctx.sandbox) {
        ;(ctx.sandbox.vars ??= {})[key] = value
    } else {
        ;(ctx.vars ??= {})[key] = value
    }

    if (value === '') return
    if (!ctx.persistBookVariable || !ctx.infoVarCrossKeys?.has(key)) return
    const saved = (ctx.infoVarSaved ??= new Set<string>())
    if (saved.has(key)) return
    saved.add(key)
    if (ctx.bookVars?.[key] === value) return // 库里已经是这个值，不必再写一次
    ctx.persistBookVariable(key, value)
    ;(ctx.bookVars ??= {})[key] = value
}

/**
 * 这个源里「**别的组**会读的变量键」
 *
 * 引擎一次请求只跑一组规则（搜索 → ruleSearch、详情 → ruleBookInfo、目录 → ruleToc、
 * 正文 → ruleContent），所以「读的组 ≠ 当前组」就是**真的跨请求** —— 这类键才需要落库。
 * 线上 12 处跨请求里，8 处是这一路（`ruleBookInfo` 写 `bid`、`ruleToc.chapterUrl` 读），
 * 另有 4 处写在 `ruleSearch` 里（逐条写同一个键、有损），不做。
 *
 * 传入的 `current` 是这次请求跑的组名；只扫**别的组**的规则文本，代价是几次正则。
 */
export function crossRequestInfoKeys(source: BookSource, current: string): Set<string> {
    const keys = new Set<string>()
    const groups = ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleExplore'] as const
    for (const group of groups) {
        if (group === current) continue
        const block = source[group] as Record<string, unknown> | undefined
        if (!block || typeof block !== 'object') continue
        for (const value of Object.values(block)) {
            if (typeof value !== 'string' || value === '') continue
            for (const hit of findGetDirectives(value)) keys.add(hit.key)
        }
    }
    return keys
}

/** `@put:{` 的位置（大小写不敏感）；找不到返回 -1 */
function indexOfPut(rule: string, from = 0): number {
    const at = rule.slice(from).search(/@put:\s*\{/i)
    return at === -1 ? -1 : at + from
}

/**
 * 找与 `{` 配对的 `}`：**跳过引号里的**括号
 *
 * 值里出现 `{`、`}` 是常态（`@put:{body:'{"model":"MI PAD 4"}'}` 这种），
 * 按第一个 `}` 收尾会把它切成半个规则，而后果是「值变成一段 JSON 残片」——
 * 不报错，只是变量内容不对。
 */
function matchBrace(text: string, open: number): number {
    let depth = 0
    let quote = ''
    for (let i = open; i < text.length; i += 1) {
        const ch = text[i]!
        if (quote !== '') {
            if (ch === '\\') i += 1
            else if (ch === quote) quote = ''
            continue
        }
        if (ch === '"' || ch === "'") {
            quote = ch
            continue
        }
        if (ch === '{') depth += 1
        else if (ch === '}') {
            depth -= 1
            if (depth === 0) return i
        }
    }
    return -1
}

/** 按**顶层**逗号切分（引号与括号里的逗号不算分隔符） */
function splitTopLevel(text: string, sep: string): string[] {
    const out: string[] = []
    let depth = 0
    let quote = ''
    let last = 0
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]!
        if (quote !== '') {
            if (ch === '\\') i += 1
            else if (ch === quote) quote = ''
            continue
        }
        if (ch === '"' || ch === "'") {
            quote = ch
            continue
        }
        if (ch === '{' || ch === '[' || ch === '(') depth += 1
        else if (ch === '}' || ch === ']' || ch === ')') depth -= 1
        else if (ch === sep && depth === 0) {
            out.push(text.slice(last, i))
            last = i + 1
        }
    }
    out.push(text.slice(last))
    return out
}

/**
 * 去掉键 / 值外面那层引号
 *
 * 值是规则的**原文**，书源习惯把它整个引起来（`n:"[property$=book_name]@content"`）。
 * 不剥这层引号，规则就变成了 `"[property$=book_name]@content"` —— 一个带引号的
 * CSS 选择器，求值结果是空，而且不报错。
 */
function unquote(raw: string): string {
    const t = raw.trim()
    const m = /^(['"])([\s\S]*)\1$/.exec(t)
    return m ? m[2]! : t
}

export interface PutPair {
    key: string
    /** 值的规则原文（由调用方求值） */
    rule: string
}

/**
 * 把一条规则里的 `@put:{...}` 全摘下来，返回剩下的规则与要存的键值对
 *
 * `@put:` 在语料里有两种位置，摘法一致：
 *   - **后缀**：`title@put:{bid:$.id}` —— 规则本身的值仍是 `title` 的值
 *   - **前缀 / 顶格**：`@put:{n:"…",a:"…"}`（`ruleBookInfo.init`）、
 *     `@put:{bookid:tag.td.0@text}\n编号：@get:{bookid}` —— 只产生副作用
 */
export function splitPutDirectives(rule: string): { rule: string; puts: PutPair[] } {
    // 快路径：绝大多数字段规则里没有 `@put:`，别为它白扫一遍
    if (!/@put:/i.test(rule)) return { rule, puts: [] }

    const puts: PutPair[] = []
    let rest = ''
    let cursor = 0

    for (;;) {
        const at = indexOfPut(rule, cursor)
        if (at < 0) break
        const open = rule.indexOf('{', at)
        const close = matchBrace(rule, open)
        if (close < 0) {
            // 括号没闭合：不认这一段，原样留着（交给下游按普通文本处理，别把规则吃掉）
            break
        }
        rest += rule.slice(cursor, at)
        rest += ' '
        const inner = rule.slice(open + 1, close)
        for (const pair of splitTopLevel(inner, ',')) {
            const colon = splitTopLevel(pair, ':')
            if (colon.length < 2) continue
            const key = unquote(colon[0]!)
            const value = unquote(colon.slice(1).join(':'))
            if (key === '' || value === '') continue
            puts.push({ key, rule: value })
        }
        cursor = close + 1
    }
    if (puts.length === 0) return { rule, puts }
    return { rule: (rest + rule.slice(cursor)).trim(), puts }
}

/** `@get:{键}`：整条规则或规则里的一个片段 */
const GET_DIRECTIVE = /@@?get:\s*\{([^{}]*)\}/gi

/** 把规则里的 `@get:{键}` 全找出来（返回位置与键，供替换用） */
export function findGetDirectives(
    rule: string,
): Array<{ start: number; end: number; key: string }> {
    const out: Array<{ start: number; end: number; key: string }> = []
    const re = new RegExp(GET_DIRECTIVE.source, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(rule)) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length, key: unquote(m[1] ?? '') })
    }
    return out
}

/**
 * 这一段是不是**整段就是** `@get:{键}`
 *
 * 是的话交给求值那侧的「段」分支（那样它才能当 `@js:` / `<js>` 的输入），
 * 而不是在文字里被替换成值 —— 后者会把 `@get:{d}<js>…</js>a@href` 里
 * 前半段变成一段纯文本，后面的链就全落空了。
 */
export function asGetSegment(text: string): string | null {
    const m = /^\s*@@?get:\s*\{([^{}]*)\}\s*$/i.exec(text)
    return m ? unquote(m[1] ?? '') : null
}
