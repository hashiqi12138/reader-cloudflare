/*
 * 沙箱里 jsoup 的**方法面** ↔ 宿主桥认得的 **op**：两张表必须一一对上（源码级扫描）
 *
 * 为什么要这道护栏：这两张表是**两份手抄**，而它们漂了两次，症状都极难查 ——
 *
 *   - **桥里根本没有 `data`**：📂少年小说网 的目录规则写的是
 *     `Jsoup.parse(result).select("style").first().data()`。调用在**沙箱那一侧**就炸了
 *     （`TypeError: not a function`），连桥的 `default:` 那句
 *     「org.jsoup 还不支持的方法：xxx()」都说不上 —— 既不像是选择器错，
 *     也不像是「明确不支持」，报错行号还指向规则里那一行。
 *   - **改文档的那几个**（`remove` / `addClass` / …）只在四份清单里的**一份**有，
 *     于是 `X.select(css).remove()` 只要 X 不是 `JsoupElements` 就炸（线上 8 处这么写）。
 *
 * 现在沙箱那侧只剩**一份** `JS_SURFACE`（见 `js.ts`），这道测试负责盯住它与桥别再漂开：
 * 少了 op 就红，多了 op（写了没人认）也红。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 桥认得、但**不该**出现在沙箱那份方法面上的 op
 *
 * - `toString`：每种包装各自实现（数组给集合的 outerHTML、盒装字符串给自己）
 * - `attrSet`：桥里的内部别名，沙箱从不发它（`attr` 带值那一路走的是 `case 'attr'`）
 */
const NOT_ON_SURFACE = new Set(['toString', 'attrSet'])

/** 沙箱那侧唯一的那份清单 */
function sandboxSurface(): string[] {
    const text = readFileSync('src/engine/js.ts', 'utf8')
    const block = /var JS_SURFACE = \[([\s\S]*?)\]/.exec(text)
    expect(block, 'js.ts 里找不到 `var JS_SURFACE = [...]`').not.toBeNull()
    return [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

/** 宿主桥的 switch 里认得的那些 op */
function bridgeOps(): Set<string> {
    const text = readFileSync('src/engine/jsoupBridge.ts', 'utf8')
    const ops = new Set<string>()
    for (const match of text.matchAll(/case '([A-Za-z]\w*)':/g)) ops.add(match[1]!)
    return ops
}

describe('沙箱的 jsoup 方法面与宿主桥的 op 必须一一对上', () => {
    const surface = sandboxSurface()
    const ops = bridgeOps()

    it('两张表都扫得出东西（不然这条测试永远是绿的）', () => {
        expect(surface.length).toBeGreaterThan(40)
        expect(ops.size).toBeGreaterThan(40)
        // 这一轮补上的三个，钉住它们不许再掉出去
        for (const name of ['data', 'selectFirst', 'remove']) expect(surface).toContain(name)
    })

    it('方法面上的每一个名字，桥都得认（否则脚本拿到的是 `not a function`）', () => {
        const missing = surface.filter((name) => !ops.has(name))
        expect(missing, `桥里没有这些 op：${missing.join(' / ')}`).toEqual([])
    })

    it('桥认得的每一个 op，要么在方法面上，要么写明了为什么不挂上去', () => {
        const extra = [...ops].filter((op) => !surface.includes(op) && !NOT_ON_SURFACE.has(op))
        expect(extra, `桥里有、但脚本够不到的 op：${extra.join(' / ')}`).toEqual([])
    })
})
