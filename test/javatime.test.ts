/**
 * `java.timeFormat` 的单元测试
 *
 * 它是沙箱里的 `java.timeFormat` / `java.timeFormatUTC` 的实现，本身是纯函数，
 * 所以能在 Node 里逐条钉住 —— 格式串的替换规则错一位，表现是「时间显示得不对」，
 * 这种错很容易被当成书源的问题。
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_TIME_OFFSET_HOURS, formatJavaTime } from '../src/lib/javatime'

/** 便于书写：ISO 时间 → 毫秒时间戳 */
const at = (iso: string): number => Date.parse(iso)

describe('java.timeFormat', () => {
    it('默认格式是 yyyy-MM-dd HH:mm', () => {
        expect(formatJavaTime(at('2026-07-19T20:00:00Z'), undefined, 0)).toBe('2026-07-19 20:00')
        expect(formatJavaTime(at('2026-07-19T20:00:00Z'), '', 0)).toBe('2026-07-19 20:00')
    })

    it('默认时区是 +8（书源是按中文安卓设备的本地时间写的）', () => {
        const time = at('2026-07-19T20:00:00Z')
        expect(DEFAULT_TIME_OFFSET_HOURS).toBe(8)
        expect(formatJavaTime(time)).toBe('2026-07-20 04:00')
        // 这一条就是不用 UTC 的理由：UTC 下日期会退到前一天
        expect(formatJavaTime(time, undefined, 0)).toBe('2026-07-19 20:00')
    })

    it('时区偏移按小时生效，含非整数与负数', () => {
        const time = at('2026-07-19T20:00:00Z')
        expect(formatJavaTime(time, 'yyyy-MM-dd HH:mm', 8)).toBe('2026-07-20 04:00')
        expect(formatJavaTime(time, 'yyyy-MM-dd HH:mm', -5)).toBe('2026-07-19 15:00')
        expect(formatJavaTime(time, 'yyyy-MM-dd HH:mm', 5.5)).toBe('2026-07-20 01:30')
    })

    it('识别自定义格式', () => {
        const time = at('2026-07-19T20:04:05Z')
        expect(formatJavaTime(time, 'yyyy-MM-dd', 0)).toBe('2026-07-19')
        expect(formatJavaTime(time, 'yyyy/MM/dd HH:mm:ss', 0)).toBe('2026/07/19 20:04:05')
        expect(formatJavaTime(time, 'yy-M-d H:m:s', 0)).toBe('26-7-19 20:4:5')
        expect(formatJavaTime(time, 'yyyy年MM月dd日', 0)).toBe('2026年07月19日')
    })

    it('毫秒', () => {
        const time = at('2026-07-19T20:04:05.123Z')
        expect(formatJavaTime(time, 'ss.SSS', 0)).toBe('05.123')
        expect(formatJavaTime(time, 'ss.S', 0)).toBe('05.1')
        expect(formatJavaTime(time, 'ss.SS', 0)).toBe('05.12')
    })

    it('12 小时制：0 点与 12 点都显示成 12', () => {
        expect(formatJavaTime(at('2026-07-19T00:30:00Z'), 'h:mm', 0)).toBe('12:30')
        expect(formatJavaTime(at('2026-07-19T12:30:00Z'), 'h:mm', 0)).toBe('12:30')
        expect(formatJavaTime(at('2026-07-19T13:30:00Z'), 'hh:mm', 0)).toBe('01:30')
    })

    it('**不认识的记号按字面输出**，不拆成能认的部分', () => {
        // `yyy` 不是「yy + y」：拆开会拼出 26 和 6 这种数字，比原样输出更糟
        expect(formatJavaTime(at('2026-07-19T20:04:05Z'), 'yyy', 0)).toBe('yyy')
        // 季度、星期名、上午下午都没实现，按字面留着而不是猜一个值
        expect(formatJavaTime(at('2026-07-19T20:04:05Z'), 'MMMM', 0)).toBe('MMMM')
        expect(formatJavaTime(at('2026-07-19T20:04:05Z'), 'EEEE a', 0)).toBe('EEEE a')
        expect(formatJavaTime(at('2026-07-19T20:04:05Z'), "'第'yyyy'年'", 0)).toBe("'第'2026'年'")
    })

    it('时间不是数字时返回空串（而不是 Invalid Date）', () => {
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(formatJavaTime(bad, 'yyyy-MM-dd')).toBe('')
        }
        expect(formatJavaTime(Number('abc'), 'yyyy-MM-dd')).toBe('')
    })

    it('时间戳按**毫秒**解释（书源自己乘 1000）', () => {
        // 喜马拉雅那条规则是 `java.timeFormat(java.getString('$.update_time')*1000)`，
        // 也就是书源负责把秒换成毫秒；这里再自作聪明乘一次就会错得离谱
        expect(formatJavaTime(0, 'yyyy-MM-dd HH:mm', 0)).toBe('1970-01-01 00:00')
        expect(formatJavaTime(1_000, 'ss', 0)).toBe('01')
    })

    it('跨年边界', () => {
        expect(formatJavaTime(at('2025-12-31T16:30:00Z'), 'yyyy-MM-dd HH:mm')).toBe(
            '2026-01-01 00:30',
        )
    })
})
