/**
 * 字段规则模板的单元测试
 *
 * 判断只有三种：里面是规则还是 JS、多余的 `@` 要不要剥、展开之后还算不算规则。
 * 判错的后果都一样 —— **静默取空**，所以逐条钉住。
 *
 * 下面所有写法都是从线上 816 条书源里 939 处真实字段模板里挑出来的，
 * 不是凭空想的例子。
 */

import { describe, expect, it } from 'vitest'

import {
    classifyTemplate,
    hasRuleSyntax,
    hasTemplate,
    stripRuleMarker,
    templateBody,
    templatePattern,
} from '../src/engine/template'

describe('模板内容分类', () => {
    it('JSONPath 是规则', () => {
        for (const text of [
            '$.id',
            '$.categories',
            '$.user.user.username',
            '$.data.majCate',
            '$.updateTimeFormat',
            '$._id',
        ]) {
            expect(classifyTemplate(text), text).toBe('rule')
        }
    })

    it('JSONPath 里带 `||` 仍然是规则（它是规则的同级连接符，不是 JS 的或）', () => {
        expect(classifyTemplate('$.originalCover||$.novelCover')).toBe('rule')
        expect(classifyTemplate('$.bookId||$.bid')).toBe('rule')
    })

    it('`##` 后面的正则里有 `?` 不算 JS 特征', () => {
        // 简介里这句带问号，误判成 JS 就会拿去求值、直接报错
        expect(classifyTemplate('$.desc##(^|[。！？]+[”」）】]?)##$1<br>')).toBe('rule')
        expect(classifyTemplate('$.tag[*].tagName##\\n##,')).toBe('rule')
    })

    it('JSONPath 上的三元表达式是 JS', () => {
        expect(classifyTemplate('$.score > 0 ? "评分：" + $.score : "评分：暂无评分"')).toBe('js')
        expect(classifyTemplate("$.a==1?'x':'y'")).toBe('js')
    })

    it('选择器类规则都是规则', () => {
        for (const text of [
            'h1@text',
            '@h1@text',
            '.mb-1@text',
            'class.novel-content@html',
            '@css:p.detail__summary__content@text',
            '[property$=description]@content',
            '@json:$.data',
            '//div[@class="x"]/a/text()',
            'id.jp_audio_0@src',
        ]) {
            expect(classifyTemplate(text), text).toBe('rule')
        }
    })

    it('java.xxx() 与字符串字面量是 JS', () => {
        expect(classifyTemplate("java.timeFormat(java.getString('$.update_time')*1000)")).toBe('js')
        expect(classifyTemplate("java.getString('$.freeStack')=='1'?'':'💲VIP'")).toBe('js')
        expect(classifyTemplate("'\\n&lrm;\\n'")).toBe('js')
        expect(classifyTemplate("String(java.getString('$.a'))")).toBe('js')
    })

    it('裸标识符是 JS（书源里它们都是沙箱全局或脚本变量）', () => {
        // `{{baseUrl}}` 要拿到页面地址、`{{title}}` 要拿到章节名，
        // 当规则求值只会得到一个叫 baseUrl 的标签选择器，结果必然为空
        for (const text of ['baseUrl', 'title', 'host', 'key', 'page']) {
            expect(classifyTemplate(text), text).toBe('js')
        }
    })

    it('赋值语句是 JS', () => {
        expect(classifyTemplate("step=java.getString('$.s')=='2'?'已完结':'连载中';")).toBe('js')
    })
})

describe('多余的 @ 前缀', () => {
    it('`@@` 这类冗余标记要剥掉，直到剩下真正的规则', () => {
        expect(stripRuleMarker('@@h1@text')).toBe('h1@text')
        expect(stripRuleMarker('@.mb-1@text##浏览：(.*)##$1浏览###')).toBe(
            '.mb-1@text##浏览：(.*)##$1浏览###',
        )
        expect(stripRuleMarker('@class.novel-content@html')).toBe('class.novel-content@html')
    })

    it('**但不剥 `@css:` 这类指令自己的前缀**', () => {
        // 多剥一层会把 `@css:p.detail@text` 变成 `css:p.detail@text`，整条规则失效
        expect(stripRuleMarker('@@@css:p.detail__summary__content@text')).toBe(
            '@css:p.detail__summary__content@text',
        )
        expect(stripRuleMarker('@css:.text-content1 .c-en@text||.text-content1@text')).toBe(
            '@css:.text-content1 .c-en@text||.text-content1@text',
        )
        expect(stripRuleMarker('@json:$.data')).toBe('@json:$.data')
        expect(stripRuleMarker('@XPath://div/a')).toBe('@XPath://div/a')
    })

    it('没有多余前缀时原样返回，并去掉两端空白', () => {
        expect(stripRuleMarker('  h1@text  ')).toBe('h1@text')
        expect(stripRuleMarker('$.id')).toBe('$.id')
    })
})

