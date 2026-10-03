/*
 * 替换净化「账号同步」的纯逻辑测试
 *
 * 被测的是浏览器侧 `public/js/replaceSync.js`。这里只用不碰网络、不碰 DOM 的那几件：
 * 版本关系怎么判、条数怎么说、基准时间戳怎么存。真正发请求的那三个函数留给冒烟测试
 * （`scripts/smoke.mjs`）—— 它们的价值在于和 D1 里那一行对上，
 * 用一个自造的假 fetch 去测，测的是那个假 fetch。
 *
 * 文件是 `.mjs` 而不是 `.ts`，理由与 `replace.test.mjs` 相同：被测代码在 `public/` 下，
 * 不参与打包，也不该为了一个测试把它拉进类型检查。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { describeRules, loadSyncBase, saveSyncBase, syncState } from '../public/js/replaceSync.js'

// 被测代码用 localStorage，node 里没有 —— 一个 Map 就够，不必引 jsdom
const store = new Map()
globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
}

beforeEach(() => store.clear())

const rule = (enabled = true) => ({
    name: '',
    group: '默认',
    pattern: '广告',
    replacement: '',
    enabled,
})

describe('账号上那一份与本地的关系', () => {
    it('服务端从没同步过（updatedAt 0）就是 remote-empty', () => {
        expect(syncState({ rules: [], updatedAt: 0 }, 0)).toBe('remote-empty')
        expect(syncState(null, 123)).toBe('remote-empty')
    })

    it('时间戳与基准一致 = 同一个版本', () => {
        expect(syncState({ rules: [rule()], updatedAt: 500 }, 500)).toBe('same-version')
    })

    it('时间戳对不上 = 账号那份动过（多半是另一台设备）', () => {
        expect(syncState({ rules: [rule()], updatedAt: 900 }, 500)).toBe('moved')
        // 本机从没同步过，账号上却已经有：一样是「动过」，不能当成安全
        expect(syncState({ rules: [rule()], updatedAt: 900 }, 0)).toBe('moved')
    })

    it('空规则但有版本号，是「有人上传过一份空的」，不是没同步过', () => {
        // 用户真的把规则删光了并上传 —— 这时取回会把本机也清空，那是对的，
        // 判成 remote-empty 反而会让界面说「账号上还没有」，于是本机永远清不掉
        expect(syncState({ rules: [], updatedAt: 700 }, 700)).toBe('same-version')
    })

    it('只认时间戳，不比对内容：改一个空格也是改', () => {
        const a = syncState({ rules: [rule()], updatedAt: 500 }, 500)
        const b = syncState({ rules: [rule(false)], updatedAt: 500 }, 500)
        expect(a).toBe(b)
    })
})

describe('条数怎么说', () => {
    it('带上停用条数 —— 条数一样但启停不同，只看条数会得出「一模一样」', () => {
        expect(describeRules([rule(), rule(false)])).toBe('2 条（停用 1 条）')
    })

    it('没有停用时只报总数', () => {
        expect(describeRules([rule(), rule()])).toBe('2 条')
    })

    it('空的一份说「一条都没有」，而不是「0 条」', () => {
        expect(describeRules([])).toBe('一条都没有')
        expect(describeRules(null)).toBe('一条都没有')
    })

    it('脏数组不会让它抛错（这一行是用来显示提示的）', () => {
        expect(describeRules([null, rule()])).toBe('1 条')
    })
})

describe('基准时间戳存在本机', () => {
    it('没写过时是 0', () => {
        expect(loadSyncBase()).toBe(0)
    })

    it('写得进、读得出', () => {
        saveSyncBase(1728000000000)
        expect(loadSyncBase()).toBe(1728000000000)
    })

    it('写 0（或坏值）等于回到「没同步过」，而不是留一个 0', () => {
        saveSyncBase(123)
        saveSyncBase(0)
        expect(loadSyncBase()).toBe(0)
        saveSyncBase(123)
        saveSyncBase('不是数字')
        expect(loadSyncBase()).toBe(0)
    })

    it('库里存的是坏值时按 0 读，不返回 NaN', () => {
        localStorage.setItem('pref.replaceRules.syncedAt', 'abc')
        expect(loadSyncBase()).toBe(0)
    })
})
