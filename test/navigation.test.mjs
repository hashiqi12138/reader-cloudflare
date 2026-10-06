/*
 * 路由的「历史手感」（`public/js/core.js` 的 go / goBack）
 *
 * 这里钉住的是一件在界面上很难自己发现的事：**同一页里换内容不该压历史**。
 * 阅读界面读十章压十条记录的话，返回键按一次只退一章，得连按十次才回得到进来之前
 * 那一页 —— 用户看到的现象就是「返回要一章一章地退」。同一类问题还有登录页
 * （登录 → 首页 → 返回 → 登录页 → 又被弹回首页，返回键于是彻底按不动）。
 *
 * Node 里没有 location / history，所以给一组最小替身。关键的一条设计：
 * `location.hash` 的**写入会被记一笔** —— 「压了一条历史」与「换掉当前那条」的区别，
 * 正是这份测试要断言的东西，替身要是自己把两者抹平了，这里就永远绿。
 */

import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { go, goBack } from '../public/js/core.js'

let pushed = []
let replaced = []
let backs = 0
let events = []

/** 替身 location：写 hash 记一笔（真实浏览器里那一下同时会压一条历史） */
function fakeLocation(initial) {
    let hash = initial
    return {
        get hash() {
            return hash
        },
        set hash(value) {
            pushed.push(value)
            hash = value
        },
    }
}

beforeEach(() => {
    // 假定时器：`replace` 之后补的那次 `hashchange` 本来就是异步的，
    // 真时序会让「上一个用例挂起的那个定时器」漏到下一个用例里（实测过，会多一条）
    vi.useFakeTimers()
    pushed = []
    replaced = []
    backs = 0
    events = []
    globalThis.location = fakeLocation('#/home')
    globalThis.history = {
        length: 3,
        replaceState: (...args) => replaced.push(args),
        back: () => {
            backs += 1
        },
    }
    globalThis.window = { dispatchEvent: (event) => events.push(event.type) }
})

afterEach(() => {
    vi.useRealTimers()
})

describe('go：压一条历史，还是换掉当前那条', () => {
    it('默认压一条（返回键能回到刚才那一页）', () => {
        go('#/search')
        expect(pushed).toEqual(['#/search'])
        expect(replaced).toEqual([])
    })

    it('目标就是当前这个 hash 时什么都不做（不然点两下同一颗按钮会压两条）', () => {
        go('#/home')
        expect(pushed).toEqual([])
        expect(replaced).toEqual([])
    })

    it('replace: true 走 replaceState，不碰 location.hash —— 历史里不多一条', () => {
        go('#/read?index=2', { replace: true })
        expect(pushed).toEqual([])
        expect(replaced).toEqual([[null, '', '#/read?index=2']])
    })

    it('replace 之后补一次 hashchange（replaceState 自己不会派发），而且是异步的', () => {
        go('#/read?index=2', { replace: true })
        // 同步这一帧里还没有：路由收到事件会把当前视图整个换掉，
        // 同步跑等于在事件处理函数里把脚下那块 DOM 拆了（见 core.js 的说明）
        expect(events).toEqual([])
        vi.runAllTimers()
        expect(events).toEqual(['hashchange'])
    })

    it('压历史那条路照旧是同步改 hash（不派发合成事件）', () => {
        go('#/shelf')
        vi.runAllTimers()
        expect(events).toEqual([])
    })
})

describe('goBack：有上一页就回去，没有就退到兜底那一页', () => {
    it('历史里有上一页 → history.back()', () => {
        goBack('#/book?x=1')
        expect(backs).toBe(1)
        expect(pushed).toEqual([])
    })

    it('历史里只有当前这一条（直接打开或刷新一个分享链接）→ 退到兜底那一页', () => {
        globalThis.history.length = 1
        goBack('#/book?x=1')
        expect(backs).toBe(0)
        expect(pushed).toEqual(['#/book?x=1'])
    })

    it('没给兜底就什么都不做 —— 但绝不越权替用户决定去哪', () => {
        globalThis.history.length = 1
        goBack()
        expect(backs).toBe(0)
        expect(pushed).toEqual([])
    })
})

/*
 * 源码级防漂移：阅读界面的换章入口
 *
 * 上面那几条测的是 `go` 本身，而「换章要带 replace」是调用处的约定 —— 调用处忘了带，
 * `go` 这一层看不出任何异常，只有用户按返回键时才会发现。所以这里直接读源码：
 * 两个换章函数里必须有 `replace: true`，而且 `#/read` 这个模板在文件里**只该出现两处**
 * （多出来一处说明有人加了新的入口，得先想清楚它压不压历史）。
 */
describe('阅读界面：换章不压历史', () => {
    const source = readFileSync(new URL('../public/js/reader.js', import.meta.url), 'utf8')

    /** 从某个函数名往后取一段 —— 够覆盖它整个函数体 */
    const bodyOf = (name) => {
        const at = source.indexOf(`function ${name}(`)
        expect(at, `找得到 ${name}`).toBeGreaterThan(-1)
        return source.slice(at, at + 1200)
    }

    it('openChapter（上一章 / 下一章 / 目录跳章）带 replace', () => {
        const body = bodyOf('openChapter')
        expect(body).toContain('#/read?')
        expect(body).toContain('replace: true')
    })

    it('jumpTo（书签 / 笔记跳转）带 replace', () => {
        const body = bodyOf('jumpTo')
        expect(body).toContain('#/read?')
        expect(body).toContain('replace: true')
    })

    it('reader.js 里指向 #/read 的模板正好两处', () => {
        expect((source.match(/#\/read\?/g) ?? []).length).toBe(2)
    })

    it('阅读界面的返回按钮走 goBack（直接打开链接时 history.back() 是没反应的）', () => {
        // 匹配的是**调用**，注释里提到 `history.back()` 不算（说明为什么要换掉它）
        expect(source).not.toMatch(/=>\s*history\.back\(\)/)
        expect(source).toContain('goBack(')
    })
})
