/**
 * 批量求值会话的**边界**（第六十一轮）
 *
 * 第五十九轮把批量求值做出来时只接了目录那条路（一个请求一个源，一批就够）。
 * 第六十一轮接到**搜索 / 发现**上：一页几个源共享一个 session，而 `openSandboxBatch`
 * 当时是「已经开着就直接复用」—— 于是 jsLib 不同的两个源会共用同一个 context，
 * 而静态预置与 jsLib **只跑一次**，`GetUL()` / `host()` 这类名字就漏到另一个源里了，
 * 而且**不报错**。所以这一轮的批改成「按 jsLib 分开」，这里把三件事钉住：
 *
 *   ① 建批与查表用的是**同一个字段**（`preludeJs`）—— 两边一旦漂移，批量求值会
 *      静默失效（只是变慢，看不出错），那是最难发现的一类退化
 *   ② 同一份 jsLib 复用时**记引用计数**，到 0 才销毁（一页三个源可以共用一批）
 *   ③ `openSandboxBatch` / `closeSandboxBatch` 在调用方那里**必须配成对** ——
 *      漏掉一个就是 WASM 内存泄漏，而它不会报错
 *
 * 只做文本级核对：`js.ts` 顶层 import 了 `.wasm`，vitest 里加载不了（同第五十三轮）。
 * 行为由冒烟第 47 段验（同一页里 jsLib 不同的两个源互不串味 + 逐条字段的值逐条判得出）。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const JS = readFileSync(new URL('../src/engine/js.ts', import.meta.url), 'utf8')
const OPS = readFileSync(new URL('../src/legado/ops.ts', import.meta.url), 'utf8')
const EXPLORE = readFileSync(new URL('../src/legado/explore.ts', import.meta.url), 'utf8')

describe('批量求值：一批绑一份 jsLib', () => {
    it('建批与查表用同一个字段（preludeJs），漂移了就是静默失效', () => {
        // 建批：键从 limits.preludeJs 来
        expect(JS).toContain("const key = limits.preludeJs ?? ''")
        // 查表：同一个字段
        expect(JS).toContain("const batchKey = limits.preludeJs ?? ''")
        expect(JS).toContain('session.batches.get(batchKey)')
        // 批上记着自己是谁预热的
        expect(JS).toContain('jsLib: key')
        // 键就是 jsLib，不能是「书源 id」之类 —— 同一份 jsLib 才允许共用一份上下文
        expect(JS, '批的键不该是书源 id').not.toContain('jsLib: source')
    })

    it('同一份 jsLib 复用时记引用计数，到 0 才销毁', () => {
        expect(JS).toContain('existing.holders += 1')
        expect(JS).toContain('batch.holders -= 1')
        expect(JS).toContain('if (batch.holders > 0) return')
        // 轮换要连引用计数一起搬过去（换的是上下文，不是「这一批」的账）
        expect(JS).toContain('const { holders, jsLib } = old')
        expect(JS).toContain('fresh.holders = holders')
    })

    it('轮换的时机在沙箱层，不在某一个调用方上', () => {
        expect(JS).toContain('const BATCH_ROTATE_EVALS = 400')
        // 换在求值**之前**（换在中间会把正在跑的那次求值打断）
        expect(JS).toContain('if (current && current.runs >= BATCH_ROTATE_EVALS)')
        expect(JS.indexOf('await rotateSandboxBatch(session, batchKey)')).toBeLessThan(
            JS.indexOf('const batch = session.batches.get(batchKey)'),
        )
        // 而目录那条路自己那份拷贝要删掉（留着就是两处轮换时机，迟早不一致）
        expect(OPS).not.toContain('BATCH_ROTATE_EVALS')
        expect(OPS).not.toContain('session.batch.runs')
    })

    it('每个调用方都配成对（漏一个就是 WASM 内存泄漏）', () => {
        for (const [name, text] of [
            ['ops.ts', OPS],
            ['explore.ts', EXPLORE],
        ] as const) {
            const opens = text.match(/openSandboxBatch\(session/g)?.length ?? 0
            const closes = text.match(/closeSandboxBatch\(session/g)?.length ?? 0
            expect(opens, `${name} 里一次开批都没有`).toBeGreaterThan(0)
            expect(closes, `${name} 里开批与关批不成对：${opens} vs ${closes}`).toBe(opens)
            // 关批要放在 finally 里（中途抛错也不能把 batch 丢在会话上）
            expect(text, `${name} 里关批不在 finally 里`).toContain('} finally {')
            // 而且要用**同一份** limits（批是按 jsLib 分的，换成另一份就关不掉那一批）
            expect(text).toContain('const batchLimits = sourceLimits(')
            expect(text).toContain('openSandboxBatch(session, batchLimits)')
            expect(text).toContain('closeSandboxBatch(session, batchLimits)')
        }
    })
})
