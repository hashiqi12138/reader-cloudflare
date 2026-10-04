/**
 * 沙箱预置的「静态段 / 每次求值段」必须对得上（第五十九轮）
 *
 * 第五十九轮把预置拆成两段，好让一个请求里的预置文本**只解析一次**（见 `js.ts` 里
 * `SandboxBatch` 与 `PER_EVAL_PRELUDE` 的说明）。拆的时候踩了两个坑，而且都是
 * **不报错、只出错值**那种，所以在这里钉住：
 *
 *   ① 尾段（`result` 的两种语义 + 登录表单）必须**两段共用** —— 第一版只把它放进
 *      「每次求值段」，于是不开批的普通求值里 `result` 不再被包成 jsoup 对象、
 *      登录表单也铺不进去。冒烟第 40 段那几条与第 45 段第 ④ 条当场报出来
 *      （「`result.size()` 不是函数」「`'result' is not defined`」）。
 *   ② 那五个全局对象必须是「工厂函数 + 一次调用」，不能就地改 —— 宿主每次求值注入的
 *      **裸数据**用的名字正好是 `book` / `chapter`，会直接把上一轮造好的对象盖掉，
 *      于是 `book.__refresh` 之类的就地刷新会报「not a function」。
 *
 * 只做文本级核对：`js.ts` 顶层 import 了 `.wasm`，vitest 里加载不了（同第五十三轮）。
 * 行为由冒烟第 43 段（同一批里每章的标注值不同、且上限守得住）与第 40 / 45 段验。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(new URL('../src/engine/js.ts', import.meta.url), 'utf8')

/** 抠出 `const NAME = \`…\`` 那一段模板字符串的**内容** */
function literalOf(name: string): string {
    const found = new RegExp('const ' + name + ' = `([\\s\\S]*?)`\\n').exec(SOURCE)
    if (!found) throw new Error(`js.ts 里找不到 ${name} 的模板字符串`)
    return found[1]
}

/** 五个「宿主注入裸数据」的全局对象与它们的工厂函数 */
const FACTORIES = [
    ['book', '__buildBook'],
    ['chapter', '__buildChapter'],
    ['source', '__buildSource'],
    ['cookie', '__buildCookie'],
    ['cache', '__buildCache'],
] as const

describe('沙箱预置：静态段 / 每次求值段', () => {
    it('五个全局对象都是「工厂 + 调用」，不留就地快照的老写法', () => {
        for (const [name, factory] of FACTORIES) {
            expect(SOURCE, `少了 ${factory} 的定义`).toContain(`function ${factory}() {`)
            expect(SOURCE, `${name} 没有用工厂造`).toContain(`var ${name} = ${factory}()`)
        }
        // 老写法（`var book = (function () { … })()`）一个都不该剩下 ——
        // 它就是「宿主注入的裸数据把对象盖掉」那个坑的来源
        expect(/var (book|chapter|source|cookie|cache) = \(function \(\) \{/.test(SOURCE)).toBe(
            false,
        )
    })

    it('「每次求值段」用到的名字，静态段里都得有定义', () => {
        const base = literalOf('PER_EVAL_PRELUDE_BASE')
        const names = [...FACTORIES.map(([, factory]) => factory), '__refreshVars']
        for (const name of names) {
            expect(base, `每次求值段里没调 ${name}`).toContain(name)
            expect(SOURCE, `静态段里没有 function ${name}(`).toContain(`function ${name}(`)
        }
        // 那几个对象必须先由工厂造出来才轮到别的（顺序反了就是 undefined）
        expect(base.indexOf('__refreshVars()')).toBeLessThan(base.indexOf('book = __buildBook()'))
    })

    it('尾段是两段共用的（只放进「每次求值段」的话，普通求值的 result 就废了）', () => {
        const tail = literalOf('PER_EVAL_TAIL')
        expect(tail).toContain('__resultAsJsoup')
        expect(tail).toContain('__loginFields')
        // 两处都要**拼**上它
        expect(SOURCE).toContain('GLOBALS_PRELUDE + PER_EVAL_TAIL')
        expect(SOURCE).toContain('PER_EVAL_PRELUDE_BASE + PER_EVAL_TAIL')
        // 而**不能**再写进那两个字面量内部（否则就是两份，迟早漂移）——
        // 查的是**语句**而不是名字：注释里提到这些名字是正常的
        expect(literalOf('GLOBALS_PRELUDE')).not.toContain('if (globalThis.__resultAsJsoup)')
        expect(literalOf('GLOBALS_PRELUDE')).not.toContain('__toJavaMap(globalThis.__loginFields)')
        expect(literalOf('PER_EVAL_PRELUDE_BASE')).not.toContain('if (globalThis.__resultAsJsoup)')
    })

    it('复用路径每次求值都清掉上一次的「回传值」（不清就会把旧登录头再落一次库）', () => {
        const base = literalOf('PER_EVAL_PRELUDE_BASE')
        for (const key of [
            '__sourceVariableOut',
            '__loginHeaderOut',
            '__loginInfoOut',
            '__cookieJarOut',
        ]) {
            expect(base, `没清 ${key}`).toContain(`delete globalThis.${key}`)
        }
        // 而**输入**一个都不能动（它们刚由宿主注入）
        expect(base).not.toContain('delete globalThis.result')
        expect(base).not.toContain('delete globalThis.book')
        expect(base).not.toContain('delete globalThis.chapter')
    })
})
