/**
 * `java.timeFormat` / `java.timeFormatUTC` 的实现
 *
 * 书源里给的是 Java `SimpleDateFormat` 的模式（`yyyy-MM-dd HH:mm`），JS 原生没有等价物，
 * 所以这里做一个够用的模式替换：认得的记号换成时间字段，认不得的原样输出
 * （`yyyy年MM月dd日` 里的「年月日」就是这么来的）。
 *
 * 只实现真实书源里出现过的记号。`E`（星期）、`a`（上午/下午）、`'引号字面量'` 没有实现 ——
 * 遇到时**按字面输出**，而不是猜一个可能不对的值出来。
 *
 * 放在宿主侧而不是沙箱预置脚本里，有两个原因：它是纯函数，能直接做单元测试；
 * 而沙箱里的东西在 Node 里跑不起来（要 WASM）。
 */

/** Legado 的默认格式 */
const DEFAULT_FORMAT = 'yyyy-MM-dd HH:mm'

/**
 * `java.timeFormat` 的默认时区偏移（小时）
 *
 * Legado 里它用的是**设备本地时间**，而 Worker 跑在 UTC 上、也没有「用户的设备」可言。
 * 这些书源是按中文安卓设备的本地时间写的（要别的时区时，书源会显式调用
 * `java.timeFormatUTC(时间, 格式, 偏移)`），所以这里跟 +8 对齐 ——
 * 用 UTC 会让「今天更新」的书显示成前一天。
 */
export const DEFAULT_TIME_OFFSET_HOURS = 8

/** 支持的记号：字母 → 允许出现的长度（按从长到短） */
const TOKEN_LENGTHS: Record<string, number[]> = {
    y: [4, 2],
    M: [2, 1],
    d: [2, 1],
    H: [2, 1],
    h: [2, 1],
    m: [2, 1],
    s: [2, 1],
    S: [3, 2, 1],
}

function pad(value: number, length: number): string {
    return String(Math.abs(value)).padStart(length, '0')
}

/** 取一个记号对应的值；不支持的组合返回 null（调用方按字面输出） */
function tokenValue(letter: string, length: number, at: Date): string | null {
    switch (letter) {
        case 'y':
            return length === 4 ? pad(at.getUTCFullYear(), 4) : pad(at.getUTCFullYear() % 100, 2)
        case 'M': {
            const month = at.getUTCMonth() + 1
            return length === 2 ? pad(month, 2) : String(month)
        }
        case 'd': {
            const day = at.getUTCDate()
            return length === 2 ? pad(day, 2) : String(day)
        }
        case 'H': {
            const hour = at.getUTCHours()
            return length === 2 ? pad(hour, 2) : String(hour)
        }
        case 'h': {
            // 12 小时制：0 点与 12 点都显示成 12
            const hour = at.getUTCHours() % 12 === 0 ? 12 : at.getUTCHours() % 12
            return length === 2 ? pad(hour, 2) : String(hour)
        }
        case 'm': {
            const minute = at.getUTCMinutes()
            return length === 2 ? pad(minute, 2) : String(minute)
        }
        case 's': {
            const second = at.getUTCSeconds()
            return length === 2 ? pad(second, 2) : String(second)
        }
        case 'S':
            return pad(at.getUTCMilliseconds(), 3).slice(0, length)
        default:
            return null
    }
}

/**
 * 按 Java 的时间模式格式化一个**毫秒**时间戳
 *
 * @param offsetHours 时区偏移（小时）。用「先平移再按 UTC 取值」的常规做法实现，
 *                    这样不必依赖运行时的本地时区（Worker 上是 UTC，本地可能是 +8，
 *                    两边结果必须一致，否则测试就白写了）
 */
export function formatJavaTime(
    time: number,
    format?: string,
    offsetHours: number = DEFAULT_TIME_OFFSET_HOURS,
): string {
    if (!Number.isFinite(time)) return ''

    const pattern = format !== undefined && format.trim() !== '' ? format : DEFAULT_FORMAT
    const offset = Number.isFinite(offsetHours) ? offsetHours : 0
    const at = new Date(time + offset * 3_600_000)

    let out = ''
    let i = 0
    while (i < pattern.length) {
        const ch = pattern[i]!

        // 连续相同的字母算一个记号；跑得比支持的长度还长就整段按字面输出
        // （`yyyy` 是年、`yyy` 不是 —— 拆成 `yy` + `y` 会拼出「26126」这种东西）
        if (!(ch in TOKEN_LENGTHS)) {
            out += ch
            i += 1
            continue
        }

        let end = i
        while (end < pattern.length && pattern[end] === ch) end += 1
        const runLength = end - i
        const letter = ch

        const value = TOKEN_LENGTHS[letter]!.includes(runLength)
            ? tokenValue(letter, runLength, at)
            : null
        out += value ?? pattern.slice(i, end)
        i = end
    }
    return out
}
