import { describe, expect, it } from 'vitest'

import {
    asGetSegment,
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