describe('展开之后还算不算规则', () => {
    it('只剩字面文本时不算规则（直接当结果用）', () => {
        // 这几条都是「模板 + 字面文本」，展开后就是最终值；
        // 当选择器去筛只会得到空串，症状正是「这个字段读不出来」
        expect(hasRuleSyntax('')).toBe(false)
        expect(hasRuleSyntax('第章')).toBe(false)
        expect(hasRuleSyntax('/api/tracks/')).toBe(false)
        expect(hasRuleSyntax('https://m.uaa.com/novel/intro?id=')).toBe(false)
        expect(hasRuleSyntax('/fixture/book/')).toBe(false)
        expect(hasRuleSyntax(',')).toBe(false)
    })

    it('还有规则语法时要继续当规则求值', () => {
        expect(hasRuleSyntax('#novel-content@html')).toBe(true)
        expect(hasRuleSyntax('##/book/##/chapter/')).toBe(true)
        expect(hasRuleSyntax("@js:qmDetail('')")).toBe(true)
        expect(hasRuleSyntax('h1@text')).toBe(true)
        expect(hasRuleSyntax('//div/a')).toBe(true)
        expect(hasRuleSyntax(':regex')).toBe(true)
    })
})

describe('模板正则', () => {
    it('非贪婪匹配，一条规则里的多个模板各自成段', () => {
        const found = [...'{{a}}{{b}}'.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1])
        expect(found).toEqual(['a', 'b'])
    })

    it('模板里可以有换行', () => {
        const found = [...'{{a\nb}}'.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1])
        expect(found).toEqual(['a\nb'])
    })

    it('每次都是新的正则对象（带 lastIndex 的全局正则并发会互相踩）', () => {
        const first = templatePattern()
        const second = templatePattern()
        expect(first).not.toBe(second)
        first.exec('{{a}}')
        expect(first.lastIndex).toBeGreaterThan(0)
        expect(second.lastIndex).toBe(0)
    })
})

/**
 * 单花括号的 `{$.路径}`
 *
 * 线上 63 处、28 个源（磨铁中文 `/pc/book/{$.id}/catalog`、新小书亭
 * `<br>{$.introduction}`、新人漫画 `/worksinfos/{$.attributes.wid}`）。
 * 旧实现把它整段当选择器解析 → **静默取空**。
 *
 * 这里同时钉住「不能放宽」的另一面：单花括号在别处太常见，认错了会改坏别的东西。
 */
describe('单花括号模板', () => {
    const bodies = (text: string): string[] =>
        [...text.matchAll(templatePattern())].map((m) => templateBody(m as RegExpExecArray))

    it('`{$.路径}` 认成模板（真实书源里的三种形态）', () => {
        expect(bodies('/pc/book/{$.id}/catalog')).toEqual(['$.id'])
        expect(bodies('<br>{$.introduction}')).toEqual(['$.introduction'])
        expect(bodies('/worksinfos/{$.attributes.wid}?include=chapters')).toEqual([
            '$.attributes.wid',
        ])
    })

    it('一条规则里的多个单花括号模板各自成段', () => {
        expect(bodies('/pc/book/{$.id}/catalog||/pc/book/{$.bookId}/catalog')).toEqual([
            '$.id',
            '$.bookId',
        ])
    })

    it('双花括号优先：`{{$.id}}` 不会被切成一个单花括号', () => {
        expect(bodies('{{$.id}}')).toEqual(['$.id'])
    })

    it('JS 模板串里的 `${...}` 不算 —— 那本来就是脚本代码', () => {
        // 少年梦阅读 / 得间小说就是这种写法，展开它等于把脚本改坏
        expect(bodies('`BookID=${$.data.id}&UserID=${uid}`')).toEqual([])
        expect(bodies('`${host}/category?categoryId=${$.categoryId}`')).toEqual([])
    })

    it('JSON、CSS、以及不以 `$.` 开头的花括号都不算', () => {
        // JSON 里只有那对双花括号是模板，外层的 `{` 一动不能动
        expect(bodies('{"method":"POST","body":"q={{key}}"}')).toEqual(['key'])
        expect(bodies('.x{color:red}')).toEqual([])
        expect(bodies('{key}')).toEqual([])
        expect(bodies('{{java.put("a",1)}}')).toEqual(['java.put("a",1)'])
    })

    it('`hasTemplate` 对两种形态都成立（它决定走不走模板那条求值路径）', () => {
        expect(hasTemplate('{{$.id}}')).toBe(true)
        expect(hasTemplate('/pc/book/{$.id}/catalog')).toBe(true)
        expect(hasTemplate('h1@text')).toBe(false)
        expect(hasTemplate('`${$.id}`')).toBe(false)
    })
})
