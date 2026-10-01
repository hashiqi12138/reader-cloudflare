/**
 * 发现页分类的解析
 *
 * 从 `explore.ts` 拆出来，只因为它是**纯函数**：那边会把 QuickJS 的 WASM
 * 一起拉进来，而 WASM 在 Node 单测里跑不起来。分类解析恰好是最容易写错、
 * 又最该被测住的一段（三种写法、嵌套、相对地址）。
 */

import type { BookSource } from '../engine/types'

export interface ExploreCategory {
    title: string
    url: string
}

/** 分类数量上限：书源里写几千条只会把界面撑爆 */
export const MAX_CATEGORIES = 120

function looksLikeUrl(text: string): boolean {
    return /^(https?:\/\/|\/)/i.test(text.trim())
}

/**
 * 解析一行 `标题::地址`
 *
 * 「整条就是一个地址」那种写法在这里被接住：没有 `::` 就把它当成地址，
 * 标题用书源名 —— 这样只有一个分类的书源不必额外写一行标题。
 */
export function categoryFromLine(line: string, sourceName: string): ExploreCategory | null {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) return null

    if (!text.includes('::')) {
        if (!looksLikeUrl(text)) return null
        return { title: sourceName, url: text }
    }

    // `标题::地址::布局参数` —— 第三段起是排版提示（每行几个），本引擎用不上，忽略
    const [titlePart, urlPart] = text.split('::')
    const title = (titlePart ?? '').trim()
    const url = (urlPart ?? '').trim()
    if (url === '') return null
    return { title: title === '' ? sourceName : title, url }
}

function asCategory(item: unknown, sourceName: string, parentTitle = ''): ExploreCategory[] {
    if (typeof item === 'string') {
        const one = categoryFromLine(item, sourceName)
        return one ? [one] : []
    }
    if (!item || typeof item !== 'object') return []

    const box = item as { title?: unknown; name?: unknown; url?: unknown }
    const title = String(box.title ?? box.name ?? '').trim()
    const url = box.url

    // 嵌套：分类下面还有一层分类（Legado 的两级菜单）。拍平成 `父 · 子`
    if (Array.isArray(url)) {
        const prefix = title === '' ? parentTitle : title
        return url.flatMap((child) => asCategory(child, sourceName, prefix))
    }

    if (typeof url !== 'string' || url.trim() === '') return []
    const label = title === '' ? sourceName : title
    return [{ title: parentTitle === '' ? label : `${parentTitle} · ${label}`, url: url.trim() }]
}

/** 把脚本的返回值 / 文本解析成分类列表 */
export function parseExploreCategories(raw: unknown, source: BookSource): ExploreCategory[] {
    const name = source.bookSourceName
    const out: ExploreCategory[] = []

    if (Array.isArray(raw)) {
        for (const item of raw) out.push(...asCategory(item, name))
    } else if (typeof raw === 'string') {
        for (const line of raw.split('\n')) {
            const one = categoryFromLine(line, name)
            if (one) out.push(one)
        }
    } else if (raw && typeof raw === 'object') {
        // 有些脚本返回 `{ list: [...] }` 这种包一层的结果
        const box = raw as { list?: unknown; data?: unknown }
        const inner = box.list ?? box.data
        if (Array.isArray(inner)) for (const item of inner) out.push(...asCategory(item, name))
    }

    const seen = new Set<string>()
    const unique: ExploreCategory[] = []
    for (const item of out) {
        const key = `${item.title}\n${item.url}`
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(item)
        if (unique.length >= MAX_CATEGORIES) break
    }
    return unique
}
