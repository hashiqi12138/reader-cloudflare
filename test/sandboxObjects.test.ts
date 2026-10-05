/**
 * 沙箱里五个**对象全局**（source / book / chapter / cookie / cache）的面对齐
 *
 * 为什么是「读 `js.ts` 的文本」而不是「跑一遍沙箱」：`src/engine/js.ts` 顶层 import
 * 了 `RELEASE_ASYNC.wasm`（Workers 上唯一的加载方式），vitest 里加载不了 ——
 * 现有单测全都注入假的 `runInSandbox`，从不真的实例化沙箱。所以这里只做**文本级**的核对：
 *
 *   - 表里的每个方法名，都要在**它自己那个对象**的代码块里出现过（不是别的对象里的重名）
 *   - 表里写着「故意不做」的名字，不能出现在那个块里
 *
 * 行为（`cookie.getKey` 真的能取到键、`getLoginInfo` 读得回 `putLoginInfo` 的值……）
 * 由冒烟第 40 段对着真实引擎验 —— 与其它沙箱行为的验证方式一致。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { SANDBOX_OBJECTS } from './sandboxSurface'

const PRELUDE = readFileSync(new URL('../src/engine/js.ts', import.meta.url), 'utf8')

/**
 * 取某个对象那一段定义的文本
 *
 * 第五十九轮起这五个对象都改成了「工厂函数 + 一次调用」（`function __buildBook() {…}`
 * 紧跟 `var book = __buildBook()`）—— 这样预置文本在一个请求里只解析一次，
 * 每次求值只重新造一个对象（见 EXPERIENCE.md 第五十九轮）。这里跟着换一种取法：
 * 以「工厂函数开头」到「紧跟其后的 `var <名字> = __build…()`」为界。
 */
function blockOf(name: string): string {
    const factory = `function __build${name.charAt(0).toUpperCase()}${name.slice(1)}() {`
    const start = PRELUDE.indexOf(factory)
    if (start !== -1) {
        const endMark = `\n}\nvar ${name} = __build`
        const end = PRELUDE.indexOf(endMark, start)
        if (end === -1) throw new Error(`${name} 的工厂函数没有正常结束`)
        return PRELUDE.slice(start, end + 2)
    }
    // 兜底：还是老写法（`var xxx = (function () { … })()`）的对象
    const fallback = PRELUDE.indexOf(`var ${name} = (function () {`)
    if (fallback === -1) throw new Error(`js.ts 里找不到 ${name} 的定义`)
    const end = PRELUDE.indexOf('\n})()', fallback)
    if (end === -1) throw new Error(`${name} 的定义没有正常结束`)
    return PRELUDE.slice(fallback, end)
}

/** 这个名字在块里是不是被定义成了成员（赋值或对象字面量两种写法都认，别名也算） */
function defines(block: string, method: string): boolean {
    return new RegExp(`\\b${method}\\s*[:=]\\s*(?:function|[A-Za-z_$][\\w$.]*)`).test(block)
}

describe('沙箱对象的面与表一致（文本级）', () => {
    it('表里的每个方法名，都在它自己那个对象的代码块里定义过', () => {
        for (const [name, surface] of Object.entries(SANDBOX_OBJECTS)) {
            const block = blockOf(name)
            expect(block.length, `${name} 的代码块`).toBeGreaterThan(100)
            const missing = surface.methods.filter((method) => !defines(block, method))
            expect(missing, `${name} 的表里写着有、但代码块里没有`).toEqual([])
        }
    })

    it('表里写着「故意不做」的名字，不能出现在那个块里（否则记的是旧账）', () => {
        for (const [name, surface] of Object.entries(SANDBOX_OBJECTS)) {
            const block = blockOf(name)
            for (const method of Object.keys(surface.notDone)) {
                expect(defines(block, method), `${name}.${method} 其实已经有了`).toBe(false)
            }
        }
    })

    it('每个「故意不做」都写着理由，而且不与该对象的方法表重叠', () => {
        for (const [name, surface] of Object.entries(SANDBOX_OBJECTS)) {
            for (const [method, reason] of Object.entries(surface.notDone)) {
                expect(reason.length, `${name}.${method} 的理由太短`).toBeGreaterThan(10)
                expect(surface.methods, `${name}.${method}`).not.toContain(method)
            }
        }
    })

    it('方法名不重复（漏了去重会让表看着比实际大）', () => {
        for (const [name, surface] of Object.entries(SANDBOX_OBJECTS)) {
            expect(new Set(surface.methods).size, name).toBe(surface.methods.length)
        }
    })
})
