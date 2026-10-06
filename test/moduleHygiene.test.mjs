/*
 * 前端模块的 import 卫生：**import 进来的名字不许被同文件里的局部声明遮住**
 *
 * 起因是一个真事故（第八十一轮）：阅读界面为了取「详情页地址」而 `import { bookUrl }`，
 * 而那个文件里本来就有一个同名的局部常量（`const bookUrl = route.get('url')`，
 * 这本书的地址）。函数作用域里的局部声明**合法地**遮住了 import —— 语法上没问题、
 * `tsc` 不管 `public/`、单测也不 import 这个文件，于是直到有人在浏览器里打开
 * 阅读页才炸：「页面出错 / bookUrl is not a function」。
 *
 * 教训是**测试覆盖的缝**：冒烟只打 HTTP（`scripts/smoke.mjs` 全绿），单测也只测
 * `public/` 里那些纯计算模块，**没有任何自动化步骤真的渲染过阅读界面**。遮住 import
 * 这一类错正是那样漏出去的，所以单独在源码层面钉一条 —— 它便宜、确定，而且没有误报
 * （加这条时先扫了一遍现有 14 个模块：一个命中都没有）。
 */

import { readFileSync, readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** 目录用 URL 表示，`readFileSync` / `readdirSync` 都认 —— 免去 Windows 路径拼接 */
const DIR = new URL('../public/js/', import.meta.url)

/** 这个文件 import 进来的那些名字（`as` 之后取别名） */
function importedNames(source) {
    const out = new Set()
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
        for (const one of match[1].split(',')) {
            const part = one.trim()
            if (part === '') continue
            const [original, alias] = part.split(/\s+as\s+/)
            out.add((alias ?? original).trim())
        }
    }
    return out
}

/**
 * 被局部声明遮住的那些名字
 *
 * 只认**声明**（`const/let/var 名字`）。判据故意保守：`\b名字\b` 这种「出现过就算」
 * 会把正常用法（`go('#/home')`）也扫进来，那样的测试红一片、没人会看。
 * 参数位置的遮住（`function f(bookUrl)`）不在这里管 —— 那种写法一眼能看出来，
 * 而这个坑的形态是「顺手写了个同名 const」。
 */
function shadowedNames(source) {
    const hits = []
    for (const name of importedNames(source)) {
        // 名字可能有 `$`，转义一下再用（本项目的名字都是普通标识符，稳妥起见）
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`).test(source)) hits.push(name)
    }
    return hits
}

const modules = readdirSync(DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()

describe('前端模块：import 不被局部声明遮住', () => {
    it('至少扫到了这些模块（防止目录搬了之后这条静默失效）', () => {
        expect(modules.length).toBeGreaterThan(10)
        expect(modules).toContain('reader.js')
        expect(modules).toContain('views.js')
    })

    for (const name of modules) {
        it(`${name} 里没有遮住 import 的同名声明`, () => {
            const source = readFileSync(new URL(name, DIR), 'utf8')
            expect(shadowedNames(source)).toEqual([])
        })
    }

    it('这条判据真的抓得住（自己喂一份反例）', () => {
        const bad = [
            "import { bookUrl } from './views.js'",
            'function viewRead() {',
            "    const bookUrl = route.get('url')",
            '    return bookUrl',
            '}',
        ].join('\n')
        expect(shadowedNames(bad)).toEqual(['bookUrl'])
    })
})
