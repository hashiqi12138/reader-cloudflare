/**
 * 把线上真实书源导到本地 dev 环境，用于端到端验证「发现」链路。
 *
 * 本机对 *.workers.dev 的 DNS 被污染，线上接口调不通；但 wrangler 走的是
 * Cloudflare API，D1 能读能写 —— 于是用「线上取书源 → 本地导入」的方式拿到真实样本。
 */
import { readFileSync } from 'node:fs'

const raw = readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, '')
const parsed = JSON.parse(raw)
const rows = parsed[0]?.results ?? []
if (rows.length === 0) {
    console.error('没有取到书源')
    process.exit(1)
}

const sources = rows.map((r) => JSON.parse(r.payload))
console.error(`取到 ${sources.length} 个书源`)

// 接口有 4MB 体积上限，按体积切块而不是按条数 —— 单条书源大小差别很大
const LIMIT = 2 * 1024 * 1024
const batches = []
let batch = []
let size = 0
for (const source of sources) {
    const one = JSON.stringify(source).length
    if (batch.length > 0 && size + one > LIMIT) {
        batches.push(batch)
        batch = []
        size = 0
    }
    batch.push(source)
    size += one
}
if (batch.length > 0) batches.push(batch)

let imported = 0
for (const [i, chunk] of batches.entries()) {
    const res = await fetch('http://127.0.0.1:8787/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chunk),
    })
    const text = await res.text()
    if (res.status !== 200) {
        console.error(`第 ${i + 1} 批（${chunk.length} 条）-> ${res.status}: ${text.slice(0, 300)}`)
        continue
    }
    const report = JSON.parse(text)
    imported += report.imported ?? 0
    console.error(
        `第 ${i + 1}/${batches.length} 批：导入 ${report.imported} 条，拒绝 ${report.rejected?.length ?? 0} 条`,
    )
}
console.error(`合计导入 ${imported} 条`)
