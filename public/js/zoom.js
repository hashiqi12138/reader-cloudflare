/*
 * 阅读界面的字号缩放：双指捏合（触屏）与 Ctrl/⌘ + 滚轮（桌面）
 *
 * 纯计算放在这里，接线在 `reader.js`。分成两块的理由很实际：**触摸事件在 Node 里没法真跑**，
 * 而「捏合该算成多少号字」「滚轮一格走几步」这些手感与边界的规则值得单测
 * （`test/zoom.test.mjs`）。
 *
 * 触屏与桌面这两条路其实是一回事：桌面上的触控板捏合，浏览器就是发**带 `ctrlKey` 的
 * wheel 事件**。所以两边都用同一套边界，手感也一致。
 */

/** 与 `core.js` 的 `prefKeys.fontSize` 同一组边界 —— 那边是最后一道闸，这里提前夹住 */
export const MIN_FONT_SIZE = 14
export const MAX_FONT_SIZE = 30
export const DEFAULT_FONT_SIZE = 19

/** 一次「鼠标滚轮格」大致这么多像素 */
const WHEEL_TICK = 100
/** 触控板的小增量累积到这个数才走一步 */
const WHEEL_CARRY_STEP = 30
/** 单次事件最多走几步：惯性滚动会一次送来几百像素，不该一步跳到底 */
const MAX_STEPS_PER_EVENT = 3

/**
 * 夹到合法范围并取整
 *
 * 取整不只是好看：字号每变一次就要**重新分页**，捏合时每帧都在算，
 * 小数会让「明明没变多少」也触发一次全章重排。
 */
export function clampFontSize(value) {
    // 空值与空串按「没给」处理：`Number(null)` 是 0，直接夹的话会掉到最小号，
    // 而「读到空值」显然该用默认字号
    if (value === null || value === undefined || value === '') return DEFAULT_FONT_SIZE
    const n = Number(value)
    if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(n)))
}

/** 键盘/按钮走一步（方向 +1 放大、-1 缩小） */
export function stepFontSize(current, direction) {
    return clampFontSize(clampFontSize(current) + Math.sign(direction))
}

/** 两指之间的距离。参数是 `TouchList`，测试里传数组也一样 */
export function touchDistance(points) {
    const a = points?.[0]
    const b = points?.[1]
    if (!a || !b) return 0
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/**
 * 双指捏合 → 字号
 *
 * **锚在「手势开始时的字号 × 距离比」上，而不是把每帧的增量累加。** 累加那种写法：
 * 手指抖一下、或者中途丢一帧，误差就永久留在字号里；而且捏出去再捏回来**回不到原来的
 * 字号**，用户会觉得「不跟手」。按距离比算天然可逆 —— 捏回原来的距离，字号就回到原值。
 */
export function fontSizeFromPinch(startSize, startDistance, distance) {
    if (!(startDistance > 0) || !(distance > 0)) return clampFontSize(startSize)
    return clampFontSize(startSize * (distance / startDistance))
}

/** 把滚轮增量归一成像素：`deltaMode` 1 是行、2 是页（Firefox 会送这两种） */
export function normalizeWheelDelta(deltaY, deltaMode = 0) {
    if (!Number.isFinite(deltaY)) return 0
    if (deltaMode === 1) return deltaY * 16
    if (deltaMode === 2) return deltaY * 100
    return deltaY
}

/**
 * Ctrl/⌘ + 滚轮 → 字号（连同还没用掉的累积量一起返回）
 *
 * 两种设备送来的增量差一个量级：鼠标一格约 100，触控板一次只有几像素、但来得很密。
 * 所以大的按「一格一步」，小的先累积到阈值再走 —— 不区分的话，要么鼠标滚一下跳好几号，
 * 要么触控板捏半天不动。
 *
 * 方向与浏览器一致：**向上滚（`deltaY < 0`）= 放大**。
 */
export function fontSizeFromWheel(current, deltaY, carry = 0, deltaMode = 0) {
    const delta = normalizeWheelDelta(deltaY, deltaMode)
    const size = clampFontSize(current)
    if (delta === 0) return { size, carry }

    if (Math.abs(delta) >= WHEEL_TICK) {
        // 鼠标滚轮：按格数走，累积量清掉（不留尾巴，否则快滚两下会突然多跳一步）
        const ticks = Math.round(delta / WHEEL_TICK)
        const steps = Math.max(-MAX_STEPS_PER_EVENT, Math.min(MAX_STEPS_PER_EVENT, ticks))
        return { size: clampFontSize(size - steps), carry: 0 }
    }

    const total = carry + delta
    const steps = Math.trunc(total / WHEEL_CARRY_STEP)
    if (steps === 0) return { size, carry: total }

    const applied = Math.max(-MAX_STEPS_PER_EVENT, Math.min(MAX_STEPS_PER_EVENT, steps))
    return {
        size: clampFontSize(size - applied),
        // 只扣掉真正用掉的那部分：超出的直接丢，不让它攒成下一次的跳跃
        carry: steps === applied ? total - applied * WHEEL_CARRY_STEP : 0,
    }
}
