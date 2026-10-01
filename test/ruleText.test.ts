/**
 * 规则文本结构扫描的单元测试
 *
 * 这里判错的后果是**规则被从中间切碎**：每一块看起来都「合法」，只是结果全不对，
 * 而且报错信息会指向切开后的半截内容（例如 JS 语法错误 `expecting ','`），
 * 把人引到错误的方向。所以把真实书源里的形态逐条钉住。
 *
 * 下面所有规则文本都取自线上 816 条书源里那 303 处「JS 与连接符同时出现」的写法。
 */

import { describe, expect, it } from 'vitest'

import { splitRegexChain } from '../src/engine/regex'
import { findJsRegions, splitRuleText } from '../src/engine/ruleText'

/** 只关心「切了几块」时用 */
const count = (rule: string, delimiter: string, options?: Parameters<typeof splitRuleText>[2]) =>
    splitRuleText(rule, delimiter, options)?.length ?? 0

describe('@js: 后面那段代码', () => {
    it('整条是 @js: 时，里面的 || 不是连接符', () => {
        // 听小说APP 的章节地址规则就是这样：被切开后报「expecting ','」（JS 语法错）
        const rule =
            "@js:(function(){ var bookId = String(baseUrl).split('/audiolist-4/')[1]; " +
            "if (bookId) bookId = bookId.split('?')[0]; var cid = java.getString('@href'); " +
            'return cid || bookId; })()'
        expect(splitRuleText(rule, '||')).toBeNull()
    })

    it('整条是 @js: 时，里面的 && 也不是连接符', () => {
        // 禁漫天堂API 的四个规则字段都是这个形态
        const rule =
            '@js: (function(){var out=[]; try{ var bu=String(baseUrl||""); ' +
            'if(/getResourceList/.test(bu)&&/pageNum=1/.test(bu)){ out.push(1) } }catch(e){} return out })()'
        expect(splitRuleText(rule, '&&')).toBeNull()
        expect(splitRuleText(rule, '||')).toBeNull()
    })

    it('区域从 @js: 之后开始，一直到最后（规则里没有 ## 时）', () => {
        const rule = '@js:var a = 1'
        expect(rule.slice(0, 4)).toBe('@js:')
        expect(findJsRegions(rule)).toEqual([{ start: 4, end: rule.length, block: false }])
    })

    it('选择器 + @js: 也认', () => {
        const rule = 'class.view-imgBox@tag.img@data-src\n@js:var pool = [1]; return pool[0]'
        const regions = findJsRegions(rule)
        expect(regions).toHaveLength(1)
        expect(rule.slice(regions[0]!.start, regions[0]!.end)).toBe(
            'var pool = [1]; return pool[0]',
        )
    })

    it('**代码之后的 `##` 净化链要留下来**', () => {
        // 线上 291 条「选择器 + @js:」里有 22 条带净化链，代码不能一路吃到末尾
        const rule = '@js:result.replace(/第(.)章/g, x)##(章)([^\\s]+)(\\s·)##$1 $2$3'
        const regions = findJsRegions(rule)
        expect(regions[0]!.end).toBe(rule.indexOf('##'))
        expect(count(rule, '##', { skipJsBlocks: false, skipQuotes: false })).toBe(3)
    })

    it('代码里**引号内**的 `##` 不算净化链的起点', () => {
        const rule = `@js:var sep = '##'; return sep`
        expect(findJsRegions(rule)[0]!.end).toBe(rule.length)
        expect(count(rule, '##', { skipJsBlocks: false, skipQuotes: false })).toBe(0)
    })

    it('代码里带转义的引号也能正确跳过', () => {
        const rule = `@js:var s = 'it\\'s ##'; return s`
        expect(findJsRegions(rule)[0]!.end).toBe(rule.length)
    })
})

