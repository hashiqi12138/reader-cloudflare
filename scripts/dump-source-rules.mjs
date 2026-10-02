/** 打印指定书源的 exploreUrl 原文，用来确认脚本到底用了 source / cookie 的哪些成员 */
const { readFile } = await import('node:fs/promises')
const dump = JSON.parse(
    (await readFile(process.env.DUMP ?? 'live-explore-dump.json', 'utf8')).replace(/^\uFEFF/, ''),
)
const wanted = (process.argv[2] ?? '').split('|').filter(Boolean)

function sourcesOf(node) {
    const out = []
    for (const group of Array.isArray(node) ? node : []) {
        for (const hit of group.results ?? []) {
            if (typeof hit.payload !== 'string') continue
            try {
                out.push(JSON.parse(hit.payload))
            } catch {
                /* ignore */
            }
        }
    }
    return out
}

for (const source of sourcesOf(dump)) {
    if (!wanted.some((w) => source.bookSourceName.includes(w))) continue
    console.log(`\n===== ${source.bookSourceName} =====`)
    console.log(source.exploreUrl)
}
