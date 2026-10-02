/**
 * 判定沙箱失败是不是**并发**引起的
 *
 * 现象：全量探测（8 并发）里有一批书源报
 *   Already suspended at: QuickJSAsyncifySuspended
 *   SyntaxError: unexpected token: 'undefined'
 * 而单独探测同一个书源时一切正常。
 *
 * 假设：asyncify 的「挂起」状态是整个 WASM 模块一份，不是每个 runtime 一份 ——
 * 同一个 isolate 里两个沙箱交错执行时，第二个一需要挂起（java.ajax）就撞上第一个。
 *
 * 做法：同一个书源，先 8 并发打 8 次，再串行打 8 次，比对失败数。
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const sourceId = process.env.SOURCE_ID ?? 'user:https://www.bilinovel.net'
const N = Number(process.env.N ?? '6')

async function once(tag) {
    const started = Date.now()
    try {
        const res = await fetch(`${BASE}/api/explore?sourceId=${encodeURIComponent(sourceId)}`)
        const raw = await res.text()
        const ms = Date.now() - started
        let body = {}
        try {
            body = JSON.parse(raw)
        } catch {
            /* 非 JSON：把开头打印出来，这类响应通常带着真正的原因 */
        }
        if (res.status !== 200) {
            const detail = body.error ?? raw.replace(/\s+/g, ' ').slice(0, 120)
            return `${tag}: 失败 HTTP ${res.status}（${ms}ms）${String(detail).slice(0, 90)}`
        }
        return `${tag}: 成功 ${body.count} 个分类（${ms}ms）`
    } catch (err) {
        return `${tag}: 异常 ${err.message.slice(0, 70)}`
    }
}

const concurrent = await Promise.all(Array.from({ length: N }, (_, i) => once(`并发#${i + 1}`)))
console.log('【并发】')
for (const line of concurrent) console.log('  ' + line)

const serial = []
for (let i = 0; i < N; i += 1) serial.push(await once(`串行#${i + 1}`))
console.log('【串行】')
for (const line of serial) console.log('  ' + line)

const count = (lines) => lines.filter((l) => l.includes('成功')).length
console.log(`\n并发成功 ${count(concurrent)}/${N}，串行成功 ${count(serial)}/${N}`)
