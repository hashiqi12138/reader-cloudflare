/*
 * 翻页几何的单元测试（列宽 / 页数）
 *
 * 接线（CSS 多列、translateX、rAF）在 `reader.js` 里，Node 跑不了；这里钉的是
 * **算式**——而算式正是「每翻一页偏一点」「末尾多出几页空白」这两类问题的根：
 *
 *   1. 步长必须是**布局给的**那一份（可能是小数），不能拿取过整的 `clientWidth`。
 *      差 0.5px，翻二十页就是 10px —— 正是「越翻越偏十几 px」那个量级。
 *   2. 页数必须按**当前**布局算。落伍一次就是末尾多几页空白（1083×838 下量到
 *      11 页、实际 8 列），计数器还照旧往前走。
 *
 * 用 `.mjs` 的理由与 replace / search / merge / zoom 相同：被测代码在 `public/` 下，
 * 不参与打包、也不进 tsconfig。
 */

import { describe, expect, it } from 'vitest'

import { pageCountOf, pagePitch } from '../public/js/pagination.js'

/** 一个假的段落：给它几段碎片（跨列时一个段落会有多个矩形） */
function paragraph(...lefts) {
    return { getClientRects: () => lefts.map((left) => ({ left })) }
}

/** 一个假的正文盒 */
function flow({ children = [], width = 1083, scrollWidth = 1083 } = {}) {
    return { children, scrollWidth, getBoundingClientRect: () => ({ width }) }
}

describe('pagePitch：翻一页位移多少', () => {
    it('有跨列的段落时，取相邻两列左边缘之差（**小数不许丢**）', () => {
        const pitch = pagePitch(flow({ children: [paragraph(22, 1105.4)] }))
        expect(pitch).toBeCloseTo(1083.4, 5)
        // 这一条是重点：取整成 1083 之后，翻二十页就差 8px
        expect(pitch).not.toBe(1083)
    })

    it('整章没有跨列的段落时，退回正文盒的宽（一列时它 = 列宽 + 列间距）', () => {
        const pitch = pagePitch(flow({ children: [paragraph(22), paragraph(22)], width: 1083.4 }))
        expect(pitch).toBeCloseTo(1083.4, 5)
    })

    it('挑的是**第一个**跨列的段落，前面的单列段落不该干扰', () => {
        const pitch = pagePitch(flow({ children: [paragraph(22), paragraph(22, 1105.4)] }))
        expect(pitch).toBeCloseTo(1083.4, 5)
    })

    it('拿不到正文盒时回 0（而不是 NaN 崩掉排版）', () => {
        expect(pagePitch(null)).toBe(0)
        expect(pagePitch(flow({ children: [], width: 0 }))).toBe(0)
    })
})

describe('pageCountOf：一共几页', () => {
    it('页数 = 布局里有几列（scrollWidth = n × 列距 − 左留白）', () => {
        expect(pageCountOf(8642, 1083)).toBe(8)
        expect(pageCountOf(1083, 1083)).toBe(1)
        expect(pageCountOf(16223, 1083)).toBe(15)
    })

    it('页数落伍的那一次会被纠正：11 页 → 真实的 8 列', () => {
        // 第六十二轮复现的那个数：计数器停在 11，而布局只有 8 列（末 3 页全空白）
        expect(pageCountOf(8642, 1083)).toBe(8)
        expect(pageCountOf(8642, 1083)).not.toBe(11)
    })

    it('列距拿不到时至少回 1 页（不能是 0 或 Infinity）', () => {
        expect(pageCountOf(8642, 0)).toBe(1)
        expect(pageCountOf(8642, NaN)).toBe(1)
        expect(pageCountOf(0, 1083)).toBe(1)
    })
})
