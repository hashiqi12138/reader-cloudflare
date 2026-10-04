/**
 * `loginUi` → 前端能渲染的表单定义
 *
 * `loginUi` 的 `type` 官方文档只写了三种（`text` / `password` / `button`），
 * 而语料 35 条里实际有六种（button 159 / text 40 / password 20 / toggle 8 /
 * select 7 / input 1）。这里的判据是**按有没有 `chars` 决定要不要当下拉**，
 * 不是按 type 硬编码 —— `toggle` 的语义文档里没写，但 8 处全是
 * `chars:["🔳","✅"], default:"🔳"` 这种「两个图标二选一」。
 *
 * 形态上只有 18/35 条是严格 JSON，另外 17 条得进沙箱（`@js:` / `<js>` /
 * 键没加引号的 JS 字面量），所以 `parseLoginUiJson` 只负责那条快路 ——
 * 严格 JSON 的源连沙箱都不用碰。下面的样例都取自线上语料。
 */

import { describe, expect, it } from 'vitest'

import { normalizeLoginForm, parseLoginUiJson } from '../src/legado/loginUi'

describe('normalizeLoginForm：数组 → 表单定义', () => {
    it('输入框按 type 分（⚡📂少年梦阅读 那种最小的）', () => {
        const form = normalizeLoginForm([
            { name: '账号', type: 'text' },
            { name: '密码', type: 'password' },
        ])
        expect(form.fields).toEqual([
            { name: '账号', type: 'text', rawType: 'text' },
            { name: '密码', type: 'password', rawType: 'password' },
        ])
        expect(form.buttons).toEqual([])
    })

    it('button 进 buttons，且不混进 fields（📂台湾小说网 的整个界面都是按钮）', () => {
        const form = normalizeLoginForm([
            { name: '检查访问状态', type: 'button', action: 'checkSite()' },
            { name: '打开网站', type: 'button', action: 'openSite()' },
        ])
        expect(form.fields).toEqual([])
        expect(form.buttons).toEqual([
            { name: '检查访问状态', action: 'checkSite()' },
            { name: '打开网站', action: 'openSite()' },
        ])
    })

    it('有 chars 就当下拉 —— select 与 toggle 都走这一条（🏷书旗小说 那两种）', () => {
        const form = normalizeLoginForm([
            { name: '评论主题', type: 'select', chars: ['自动', '浅色', '深色'], default: '自动' },
            { name: '段评开关', type: 'toggle', chars: ['🔳', '✅'], default: '🔳' },
        ])
        expect(form.fields[0]).toEqual({
            name: '评论主题',
            type: 'select',
            rawType: 'select',
            chars: ['自动', '浅色', '深色'],
            default: '自动',
        })
        // toggle 的语义文档里没写 —— 原样留着 type，前端可以照实显示
        expect(form.fields[1]).toEqual({
            name: '段评开关',
            type: 'select',
            rawType: 'toggle',
            chars: ['🔳', '✅'],
            default: '🔳',
        })
    })

    it('`default` 不在候选里就丢掉（否则前端会选中一个不存在的值）', () => {
        const form = normalizeLoginForm([
            { name: '线路', type: 'select', chars: ['a', 'b'], default: 'z' },
        ])
        expect(form.fields[0]!.default).toBeUndefined()
        expect(form.fields[0]!.chars).toEqual(['a', 'b'])
    })

    it('没有 chars 的未知 type 当文本框（语料里那个 `input`），并保留原 type', () => {
        const form = normalizeLoginForm([{ name: '关键字', type: 'input' }])
        expect(form.fields[0]).toEqual({ name: '关键字', type: 'text', rawType: 'input' })
    })

    it('action 是 http 地址的按钮给出 url（语料里 4 处）', () => {
        const form = normalizeLoginForm([
            { name: '帮助', type: 'button', action: 'https://example.com/help' },
        ])
        expect(form.buttons[0]).toEqual({
            name: '帮助',
            action: 'https://example.com/help',
            url: 'https://example.com/help',
        })
    })

    it('action 是空串的按钮照样留着（那是块说明牌，语料里 4 处）', () => {
        const form = normalizeLoginForm([{ name: '请先登录再搜索', type: 'button', action: '' }])
        expect(form.buttons).toEqual([{ name: '请先登录再搜索', action: '' }])
    })

    it('没有 name 的条目跳过，非对象条目也跳过', () => {
        const form = normalizeLoginForm([
            { type: 'text' },
            null,
            'x',
            { name: '   ' },
            { name: '账号', type: 'text' },
        ])
        expect(form.fields.map((f) => f.name)).toEqual(['账号'])
    })

    it('入参是 JSON 字符串时先剥一层（`result=JSON.stringify(all)` 那条路）', () => {
        const form = normalizeLoginForm('[{"name":"账号","type":"text"}]')
        expect(form.fields.map((f) => f.name)).toEqual(['账号'])
    })

    it('解不出来的东西只留一句原样文本，不抛错', () => {
        // 🔞 Linpx 那种「全是变量声明、最后一句不是值」的脚本求值出来可能是 undefined
        expect(normalizeLoginForm(undefined)).toEqual({ fields: [], buttons: [] })
        expect(normalizeLoginForm('这不是 JSON').note).toBe('这不是 JSON')
        expect(normalizeLoginForm({ a: 1 }).note).toBe('{"a":1}')
    })
})

describe('parseLoginUiJson：严格 JSON 的快路', () => {
    it('严格 JSON 解得出来（18/35 条走这条，连沙箱都不用碰）', () => {
        const form = parseLoginUiJson(
            '[{"name":"账号","type":"text"},{"name":"登录","type":"button"}]',
        )
        expect(form?.fields.map((f) => f.name)).toEqual(['账号'])
        expect(form?.buttons.map((b) => b.name)).toEqual(['登录'])
    })

    it('键没加引号的 JS 字面量解不出来 → 交给沙箱（8 条）', () => {
        expect(parseLoginUiJson('[ { name:"账号", type:"text" } ]')).toBeUndefined()
    })

    it('`@js:` / `<js>` 两种标记形态也解不出来 → 交给沙箱（9 条）', () => {
        expect(parseLoginUiJson('@js: var all=[]; result=JSON.stringify(all)')).toBeUndefined()
        expect(
            parseLoginUiJson("<js>JSON.stringify([{name:'a',type:'button'}])</js>"),
        ).toBeUndefined()
    })

    it('空 / 只有空白 → undefined（调用方据此判「没写登录界面」）', () => {
        expect(parseLoginUiJson('')).toBeUndefined()
        expect(parseLoginUiJson('   ')).toBeUndefined()
        expect(parseLoginUiJson(undefined)).toBeUndefined()
    })
})
