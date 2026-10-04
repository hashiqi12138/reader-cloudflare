import { describe, expect, it } from 'vitest'

import {
    asGetSegment,
    crossRequestInfoKeys,
    findGetDirectives,
    readInfoVar,
    splitPutDirectives,
    writeInfoVar,
} from '../src/engine/infoVars'
import type { RuleContext } from '../src/engine/types'

/**
 * `@put:{键:规则,…}` / `@get:{键}` 的**解析**（求值在 `infoVarsRule.test.ts`）
 *
 * 这层单独测是因为它有两个容易写歪的地方，而写歪都不报错、只是变量内容不对：
 * ① `@put:` 的值里带引号与括号（`'{"a":1}'`），按第一个 `}` 收尾会切出半条规则
 * ② 值里带逗号（`$.name@put:{n: $.sections, entityType: $..entityType}`），
 *    按所有逗号切会把一对拆成两对
 *
 * 形状全部取自线上语料（`@get:` 184 处 / 40 个源、`@put:` 52 处 / 46 个源）。
 */
describe('`@put:{…}` 的解析', () => {
    it('后缀写法：规则本身的值仍是前缀那条规则', () => {
        expect(splitPutDirectives('title@put:{bid:$.id}')).toEqual({
            rule: 'title',
            puts: [{ key: 'bid', rule: '$.id' }],
        })
    })

    it('键可以带引号：`@put:{"bid":"$.id"}`', () => {
        expect(splitPutDirectives('$.book_name@put:{"bid":"$.book_id"}')).toEqual({
            rule: '$.book_name',
            puts: [{ key: 'bid', rule: '$.book_id' }],
        })
    })

    it('顶格多键（`ruleBookInfo.init` 的形状，线上 23 处），值外面那层引号要剥掉', () => {
        const rule =
            '@put:{n:"[property$=book_name]@content",\na:"[property$=author]@content",\nk:"[property~=category|status]@content"}'
        const out = splitPutDirectives(rule)
        expect(out.rule).toBe('')
        expect(out.puts).toEqual([
            { key: 'n', rule: '[property$=book_name]@content' },
            { key: 'a', rule: '[property$=author]@content' },
            { key: 'k', rule: '[property~=category|status]@content' },
        ])
    })

    it('值里带逗号时不切开：`@put:{n: $.sections, entityType: $..entityType}` 是**两**对', () => {
        const out = splitPutDirectives('$.name@put:{n: $.sections, entityType: $..entityType}')
        expect(out.puts).toEqual([
            { key: 'n', rule: '$.sections' },
            { key: 'entityType', rule: '$..entityType' },
        ])
    })

    it('值里带引号与花括号时按配对取，不按第一个 `}` 收尾', () => {
        const out = splitPutDirectives(`@put:{body:'{"model":"MI PAD 4"}', ok:'1'}`)
        expect(out.puts).toEqual([
            { key: 'body', rule: '{"model":"MI PAD 4"}' },
            { key: 'ok', rule: '1' },
        ])
    })

    it('顶格 `@put:` 后面还有内容时，剩下的原样留着（`📂言情小说大全` 的 intro）', () => {
        const rule = '@put:{bookid:tag.td.0@text}\n《{{book.name}}》\n编号：@get:{bookid}'
        const out = splitPutDirectives(rule)
        expect(out.puts).toEqual([{ key: 'bookid', rule: 'tag.td.0@text' }])
        expect(out.rule).toBe('《{{book.name}}》\n编号：@get:{bookid}')
    })

    it('没有 `@put:` 时原样返回；括号没闭合时也不动它', () => {
        expect(splitPutDirectives('.author@text')).toEqual({ rule: '.author@text', puts: [] })
        expect(splitPutDirectives('x@put:{a:1').puts).toEqual([])
    })
})

describe('`@get:{…}` 的识别与变量表', () => {
    it('整段就是 `@get:{键}`（含冗余 `@` 标记）才算「段」', () => {
        expect(asGetSegment('@get:{a}')).toBe('a')
        expect(asGetSegment('@@get:{a}')).toBe('a')
        expect(asGetSegment(' @get:{ a } ')).toBe('a')
        // 嵌在文字里、或后面还有别的东西，都不算
        expect(asGetSegment('编号：@get:{a}')).toBeNull()
        expect(asGetSegment('@get:{a}@js:result')).toBeNull()
    })

    it('找出规则里所有 `@get:`（给替换用）', () => {
        const hits = findGetDirectives('x=@get:{a}&y=@get:{b}')
        expect(hits.map((h) => h.key)).toEqual(['a', 'b'])
        expect(findGetDirectives('...&bid=@get:{bid}&order=0')[0]).toMatchObject({ key: 'bid' })
    })

    it('读写走同一张表：没有会话时退到 `ctx.vars`', () => {
        const ctx = { baseUrl: '' } as RuleContext
        expect(readInfoVar(ctx, 'a')).toBe('')
        writeInfoVar(ctx, 'a', '甲')
        expect(readInfoVar(ctx, 'a')).toBe('甲')
        expect(ctx.vars).toEqual({ a: '甲' })
    })

    it('有会话时写会话表 —— 这样 `java.get(键)` 也读得到', () => {
        const session = { module: Promise.resolve({}), queue: Promise.resolve(), vars: {} }
        const ctx = { baseUrl: '', sandbox: session } as unknown as RuleContext
        writeInfoVar(ctx, 'a', '甲')
        expect(session.vars).toEqual({ a: '甲' })
        expect(readInfoVar(ctx, 'a')).toBe('甲')
        // `ctx.vars` 优先（与 globals.ts 注入沙箱时的合并顺序一致）
        expect(readInfoVar({ ...ctx, vars: { a: '乙' } } as RuleContext, 'a')).toBe('乙')
    })
})

