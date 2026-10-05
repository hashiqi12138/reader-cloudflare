/*
 * 前端调接口的**动词**必须与 `src/index.ts` 里声明的路由对得上（源码级扫描）
 *
 * 两类错都在这儿挡：
 *
 * 1. **路径/动词根本不存在** —— 比如 `patchJson('/api/shelf', …)`，而 `/api/shelf` 上
 *    只有 GET / POST / DELETE。服务端回 404，至少还能看出是接口不对。
 *
 * 2. **路径对了、但同一个路径上挂了好几个动词，请求体形状却不一样** —— 这一类**不报错**，
 *    只是被另一条路由接住，然后回一句听起来毫不相干的提示。这条路上真栽过一次：
 *
 *      `/api/sources` 上挂着四个动词 —— GET 列表、**POST 导入**、PATCH 启用/停用、DELETE 删除。
 *      书源行上那个「启用 / 停用」开关写的是 `postJson('/api/sources', { id, enabled })`，
 *      于是请求撞进了**导入**那条，用户看到的是「导入内容必须是书源数组」，
 *      而界面看起来完全正常，点下去才坏 —— 极难查。
 *
 *      所以第 2 条按**请求体**判：凡是从前端发出去、正文里带 `enabled` 字段的，
 *      必须是 PATCH。POST 那条只收书源 JSON 原文，不该出现这个字段。
 *
 * `npm run smoke` 扫不到第 2 类：它测的是**服务端**的 PATCH 好不好使，
 * 而错的是**前端**挑错了动词。
 *
 * 只扫**写死的**路径：查询串（`?id=…`）比到路径为止，模板字符串（动态路径）跳过 ——
 * 静态比不了的东西不在扫描范围里。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/** 这几个封装各自等价于哪个动词 */
const HELPER_METHOD: Record<string, string> = {
    postJson: 'POST',
    postAuth: 'POST',
    patchJson: 'PATCH',
}

/** `app.get('/api/sources', …)` 那一半 */
const ROUTE_RE = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g

/** 前半段：`postJson('/api/xxx'`；`api(path, { method })` 也走这里，动词另看 */
const CALL_RE = new RegExp(`\\b(${Object.keys(HELPER_METHOD).join('|')}|api)\\(\\s*'([^']+)'`, 'g')

/** `api('/api/progress', { method: 'PUT', … })` —— 动词写在选项里 */
const OPTION_METHOD_RE = /method:\s*'([A-Za-z]+)'/

/** 这一处调用之后多少字符之内算「它的参数」 */
const ARGS_WINDOW = 400

function routeTable(): Map<string, Set<string>> {
    const text = readFileSync(join('src', 'index.ts'), 'utf8')
    const table = new Map<string, Set<string>>()
    for (const match of text.matchAll(ROUTE_RE)) {
        const method = match[1]!.toUpperCase()
        const path = match[2]!
        // `app.get('*')` 是 SPA 回落，不是接口 —— 留着会把任何打错的路径都「接住」
        if (!path.startsWith('/api/')) continue
        if (!table.has(path)) table.set(path, new Set())
        table.get(path)!.add(method)
    }
    return table
}

function jsFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) jsFiles(path, out)
        else if (name.endsWith('.js')) out.push(path)
    }
    return out
}

interface Call {
    where: string
    method: string
    path: string
    /** 这一处调用的参数原文，用来判请求体形状 */
    args: string
}

/** 前端每一处写死的接口调用 */
function literalCalls(): Call[] {
    const calls: Call[] = []
    for (const file of jsFiles('public')) {
        const text = readFileSync(file, 'utf8')
        for (const match of text.matchAll(CALL_RE)) {
            const path = match[2]!
            if (!path.startsWith('/api/')) continue
            const at = match.index!
            const args = text.slice(at, at + ARGS_WINDOW)
            let method = HELPER_METHOD[match[1]!]
            if (!method) {
                // `api(...)`：动词在后面的选项里；读不到就不管（比如没有选项的 GET）
                const found = OPTION_METHOD_RE.exec(args)
                if (!found) continue
                method = found[1]!.toUpperCase()
            }
            const line = text.slice(0, at).split('\n').length
            calls.push({ where: `${file}:${line}`, method, path: path.split('?')[0]!, args })
        }
    }
    return calls
}

describe('前端调接口的动词必须与路由对得上', () => {
    const routes = routeTable()
    const calls = literalCalls()

    it('路由表本身要扫得出东西（不然这条测试永远是绿的）', () => {
        expect(routes.size).toBeGreaterThan(20)
        expect(routes.get('/api/sources')).toEqual(new Set(['GET', 'POST', 'PATCH', 'DELETE']))
    })

    it('前端的写死调用也要扫得出东西', () => {
        expect(calls.length).toBeGreaterThan(5)
    })

    it('每一处都在 src/index.ts 里有对应路由', () => {
        const missing = calls
            .filter((call) => !routes.get(call.path)?.has(call.method))
            .map((call) => {
                const allowed = [...(routes.get(call.path) ?? [])].join('/') || '（没有这条路由）'
                return `${call.where} 用了 ${call.method} ${call.path}，而服务端是 ${allowed}`
            })
        expect(missing).toEqual([])
    })

    it('带 enabled 字段的那种请求必须是 PATCH —— 同一个路径上 POST 是另一件事', () => {
        const wrong = calls
            .filter((call) => /\benabled\b/.test(call.args) && call.method !== 'PATCH')
            .map((call) => `${call.where} 把带 enabled 的请求发成了 ${call.method} ${call.path}`)
        expect(wrong).toEqual([])

        // 反向：确实存在这么两处（单条开关 + 批量），别把这条测试写成永远为空
        const toggles = calls.filter((call) => /\benabled\b/.test(call.args))
        expect(toggles.length).toBeGreaterThanOrEqual(1)
    })
})
