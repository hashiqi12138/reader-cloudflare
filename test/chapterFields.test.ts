/**
 * 目录规则里那几条「逐条求值」的字段怎么读成值
 *
 * `tocFlag` / `tocText` 是第五十六轮加进来的：`ruleToc` 的 `isVip` / `isPay` /
 * `isVolume` / `updateTime` 与 `chapterName` 同层，以前整片丢掉。
 *
 * 这段判据值得单测，因为**语料里两套写法都真实存在**，而它们对「空 / 非空」的
 * 期待正好相反：
 *
 *   标记文本型：取到东西就是（`@css:.ndc-acc@text##注册会员`、锁图标 HTML）
 *   脚本布尔型：明明白白给 `true` / `false`（`<js> vip = … </js>`、`@js:!{{…}}`）
 *
 * 只按「非空即真」判，脚本回 `false` 的章会被当成要付费 —— 前端于是去拦一个
 * 本来能读的章。所以这条判据必须把 `false` / `0` 认出来。
 */

import { describe, expect, it } from 'vitest'

import { tocFlag, tocText } from '../src/legado/chapterFields'

describe('tocFlag：逐条字段的真假', () => {
    it('标记文本型：取到东西就是（语料里的两种写法）', () => {
        // 🌍🔞UAA小说 的 @css:.ndc-acc@text##注册会员
        expect(tocFlag('注册会员')).toBe(true)
        // ⚡📂企鹅阅读 的 .list@.lock@html —— 取到的是锁图标的 HTML
        expect(tocFlag('<i class="lock"></i>')).toBe(true)
        // 🏷磨铁中文 的 ¥{{$.free}}##¥true：免费章替换成空串
        expect(tocFlag('')).toBe(false)
        expect(tocFlag('   ')).toBe(false)
        expect(tocFlag(undefined)).toBe(false)
    })

    it('脚本布尔型：`false` / `0` 是「不是」，不能按「非空」当真的', () => {
        expect(tocFlag('true')).toBe(true)
        expect(tocFlag('True')).toBe(true)
        expect(tocFlag('1')).toBe(true)
        expect(tocFlag('false')).toBe(false)
        expect(tocFlag('false ')).toBe(false)
        expect(tocFlag('0')).toBe(false)
    })

    it('别的非空值一律当真的（`¥false` 这种替换没命中的残留也算）', () => {
        // 🏷磨铁中文：`$.free` 不是 true 时，`##¥true` 匹配不到，留下 `¥false`
        expect(tocFlag('¥false')).toBe(true)
        expect(tocFlag('null')).toBe(true)
    })
})

describe('tocText：逐条字段里的文本', () => {
    it('空串统一成 undefined（别让前端渲染出一片空白）', () => {
        expect(tocText('2024-05-16')).toBe('2024-05-16')
        expect(tocText('  2024-05-16  ')).toBe('2024-05-16')
        expect(tocText('')).toBeUndefined()
        expect(tocText('   ')).toBeUndefined()
        expect(tocText(undefined)).toBeUndefined()
        expect(tocText(null)).toBeUndefined()
    })

    it('一整串照原样留着（🏷晋江文学 那种 `12字•日期•简介` 不解析）', () => {
        expect(tocText('12字•2024-05-16•本章简介')).toBe('12字•2024-05-16•本章简介')
    })
})
