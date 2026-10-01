/**
 * 首页推荐位
 *
 * 内容来自各书源的**发现页**（exploreUrl）—— 书源作者已经把「推荐/热门/排行」
 * 这些栏目写在里面了，直接拿来用比我们自己猜一套推荐算法靠谱得多，
 * 也不需要任何用户行为数据。
 *
 * 三件事必须做对：
 *
 * 1. **缓存**。一次要打十几个外部站点，不缓存的话首页会慢到没人愿意打开，
 *    而且同一秒里几个用户同时进首页会把上游站点惹毛。缓存 30 分钟。
 * 2. **单源失败不影响整页**。`allSettled` + 逐个超时：某一家的发现页挂了、
 *    或者规则改版了，首页仍然应该出得来，只是少一块。
 * 3. **推荐顺序带一点个人化**。不是算法，就是「先推你书架里那些书源」——
 *    这一条能直接解释给用户听，也不需要任何埋点。
 */

import type { SearchBook } from '../engine/types'
import { listExploreCategories, exploreBooks } from '../legado/explore'
import type { BookSource } from '../engine/types'
import { DataError } from './types'

export interface HomeSection {
    sourceId: string
    sourceName: string
    category: string
    categoryUrl: string
    books: SearchBook[]
}

export interface HomePayload {
    sections: HomeSection[]
    /** 这次构建里失败的书源（名字），用来把「首页少了一块」说清楚 */
    failures: string[]
    builtAt: number
}

/** 缓存有效期：30 分钟。够挡住刷新风暴，又不会让推荐位看起来一成不变 */
export const HOME_TTL_MS = 30 * 60 * 1000

/** 参与推荐的书源数量上限 */
const MAX_SOURCES = 4

/** 单个书源的整体超时。发现页慢到超过这个数，就不等它了 */
const PER_SOURCE_TIMEOUT_MS = 8000

/** 每个推荐位展示几本 */
const BOOKS_PER_SECTION = 8

const HOME_SCOPE = 'home'

/** 优先挑这类栏目的名字，它们最像「推荐」 */
const PREFERRED_CATEGORY = /推荐|热门|排行|最新|完结|精选|榜单|必看|top/i

export async function readHomeCache(db: D1Database): Promise<HomePayload | null> {
    const row = await db
        .prepare('SELECT payload, built_at FROM home_cache WHERE scope = ?')
        .bind(HOME_SCOPE)
        .first<{ payload: string; built_at: number }>()
    if (!row) return null
    if (Date.now() - row.built_at > HOME_TTL_MS) return null

    try {
        const parsed = JSON.parse(row.payload) as HomePayload
        return { ...parsed, builtAt: row.built_at }
    } catch {
        // 缓存内容坏了不该让首页打不开：当作没有缓存，重建
        return null
    }
}

export async function writeHomeCache(db: D1Database, payload: HomePayload): Promise<void> {
    await db
        .prepare(
            `INSERT INTO home_cache (scope, payload, built_at) VALUES (?, ?, ?)
             ON CONFLICT(scope) DO UPDATE SET payload = excluded.payload, built_at = excluded.built_at`,
        )
        .bind(
            HOME_SCOPE,
            JSON.stringify({ sections: payload.sections, failures: payload.failures }),
            payload.builtAt,
        )
        .run()
}

/** 给一个 Promise 套超时；超时按失败处理，不拖住整页 */
async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            task,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new DataError(`${label} 超时`, 504, 'timeout')), ms)
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

/** 从书源的分类里挑一个最像「推荐」的 */
function pickCategory(
    categories: { title: string; url: string }[],
): { title: string; url: string } | null {
    if (categories.length === 0) return null
    return categories.find((c) => PREFERRED_CATEGORY.test(c.title)) ?? categories[0]!
}

/**
 * 构建推荐位
 *
 * @param preferredSourceIds 书架里出现过的书源 —— 排在前面，作为最轻量的「个人化」
 */
export async function buildHomeSections<T extends BookSource>(
    sources: T[],
    preferredSourceIds: string[],
    idOf: (source: T) => string,
): Promise<{ sections: HomeSection[]; failures: string[] }> {
    const eligible = sources.filter(
        (s) => (s.exploreUrl ?? '').trim() !== '' && s.ruleExplore?.bookList,
    )
    const preferred = new Set(preferredSourceIds)

    const ordered = [...eligible].sort((a, b) => {
        const pa = preferred.has(idOf(a)) ? 0 : 1
        const pb = preferred.has(idOf(b)) ? 0 : 1
        if (pa !== pb) return pa - pb
        return a.bookSourceName.localeCompare(b.bookSourceName, 'zh-Hans-CN')
    })

    const picked = ordered.slice(0, MAX_SOURCES)
    const failures: string[] = []

    const settled = await Promise.allSettled(
        picked.map((source) =>
            withTimeout(
                (async (): Promise<HomeSection | null> => {
                    const categories = await listExploreCategories(source, {
                        baseUrl: source.bookSourceUrl,
                    })
                    const category = pickCategory(categories)
                    if (!category) return null

                    const result = await exploreBooks(source, category.url, 1, {
                        baseUrl: source.bookSourceUrl,
                    })
                    if (result.books.length === 0) return null

                    return {
                        sourceId: idOf(source),
                        sourceName: source.bookSourceName,
                        category: category.title,
                        categoryUrl: category.url,
                        books: result.books.slice(0, BOOKS_PER_SECTION),
                    }
                })(),
                PER_SOURCE_TIMEOUT_MS,
                `发现页（${source.bookSourceName}）`,
            ),
        ),
    )

    const sections: HomeSection[] = []
    settled.forEach((outcome, index) => {
        const name = picked[index]?.bookSourceName ?? '?'
        if (outcome.status === 'fulfilled') {
            if (outcome.value) sections.push(outcome.value)
            else failures.push(`${name}：发现页里没有取到书`)
        } else {
            const reason = outcome.reason
            failures.push(`${name}：${reason instanceof Error ? reason.message : String(reason)}`)
        }
    })

    // 全是空的说明推荐这条路当前走不通（书源都没探索页，或站点都挂了）
    if (sections.length === 0 && eligible.length === 0) {
        failures.push('没有一个书源配置了发现页（exploreUrl），先去「书源」里导入带探索页的源')
    }

    return { sections, failures }
}
