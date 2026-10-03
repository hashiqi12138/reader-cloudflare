/*
 * 阅读界面字号缩放的单元测试
 *
 * 接线（触摸事件、滚轮监听）在 `reader.js` 里，Node 跑不了；这里钉的是**手感与边界**：
 * 捏合算成多少号字、滚轮一格走几步、到了上下限会怎样。
 *
 * 用 `.mjs` 的理由与 replace / search / merge 相同：被测代码在 `public/` 下，
 * 不参与打包、也不进 tsconfig。
 */

import { describe, expect, it } from 'vitest'

import {
    DEFAULT_FONT_SIZE,
    MAX_FONT_SIZE,
    MIN_FONT_SIZE,
    clampFontSize,
    fontSizeFromPinch,
    fontSizeFromWheel,
    normalizeWheelDelta,
    stepFontSize,
    touchDistance,
} from '../public/js/zoom.js'

describe('clampFontSize', () => {
    it('夹在 14～30，并取整', () => {
        expect(clampFontSize(13)).toBe(MIN_FONT_SIZE)
        expect(clampFontSize(31)).toBe(MAX_FONT_SIZE)
        expect(clampFontSize(19.4)).toBe(19)
        expect(clampFontSize(19.6)).toBe(20)
        expect(clampFontSize(19)).toBe(19)
    })

    it('拿不到数就用默认值（而不是 NaN 崩掉排版）', () => {
        expect(clampFontSize(undefined)).toBe(DEFAULT_FONT_SIZE)
        expect(clampFontSize(null)).toBe(DEFAULT_FONT_SIZE)
        expect(clampFontSize('')).toBe(DEFAULT_FONT_SIZE)
        expect(clampFontSize('abc')).toBe(DEFAULT_FONT_SIZE)
        expect(clampFontSize(NaN)).toBe(DEFAULT_FONT_SIZE)
    })
})

describe('stepFontSize', () => {
    it('一次一号，到边界就停住', () => {
        expect(stepFontSize(19, 1)).toBe(20)
        expect(stepFontSize(19, -1)).toBe(18)
        expect(stepFontSize(MAX_FONT_SIZE, 1)).toBe(MAX_FONT_SIZE)
        expect(stepFontSize(MIN_FONT_SIZE, -1)).toBe(MIN_FONT_SIZE)
    })
})

describe('touchDistance', () => {
    it('两点距离（3-4-5）', () => {
        expect(
            touchDistance([
                { clientX: 0, clientY: 0 },
                { clientX: 3, clientY: 4 },
            ]),
        ).toBe(5)
    })

    it('不足两点时是 0（捏合还没成形）', () => {
        expect(touchDistance([{ clientX: 0, clientY: 0 }])).toBe(0)
        expect(touchDistance([])).toBe(0)
        expect(touchDistance(undefined)).toBe(0)
    })
})

describe('fontSizeFromPinch', () => {
    it('按距离比缩放：拉开一倍，字号翻倍（并夹在上下限内）', () => {
        expect(fontSizeFromPinch(16, 100, 200)).toBe(MAX_FONT_SIZE)
        expect(fontSizeFromPinch(16, 100, 150)).toBe(24)
        expect(fontSizeFromPinch(24, 100, 50)).toBe(MIN_FONT_SIZE)
    })

    it('**可逆**：捏回去就回到原来的字号（累加式实现做不到这一点）', () => {
        const opened = fontSizeFromPinch(18, 100, 160)
        expect(opened).toBeGreaterThan(18)
        expect(fontSizeFromPinch(18, 100, 100)).toBe(18)
        // 中途经过多少帧都一样：结果只取决于「起点 → 当前距离」
        expect(fontSizeFromPinch(18, 100, 160)).toBe(opened)
    })

    it('到上下限就夹住，继续捏也不会越界', () => {
        expect(fontSizeFromPinch(28, 100, 400)).toBe(MAX_FONT_SIZE)
        expect(fontSizeFromPinch(16, 100, 10)).toBe(MIN_FONT_SIZE)
    })

    it('起始距离为 0 或非法时不动（手势还没成形）', () => {
        expect(fontSizeFromPinch(19, 0, 100)).toBe(19)
        expect(fontSizeFromPinch(19, 100, 0)).toBe(19)
        expect(fontSizeFromPinch(19, -5, 100)).toBe(19)
    })
})

describe('normalizeWheelDelta', () => {
    it('像素 / 行 / 页三种模式归一成像素', () => {
        expect(normalizeWheelDelta(100, 0)).toBe(100)
        expect(normalizeWheelDelta(3, 1)).toBe(48)
        expect(normalizeWheelDelta(1, 2)).toBe(100)
        expect(normalizeWheelDelta(Infinity)).toBe(0)
    })
})

describe('fontSizeFromWheel', () => {
    it('鼠标滚轮：一格一步，向上滚是放大', () => {
        expect(fontSizeFromWheel(19, -100)).toEqual({ size: 20, carry: 0 })
        expect(fontSizeFromWheel(19, 100)).toEqual({ size: 18, carry: 0 })
    })

    it('滚得快就多走几步，但单次最多三步（惯性滚动不该一步跳到底）', () => {
        expect(fontSizeFromWheel(19, 200)).toEqual({ size: 17, carry: 0 })
        expect(fontSizeFromWheel(19, 1000)).toEqual({ size: 16, carry: 0 })
        expect(fontSizeFromWheel(19, -1000)).toEqual({ size: 22, carry: 0 })
    })

    it('触控板：小增量先攒着，够了才走一步，剩下的留着', () => {
        let size = 19
        let carry = 0
        const seen = []
        for (let i = 0; i < 4; i += 1) {
            const step = fontSizeFromWheel(size, 8, carry)
            size = step.size
            carry = step.carry
            seen.push(step.size)
        }
        // 8 → 8 → 8 → 8：前三帧攒着（32 时刚好走一步）
        expect(seen).toEqual([19, 19, 19, 18])
        expect(carry).toBe(2)
    })

    it('攒下来的量**有方向**：先往上滚再往下滚会抵消，不会残留一笔债', () => {
        const up = fontSizeFromWheel(19, -10)
        expect(up.size).toBe(19)
        const back = fontSizeFromWheel(19, 10, up.carry)
        expect(back.size).toBe(19)
        expect(back.carry).toBe(0)
    })

    it('到边界就夹住，而且不把「走过的空步」记成欠账', () => {
        let size = MAX_FONT_SIZE
        let carry = 0
        for (let i = 0; i < 10; i += 1) {
            const step = fontSizeFromWheel(size, -8, carry)
            size = step.size
            carry = step.carry
        }
        expect(size).toBe(MAX_FONT_SIZE)
        // 往回滚一次就该立刻变小，而不是先把刚才那十下「还」回来
        expect(fontSizeFromWheel(size, 100, carry).size).toBe(MAX_FONT_SIZE - 1)
    })

    it('增量为 0 什么都不做，累积量也不动', () => {
        expect(fontSizeFromWheel(19, 0, 7)).toEqual({ size: 19, carry: 7 })
        expect(fontSizeFromWheel(19, NaN, 7)).toEqual({ size: 19, carry: 7 })
    })
})
