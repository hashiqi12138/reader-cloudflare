/*
 * DOM 构造层（`public/js/core.js` 的 el / append / setChildren）的单元测试
 *
 * 这一层只有一条职责：**空占位永远不能变成文本**。三元表达式里写
 * `cond ? node : null` 是最顺手的写法，而原生的 `replaceChildren` / `append` 会把那个
 * `null` 用 `String()` 变成 `"null"` 渲染出来 —— 书籍详情页真的出现过一次
 * （`host.replaceChildren(article, warning ? … : null, …)`，没有目录警告时页面上多一行 `null`）。
 *
 * Node 里没有 DOM，所以这里给一个**最小替身**：只实现被用到的那几个方法，
 * 而且 `append` 刻意照 DOM 的语义把非节点 `String()` 化 —— 替身要是自己把 null 过滤掉了，
 * 这个测试就永远绿，也就永远测不出那个 bug。
 *
 * 用 `.mjs` 的理由与 replace.test.mjs / search.test.mjs 相同：被测代码在 `public/` 下，
 * 不参与打包、也不进 tsconfig。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

class FakeText {
    constructor(data) {
        this.data = String(data)
    }
    get textContent() {
        return this.data
    }
    set textContent(value) {
        this.data = String(value)
    }
}

class FakeNode {
    constructor(tag) {
        this.tagName = tag
        this.childNodes = []
        this.attributes = {}
        this.dataset = {}
        this.className = ''
        this.disabled = false
    }
    /** 与 DOM 一致：读是子树文本的拼接，写是「清空 + 一个文本节点」 */
    get textContent() {
        return this.childNodes.map((child) => child.textContent).join('')
    }
    set textContent(value) {
        this.childNodes = value === '' ? [] : [new FakeText(value)]
    }
    append(...nodes) {
        for (const node of nodes) {
            const isNode = node instanceof FakeNode || node instanceof FakeText
            this.childNodes.push(isNode ? node : new FakeText(String(node)))
        }
    }
    replaceChildren(...nodes) {
        this.childNodes = []
        this.append(...nodes)
    }
    setAttribute(name, value) {
        this.attributes[name] = String(value)
    }
    addEventListener() {}
}

globalThis.Node = FakeNode
globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (data) => new FakeText(data),
    createDocumentFragment: () => new FakeNode('#fragment'),
}

// 动态 import：上面那几个全局必须在 core.js 求值之前就位
const { append, el, setChildren } = await import('../public/js/core.js')

/** 一棵替身树渲染出来的可见文字 */
const renderedText = (node) => node.textContent

describe('原生 DOM 方法会把 null 变成文本（这条就是那个 bug 的根源）', () => {
    it('replaceChildren(node, null) 真的渲染出 "null"', () => {
        const host = new FakeNode('div')
        host.replaceChildren(el('p', { text: '正文' }), null)
        expect(renderedText(host)).toBe('正文null')
    })

    it('append(null) 也一样', () => {
        const host = new FakeNode('div')
        host.append(null, undefined)
        expect(renderedText(host)).toBe('nullundefined')
    })
})

describe('el / append / setChildren 把空占位吃掉', () => {
    it('el 的子节点数组里 null / undefined / false 都不产出节点', () => {
        const node = el('div', {}, [
            el('p', { text: '甲' }),
            null,
            undefined,
            false,
            el('p', { text: '乙' }),
        ])
        expect(renderedText(node)).toBe('甲乙')
        expect(node.childNodes).toHaveLength(2)
    })

    it('append 同样过滤，并把字符串/数字变成文本节点', () => {
        const host = new FakeNode('div')
        append(host, [null, '字', 0, false, undefined])
        expect(renderedText(host)).toBe('字0')
    })

    it('setChildren 先清空再追加，空占位不产出文本', () => {
        const host = new FakeNode('div')
        host.replaceChildren(el('p', { text: '旧内容' }))
        setChildren(host, [el('p', { text: '新内容' }), null])
        expect(renderedText(host)).toBe('新内容')
        expect(host.childNodes).toHaveLength(1)
    })

    it('props 里的 null 不写进属性（`text: null` 保持空文本，而不是 "null"）', () => {
        const node = el('p', { text: null, title: null, class: 'x' })
        expect(node.textContent).toBe('')
        expect(node.attributes.title).toBeUndefined()
        expect(node.className).toBe('x')
    })

    it('setChildren 的 children 参数可以省（当清空用）', () => {
        const host = new FakeNode('div')
        setChildren(host, [el('p', { text: '甲' })])
        setChildren(host)
        expect(renderedText(host)).toBe('')
    })
})

