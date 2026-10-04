/**
 * 兼容层的「表 ↔ 沙箱」一致性
 *
 * 这一层只有一张表（`JAVA_SURFACE`）和一个消费它的地方（`JAVA_PRELUDE` 末尾
 * 由 `unsupportedPrelude()` 生成的那一段）。表和实现漂移过一次就没人再敢信这张表，
 * 所以这里把它**钉死**：
 *
 *   - 表里说 `implemented` 的，沙箱预置里必须真的有
 *   - 表里说 `absent` 的，必须由 `unsupportedPrelude()` 生成（且报错里带自己的名字）
 *   - 表里说 `keep-absent` 的，**必须没有** —— 有书源靠 `typeof` 探测它来选分支
 *
 * 沙箱在 Node 里跑不起来（QuickJS 的 `.wasm`），所以这里不对 VM 断言，
 * 而是断言「生成出来的那段预置文本」。真跑起来的那一条在冒烟里（§15c）。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import {
    JAVA_SURFACE,
    WORKERS_PLATFORM,
    declaredImplementedNames,
    declaredKeepAbsentNames,
    javaMember,
    javaSurfaceSummary,
    unsupportedPrelude,
} from '../src/engine/platform'

/** 沙箱预置里手写实现的名字（`名字: function`，取 JAVA_PRELUDE 那一段） */
function sandboxImplementedNames(): Set<string> {
    const source = readFileSync(new URL('../src/engine/js.ts', import.meta.url), 'utf8')
    const start = source.indexOf('const JAVA_PRELUDE =')
    const end = source.indexOf('const GLOBALS_PRELUDE =')
    const prelude = source.slice(start, end)
    return new Set([...prelude.matchAll(/^\s{2}([A-Za-z_$][\w$]*): function /gm)].map((m) => m[1]!))
}

const sandbox = sandboxImplementedNames()
const unsupported = unsupportedPrelude()

describe('java 兼容层：表与沙箱预置一致', () => {
    it('表里说实现了的，沙箱预置里都有', () => {
        const missing = declaredImplementedNames().filter((name) => !sandbox.has(name))
        expect(missing, `这些在表里是 implemented，但预置里没有：${missing.join(', ')}`).toEqual([])
    })

    it('沙箱预置里的每一个 java 成员都在表里登记过（不能有「表外的私货」）', () => {
        const registered = new Set(JAVA_SURFACE.map((m) => m.name))
        // `__` 开头的是我们自己的内部管道（__req / __crypto），不是书源能看到的面
        const unregistered = [...sandbox].filter(
            (name) => !name.startsWith('__') && !registered.has(name),
        )
        expect(unregistered, `这些在预置里，但表里没有：${unregistered.join(', ')}`).toEqual([])
    })

    it('absent 的成员由 unsupportedPrelude() 生成，且报错里带自己的名字', () => {
        const absent = JAVA_SURFACE.filter((m) => m.support === 'absent')
        expect(absent.length).toBeGreaterThan(0)
        for (const member of absent) {
            expect(unsupported, member.name).toContain(`  ${member.name}: function () {`)
            expect(unsupported, member.name).toContain(`java.${member.name}`)
        }
    })

    it('keep-absent 的成员**必须不在**预置里（有书源靠 typeof 探测它来选分支）', () => {
        for (const name of declaredKeepAbsentNames()) {
            expect(sandbox.has(name), `${name} 不该出现在预置里`).toBe(false)
            expect(unsupported.includes(`${name}: function`), `${name} 不该被生成为桩`).toBe(false)
        }
    })

    it('生成的那一段不带反引号、也不带 ${（它要拼进模板字符串里）', () => {
        expect(unsupported).not.toContain('`')
        expect(unsupported).not.toContain('${')
    })
})

describe('java 兼容层：面与平台能力', () => {
    it('面的规模与分类是可观测的（/api/probe 用它报出「实现了多少」）', () => {
        const summary = javaSurfaceSummary()
        expect(summary.total).toBe(JAVA_SURFACE.length)
        expect(summary.implemented).toBeGreaterThan(30)
        expect(summary.implemented + summary.absent + summary.keepAbsent).toBe(summary.total)
    })

    it('当前平台只声明了「取网」——其余四项正是 absent 那一批的来源', () => {
        expect(WORKERS_PLATFORM).toEqual({
            http: true,
            webview: false,
            android: false,
            ui: false,
            filesystem: false,
        })
        // 反过来说：需要 WebView 的能力，一定被登记成 absent（不会悄悄变成「有」）
        const webviewMembers = JAVA_SURFACE.filter((m) => m.platform === 'webview')
        expect(webviewMembers.length).toBeGreaterThan(0)
        expect(webviewMembers.every((m) => m.support === 'absent')).toBe(true)
    })

    it('上游签名原样留着（语义对齐靠它：例如 get 在上游只有两参一个重载）', () => {
        expect(javaMember('get')?.upstream).toContain(
            'urlStr: String, headers: Map<String, String>',
        )
        expect(javaMember('ajax')?.upstream).toContain('url: Any')
        expect(javaMember('md5Encode')?.upstream).toBe('str: String')
        // 我们自加的成员没有上游签名
        expect(javaMember('put')?.upstream).toBeNull()
    })

    it('与上游不一样的地方都写进了 note（否则「实现了」会被读成「和上游一样」）', () => {
        for (const name of ['get', 'put', 't2s', 's2t', 'toast', 'sleep', 'searchBook']) {
            expect(javaMember(name)?.note, name).toBeTruthy()
        }
    })
})