describe('<js> 块', () => {
    it('块里的 && / || 不是连接符', () => {
        // 书旗小说、微信读书、晋江文学的目录规则都是这个形态
        const rule =
            '<js>\nlist = [];\ndata = JSON.parse(src).data;\n' +
            'if (data.a && data.b) { list.push(1) }\nvar x = y || z;\nresult = list\n</js>'
        expect(splitRuleText(rule, '&&')).toBeNull()
        expect(splitRuleText(rule, '||')).toBeNull()
    })

    it('区域包含整块（含标签）', () => {
        const rule = '<js>a</js>'
        expect(rule.length).toBe(10)
        expect(findJsRegions(rule)).toEqual([{ start: 0, end: 10, block: true }])
    })

    it('没写闭合标签时一路认到最后（好过把剩下的 JS 当规则去解析）', () => {
        const rule = 'sel@text <js>var a = b && c'
        const regions = findJsRegions(rule)
        expect(regions).toHaveLength(1)
        expect(regions[0]!.end).toBe(rule.length)
        expect(splitRuleText(rule, '&&')).toBeNull()
    })

    it('块**之前**的连接符照常切', () => {
        // 禁漫天堂：`class.btn-toolbar.0@tag.a||.reading` 后面才跟 <js>
        const rule =
            "class.btn-toolbar.0@tag.a||.reading\n<js>var type = +(java.get('btype'))\nresult\n</js>"
        const parts = splitRuleText(rule, '||')
        expect(parts).toHaveLength(2)
        expect(parts![0]).toBe('class.btn-toolbar.0@tag.a')
        expect(parts![1]).toContain('<js>')
    })

    it('块**之后**的连接符照常切', () => {
        // 轻小说、企鹅都是块后接连接符
        const rule = '<js>java.t2s(result)</js> #chaptersShowContent@html&&.card-body.0@html'
        const parts = splitRuleText(rule, '&&')
        expect(parts).toHaveLength(2)
        expect(parts![0]).toContain('<js>java.t2s(result)</js>')
        expect(parts![1]).toBe('.card-body.0@html')
    })

    it('切 `##` 时**不能**跳 `<js>` 块（块里写净化链是合法写法）', () => {
        // 阅文集团、茄子免费小说的规则就是 `<js>##正则##</js>`
        const rule = '<js>##(?m)\\|$</js>'
        expect(count(rule, '##', { skipJsBlocks: false, skipQuotes: false })).toBe(2)
        // 反过来，普通切分（默认跳过块）就不该切它
        expect(count(rule, '##')).toBe(0)
    })
})

describe('方括号与引号', () => {
    it('JSONPath 过滤器里的 && 不是连接符', () => {
        expect(splitRuleText('$.data.list[?(@.name&&@.author)]', '&&')).toBeNull()
    })

    it('引号里的连接符不是连接符', () => {
        expect(splitRuleText('@js:"a||b"', '||')).toBeNull()
        expect(splitRuleText('sel##"a||b"##x', '||', { skipQuotes: true })).toBeNull()
    })

    it('方括号外的连接符照常切', () => {
        expect(count('$.a||$.b', '||')).toBe(2)
        expect(count('sel[0]@text||sel[1]@text', '||')).toBe(2)
    })
})

describe('普通规则不受影响', () => {
    it('没有 JS 时行为与过去一致', () => {
        expect(splitRuleText('sel.0@text||sel.1@text', '||')).toEqual(['sel.0@text', 'sel.1@text'])
        expect(splitRuleText('@css:.x@text&&@css:.y@text', '&&')).toEqual([
            '@css:.x@text',
            '@css:.y@text',
        ])
        expect(splitRuleText('a@text%%b@text', '%%')).toEqual(['a@text', 'b@text'])
    })

    it('没有分隔符时返回 null（与「切出一块」区分开）', () => {
        expect(splitRuleText('sel@text', '||')).toBeNull()
        expect(splitRuleText('', '||')).toBeNull()
    })

    it('多段连接符都切出来', () => {
        expect(count('.a@text&&.b@text&&.c@text', '&&')).toBe(3)
    })
})

describe('净化链切分', () => {
    it('`@js:代码##正则##替换`：代码完整、净化链解析正确', () => {
        const rule = '@js:result.replace(/x/g,"")##(章)([^\\s]+)(\\s·)##$1 $2$3'
        const { selector, ops } = splitRegexChain(rule)
        expect(selector).toBe('@js:result.replace(/x/g,"")')
        expect(ops).toEqual([
            { pattern: '(章)([^\\s]+)(\\s·)', replacement: '$1 $2$3', onlyOne: false },
        ])
    })

    it('代码里引号内的 `##` 不会被当成分隔符', () => {
        const { selector, ops } = splitRegexChain(`@js:var sep = '##'; return sep`)
        expect(selector).toBe(`@js:var sep = '##'; return sep`)
        expect(ops).toEqual([])
    })

    it('没有 `##` 时原样返回', () => {
        const { selector, ops } = splitRegexChain('@js:return 1')
        expect(selector).toBe('@js:return 1')
        expect(ops).toEqual([])
    })

    it('普通净化链不受影响（含 OnlyOne 的收尾 ###）', () => {
        const { selector, ops } = splitRegexChain('#content@html##a##b###')
        expect(selector).toBe('#content@html')
        expect(ops).toEqual([{ pattern: 'a', replacement: 'b', onlyOne: true }])
    })

    it('`@#` 转义仍然有效', () => {
        const { selector, ops } = splitRegexChain('sel@text##a@#b##c')
        expect(selector).toBe('sel@text')
        expect(ops).toEqual([{ pattern: 'a#b', replacement: 'c', onlyOne: false }])
    })
})