/**
 * 跨请求的 put / get（线上 12 处里那 8 处 `ruleBookInfo` 写、`ruleToc` 读）
 *
 * 会话变量只活一次请求，而搜索 / 详情 / 目录 / 正文是四次 —— 只有「书的变量」
 * （`book_variables`，按书存按书取）能穿过去。三条约束都在这一组里钉住。
 */
describe('跨请求的变量：书的变量那一路', () => {
    const source = (rules: Record<string, unknown>) => rules as never

    it('`crossRequestInfoKeys`：算的是**别的组**里被 `@get:` 读的键', () => {
        const src = source({
            ruleBookInfo: { name: '@get:{n}', tocUrl: 'x@get:{bid}' },
            ruleToc: { chapterUrl: 'https://x/?b=@get:{bid}', chapterName: 'text@get:{n}' },
            ruleContent: { content: '.c@html' },
        })
        // 详情这次请求：别的组（目录）读了 bid 与 n
        expect([...crossRequestInfoKeys(src, 'ruleBookInfo')].sort()).toEqual(['bid', 'n'])
        // 正文这次请求：别的组（详情）同样读了这两个 —— 只要**别的组会读**就得落库，
        // 因为落库是为了让别人读得到；这一组自己读不读无所谓
        expect([...crossRequestInfoKeys(src, 'ruleContent')].sort()).toEqual(['bid', 'n'])
        // 没有任何一组用 `@get:` 时才是空集
        expect([
            ...crossRequestInfoKeys(source({ ruleContent: { content: '.c@html' } }), 'x'),
        ]).toEqual([])
    })

    it('读：会话里没有时退到「书的变量」', () => {
        const ctx = { baseUrl: '', bookVars: { bid: '123' } } as RuleContext
        expect(readInfoVar(ctx, 'bid')).toBe('123')
        // 会话里有就先用会话的（本次请求刚算出来的更新）
        const session = {
            module: Promise.resolve({}),
            queue: Promise.resolve(),
            vars: { bid: '456' },
        }
        expect(readInfoVar({ ...ctx, sandbox: session } as unknown as RuleContext, 'bid')).toBe(
            '456',
        )
    })

    it('写：跨请求的键会落库，且一个键一次请求只落一次', () => {
        const saved: Array<[string, string]> = []
        const ctx = {
            baseUrl: '',
            bookVars: {},
            infoVarCrossKeys: new Set(['bid']),
            persistBookVariable: (k: string, v: string) => saved.push([k, v]),
        } as unknown as RuleContext

        writeInfoVar(ctx, 'bid', '123')
        writeInfoVar(ctx, 'bid', '999') // 同键第二次：不落库（取第一个值）
        writeInfoVar(ctx, 'other', 'x') // 不在跨请求集合里：不落库
        expect(saved).toEqual([['bid', '123']])
        // 会话表照旧更新（本次请求内后续求值读到的是最新的）
        expect(readInfoVar(ctx, 'bid')).toBe('999')
    })

    it('写：库里已经是这个值时不重复落库（目录逐章求值经常给出同一个值）', () => {
        const saved: Array<[string, string]> = []
        const ctx = {
            baseUrl: '',
            bookVars: { img: 'https://a/1.jpg' },
            infoVarCrossKeys: new Set(['img']),
            persistBookVariable: (k: string, v: string) => saved.push([k, v]),
            sandbox: { module: Promise.resolve({}), queue: Promise.resolve(), vars: {} },
        } as unknown as RuleContext
        writeInfoVar(ctx, 'img', 'https://a/1.jpg')
        expect(saved).toEqual([])
    })

    it('写：没有书上下文（搜索）时不落库', () => {
        const saved: Array<[string, string]> = []
        const ctx = {
            baseUrl: '',
            infoVarCrossKeys: new Set(['bookid']),
            // 搜索路由没有 persistBookVariable
        } as unknown as RuleContext
        writeInfoVar(ctx, 'bookid', '1')
        expect(saved).toEqual([])
        expect(readInfoVar(ctx, 'bookid')).toBe('1')
    })
})
