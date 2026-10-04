/**
 * 生成 PWA 图标（`public/icon-*.png`）
 *
 *   node scripts/make-icons.mjs
 *
 * 为什么自己画而不是放几张现成的图：这个仓库里除了源码就是生成的资源
 * （`wrangler` 会把它原样发出去），图标也得**可复现** —— 换主题色时改一个常量重跑就行，
 * 不必去找设计稿。所以这里只用 `node:zlib` 手写 PNG（不引任何依赖）：
 * 先在 4 倍画布上画，最后缩回去 —— 边缘就没有锯齿。
 *
 * 图案：满幅的琥珀色方块 + 一本摊开的书（两页白纸 + 中间一道书脊缝 + 每页三行字）。
 * **满幅**是有意的：iOS 的 `apple-touch-icon` 会自己裁圆角，Android 的蒙版也会裁 ——
 * 留透明边的话，蒙版里会露出白底。`maskable` 那张把书缩小到安全区里（蒙版裁掉四周也认得出来）。
 */

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

// 与 `public/style.css` 里的默认强调色 / 纸色一致（`--accent` / `--paper`）
const AMBER = [180, 113, 42, 255] // #b4712a
const WHITE = [255, 255, 255, 255]

/** 4 倍超采样：先在大画布上画，最后按块平均缩下来（省掉自己写抗锯齿） */
const SS = 4

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
        let c = n
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c >>> 0
    }
    return table
})()

function crc32(bytes) {
    let c = 0xffffffff
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
}

/** 一张 RGBA 图 → PNG 字节（8 位深、颜色类型 6、无隔行） */
function encodePng(size, rgba) {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(size, 0)
    ihdr.writeUInt32BE(size, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // RGBA
    const stride = size * 4
    // 每行前面加一个 filter 字节（0 = None）
    const raw = Buffer.alloc((stride + 1) * size)
    for (let y = 0; y < size; y += 1) {
        raw[y * (stride + 1)] = 0
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ])
}

/** 画一张图标：`glyph` 是书占的宽度比例（0..1） */
function draw(size, glyph) {
    const big = size * SS
    const data = new Uint8Array(big * big * 4)

    const put = (x, y, [r, g, b, a]) => {
        if (x < 0 || y < 0 || x >= big || y >= big) return
        const i = (y * big + x) * 4
        data[i] = r
        data[i + 1] = g
        data[i + 2] = b
        data[i + 3] = a
    }
    /** 圆角矩形（坐标都是归一化的 0..1） */
    const roundRect = (x0, y0, x1, y1, radius, color) => {
        const [px0, py0, px1, py1, pr] = [x0, y0, x1, y1, radius].map((v) => v * big)
        for (let y = Math.floor(py0); y < Math.ceil(py1); y += 1) {
            for (let x = Math.floor(px0); x < Math.ceil(px1); x += 1) {
                // 四个角上按到圆心的距离裁一刀
                const cx = x < px0 + pr ? px0 + pr : x > px1 - pr ? px1 - pr : x
                const cy = y < py0 + pr ? py0 + pr : y > py1 - pr ? py1 - pr : y
                if ((x - cx) ** 2 + (y - cy) ** 2 > pr * pr) continue
                put(x, y, color)
            }
        }
    }

    // 满幅底色
    roundRect(0, 0, 1, 1, 0, AMBER)

    // 摊开的书：总宽 = glyph，高 = 0.78 * glyph，整体居中
    const w = glyph
    const h = glyph * 0.78
    const gx = 0.5 - w / 2
    const gy = 0.5 - h / 2
    const spine = w * 0.05 // 书脊缝
    const radius = w * 0.055
    roundRect(gx, gy, gx + w / 2 - spine / 2, gy + h, radius, WHITE)
    roundRect(gx + w / 2 + spine / 2, gy, gx + w, gy + h, radius, WHITE)

    // 每页三行「字」：留出页边距，行高一致
    const pad = w * 0.055
    const lineH = h * 0.06
    for (const [y0, y1] of [
        [gy + h * 0.28, gy + h * 0.28 + lineH],
        [gy + h * 0.47, gy + h * 0.47 + lineH],
        [gy + h * 0.66, gy + h * 0.66 + lineH],
    ]) {
        roundRect(gx + pad, y0, gx + w / 2 - spine / 2 - pad, y1, lineH / 2, AMBER)
        roundRect(gx + w / 2 + spine / 2 + pad, y0, gx + w - pad, y1, lineH / 2, AMBER)
    }

    // 缩回目标尺寸（块平均 = 抗锯齿）
    const out = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            let r = 0
            let g = 0
            let b = 0
            let a = 0
            for (let dy = 0; dy < SS; dy += 1) {
                for (let dx = 0; dx < SS; dx += 1) {
                    const i = ((y * SS + dy) * big + (x * SS + dx)) * 4
                    r += data[i]
                    g += data[i + 1]
                    b += data[i + 2]
                    a += data[i + 3]
                }
            }
            const n = SS * SS
            const o = (y * size + x) * 4
            out[o] = Math.round(r / n)
            out[o + 1] = Math.round(g / n)
            out[o + 2] = Math.round(b / n)
            out[o + 3] = Math.round(a / n)
        }
    }
    return out
}

/** 要生成哪几张：`any` 用满一点的图（桌面图标、iOS 自己裁圆角），`maskable` 缩到安全区 */
const TARGETS = [
    ['public/icon-192.png', 192, 0.62],
    ['public/icon-512.png', 512, 0.62],
    ['public/icon-maskable-512.png', 512, 0.44],
    ['public/apple-touch-icon.png', 180, 0.62],
]

for (const [file, size, glyph] of TARGETS) {
    writeFileSync(file, encodePng(size, draw(size, glyph)))
    console.log(`写好 ${file}（${size}×${size}）`)
}