// ---------------------------------------------------------------- 源码级护栏

/**
 * 直接调**原生** `replaceChildren` / `append` / `prepend` 的地方，如果顶层实参可能是 null，
 * 就会重演同一个 bug。上面那几个单测保护的是封装本身，这条保护的是「不许绕过封装」——
 * 否则下一个人在任意一个视图里写 `host.replaceChildren(a, cond ? b : null)` 又会中一次。
 *
 * 只看**顶层**实参：`el('div', {}, [cond ? a : null])` 里的 null 在嵌套调用内部，
 * 会被 el 自己的 append 吃掉，是安全的（这条区别弄错的话，这个测试会变成一片假阳性）。
 */
function topLevelNullArg(args) {
    let depth = 0
    let quote = ''
    for (let i = 0; i < args.length; i += 1) {
        const ch = args[i]
        if (quote !== '') {
            if (ch === '\\') i += 1
            else if (ch === quote) quote = ''
            continue
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch
            continue
        }
        if (ch === '(' || ch === '[' || ch === '{') depth += 1
        else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
        else if (depth === 0 && /^(:\s*(null|undefined))\b/.test(args.slice(i))) return true
    }
    return false
}

/** 从 `(` 开始找出配对的 `)` */
function matchParen(text, open) {
    let depth = 0
    let quote = ''
    for (let i = open; i < text.length; i += 1) {
        const ch = text[i]
        if (quote !== '') {
            if (ch === '\\') i += 1
            else if (ch === quote) quote = ''
            continue
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch
            continue
        }
        if (ch === '/' && text[i + 1] === '/') {
            const nl = text.indexOf('\n', i)
            i = nl === -1 ? text.length : nl
            continue
        }
        if (ch === '(') depth += 1
        else if (ch === ')') {
            depth -= 1
            if (depth === 0) return i
        }
    }
    return -1
}

function jsFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) jsFiles(path, out)
        else if (name.endsWith('.js')) out.push(path)
    }
    return out
}

describe('前端源码：不许把 null 直接交给原生 DOM 方法', () => {
    it('public/ 下每一处 replaceChildren / append / prepend 的顶层实参都不是可能为 null 的三元', () => {
        const root = 'public'
        const violations = []
        let checked = 0

        for (const file of jsFiles(root)) {
            const text = readFileSync(file, 'utf8')
            for (const call of ['replaceChildren', 'append', 'prepend']) {
                const needle = `.${call}(`
                for (let from = 0; ;) {
                    const at = text.indexOf(needle, from)
                    if (at < 0) break
                    from = at + needle.length
                    const open = at + needle.length - 1
                    const close = matchParen(text, open)
                    if (close < 0) continue
                    checked += 1
                    const args = text.slice(open + 1, close)
                    if (topLevelNullArg(args)) {
                        const line = text.slice(0, at).split('\n').length
                        violations.push(
                            `${file}:${line} ${call}(${args.replace(/\s+/g, ' ').slice(0, 90)})`,
                        )
                    }
                }
            }
        }

        // 扫描要有效：这些调用在 public/ 下本来就很多，一条都扫不到说明匹配逻辑坏了
        expect(checked).toBeGreaterThan(20)
        expect(violations).toEqual([])
    })
})
