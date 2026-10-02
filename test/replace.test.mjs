/*
 * 替换净化规则的单元测试
 *
 * 这个测试文件是 `.mjs` 而不是 `.ts`：被测代码是**浏览器侧**的
 * `public/js/replace.js`（静态目录，不参与打包），而 tsconfig 只收 `src` 与 `test` 下的
 * `.ts` —— 用 TS 写会为了一个测试把整个 public 目录拉进类型检查。
 *
 * `localStorage` 相关函数（loadRules / saveRules）不在这里测：它们是三行读写，
 * 真正需要钉住的是「正则怎么编译」和「按什么顺序应用」这两件事。
 */

import { describe, expect, it } from 'vitest'

import { applyRules, compile, makeRule, PRESET_RULES } from '../public/js/replace.js'

const rule = (partial) => makeRule({ enabled: true, ...partial })

describe('规则编译', () => {
    it('默认带 g 与 m 两个 flag', () => {
        const re = compile(rule({ pattern: '广告' }))
        expect(re.flags).toContain('g')
        // 没有 m 的话 `^`/`$` 只匹配整段文字的首尾，「去掉空行」这类规则完全不工作
        expect(re.flags).toContain('m')
    })

    it('可以显式写 `##flags`，但不写 g 时仍会补上', () => {
        const re = compile(rule({ pattern: '^第.+章$##m' }))
        expect(re.flags).toContain('m')
        expect(re.flags).toContain('g')
        expect(re.source).toBe('^第.+章$')
    })

    it('不是合法正则时退化成纯文本替换，而不是报错', () => {
        // `(未完` 的左括号没闭合，编译必然失败 —— 这种写法在用户手输时很常见
        const compiled = compile(rule({ pattern: '(未完' }))
        expect(compiled.literal).toBe('(未完')
    })

    it('合法正则就按正则处理（书源的净化规则本来就是正则）', () => {
        const compiled = compile(rule({ pattern: '第\\d+章' }))
        expect(compiled instanceof RegExp).toBe(true)
    })

    it('空模式返回 null，表示这条规则不参与', () => {
        expect(compile(rule({ pattern: '' }))).toBeNull()
    })
})

describe('应用规则', () => {
    it('按列表顺序依次应用 —— 顺序不同结果就不同', () => {
        const text = '正文\n\n\n广告\n\n'
        const merge = rule({ pattern: '\\n{2,}', replacement: '\n' })

        // 先删广告再压缩空行：删完留下的三个空行被压成一个
        expect(applyRules(text, [rule({ pattern: '广告' }), merge])).toBe('正文\n')

        // 反过来：先压缩空行，再删广告 —— 广告那一行被删掉后，**又**空出一行
        expect(applyRules(text, [merge, rule({ pattern: '广告' })])).toBe('正文\n\n')
    })

    it('停用的规则不生效', () => {
        const rules = [rule({ pattern: '广告', enabled: false })]
        expect(applyRules('这里有广告', rules)).toBe('这里有广告')
    })

    it('删空行、去行首缩进这类规则真的按行生效', () => {
        const rules = [
            rule({ pattern: '^[ \\t]+', replacement: '' }),
            rule({ pattern: '\\n{2,}', replacement: '\n' }),
        ]
        expect(applyRules('  第一行\n\n\n    第二行', rules)).toBe('第一行\n第二行')
    })

    it('纯文本兜底：非法的正则写法按字面量替换', () => {
        const rules = [rule({ pattern: '(a.b', replacement: 'X' })]
        expect(applyRules('(a.b (aXb', rules)).toBe('X (aXb')
    })

    it('一条都不匹配时原样返回', () => {
        expect(applyRules('干净正文', [rule({ pattern: '广告' })])).toBe('干净正文')
    })

    it('空输入不会炸', () => {
        expect(applyRules('', [])).toBe('')
        expect(applyRules(undefined, [])).toBe('')
    })
})

describe('内置预设', () => {
    it('每条预设本身都能编译，且默认是启用的', () => {
        expect(PRESET_RULES.length).toBeGreaterThan(0)
        for (const preset of PRESET_RULES) {
            expect(preset.name).toBeTruthy()
            expect(compile(makeRule(preset))).not.toBeNull()
        }
    })

    it('「去掉网址」只吃网址，不吃正文', () => {
        const preset = PRESET_RULES.find((p) => p.name === '去掉网址')
        const out = applyRules('见 https://a.example.com/x 与正文', [makeRule(preset)])
        expect(out).not.toContain('https://')
        expect(out).toContain('正文')
    })

    it('「去掉空行」把连续空行压成一行', () => {
        const preset = PRESET_RULES.find((p) => p.name === '去掉空行')
        expect(applyRules('a\n\n\n\nb', [makeRule(preset)])).toBe('a\nb')
    })
})
