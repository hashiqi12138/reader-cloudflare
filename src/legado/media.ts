/**
 * 媒体类书源的正文：图片 / 音频 / 文件
 *
 * 为什么必须按类型分流
 * -------------------
 * Legado 的 `bookSourceType` 决定 `ruleContent` 取回来的**是什么东西**，
 * 四种类型的语义完全不同：
 *
 *   | 类型 | ruleContent.content 取回     | 哪来的地址     |
 *   |------|------------------------------|----------------|
 *   | 0 文本 | 正文段落文字                 | 就是内容本身   |
 *   | 1 音频 | 一条音频直链                 | 章节地址本身或 content |
 *   | 2 图片 | 一堆 `<img>` 标签或图片地址   | content        |
 *   | 3 文件 | **不用 content**             | ruleBookInfo.downloadUrls |
 *
 * 之前四种类型全走文本那条路，后果分别是：
 *   - 图片源：`<img src="...">` 被当成正文，前端渲染成一段标签源码 —— 满屏 HTML
 *   - 音频源：正文里只有一条 URL 文本，没有播放器；content 为空的直接报「未配置正文规则」
 *   - 文件源：ruleContent 是空对象，同样报错，而真正的下载地址在 downloadUrls 里，压根没读
 *
 * 也就是说「读不出来」不是四个 bug，是一个：**把四种东西当成了一种**。
 */

import { analyzeStrings, rootSelection } from '../engine/analyze'
import {
    SOURCE_TYPE,
    type BookSource,
    type ChapterContent,
    type MediaLink,
    type RuleContext,
} from '../engine/types'
import { UpstreamError, fetchText } from '../lib/http'
import { extractImageLinks } from './mediaLinks'
import { collectContentPages, fetchContent, normalizeContent, resolveUrl } from './ops'
import { buildPlan, sandboxHttp } from './source'

/** 从下载地址里推出文件名，纯粹为了给用户一个可读的下载项标题 */
function fileNameOf(url: string): string | undefined {
    try {
        const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
        if (last === '') return undefined
        return decodeURIComponent(last)
    } catch {
        return undefined
    }
}

/** 图片源：content 取回的是图片地址（`<img>` 标签或裸 URL） */
async function fetchImages(
    source: BookSource,
    chapterUrl: string,
    ctx: RuleContext,
): Promise<ChapterContent> {
    const pages = await collectContentPages(source, chapterUrl, ctx)

    const images: MediaLink[] = []
    const seen = new Set<string>()
    for (const page of pages) {
        // 相对地址按**它自己那一页**补全：翻页之后图片常常挂在更深一层的目录下
        for (const link of extractImageLinks(page.raw, (candidate) =>
            resolveUrl(candidate, page.url),
        )) {
            if (seen.has(link.url)) continue
            seen.add(link.url)
            images.push(link)
        }
    }

    if (images.length === 0) {
        throw new UpstreamError(
            `图片源没有取到任何图片地址（共取回 ${pages.length} 页）。通常是 content 规则没匹配到图片，或站点改版了。`,
        )
    }
    return { kind: 'images', images }
}

/** 音频源：content 取回的是一条音频直链；不写 content 的源，章节地址本身就是直链 */
async function fetchAudio(
    source: BookSource,
    chapterUrl: string,
    ctx: RuleContext,
): Promise<ChapterContent> {
    const rule = source.ruleContent

    let candidate = ''
    let pageUrl = chapterUrl

    if (rule?.content) {
        const pages = await collectContentPages(source, chapterUrl, ctx)
        for (const page of pages) {
            // 一章就是一个音频文件，多值说明规则取宽了，取第一条
            const first = normalizeContent(page.raw)
                .split('\n')
                .find((line) => line.trim() !== '')
            if (first) {
                candidate = first.trim()
                pageUrl = page.url
                break
            }
        }
    }

    // 相当一部分音频源（喜马拉雅、asmr 这类接口型站点）根本不写 content，
    // 章节地址本身就是音频直链。这是规范内的正常写法，不是缺配置。
    if (candidate === '') candidate = chapterUrl

    const url = resolveUrl(candidate, pageUrl)
    if (!/^https?:\/\//i.test(url)) {
        const hint = rule?.sourceRegex
            ? '该书源用 sourceRegex 从 WebView 流量里嗅探音频地址，本引擎没有 WebView，因此取不到。'
            : '规则返回的不是一个网络地址。'
        throw new UpstreamError(
            `音频源没有取到可播放的直链：${hint}取到的是「${candidate.replace(/\s+/g, ' ').slice(0, 80)}」`,
        )
    }

    // 只有域名、没有路径的地址不是媒体文件。真实书源里这几乎总是
    // 「固定前缀 + 变量」的写法里变量取空了，拼出来只剩前缀（猫耳听书的
    // `'https://static.missevan.com/' + result` 就踩到过）。
    // 放行的话会变成一次毫无意义的代理请求，用户看到的是 502，看不见真正的原因。
    const parsed = new URL(url)
    if (parsed.pathname === '/' && parsed.search === '') {
        throw new UpstreamError(
            `音频源取到的是一个只有域名、没有文件路径的空地址：${url}。通常是规则里拼接的字段没取到值。`,
        )
    }
    return { kind: 'audio', audio: { url } }
}

/** 文件源：不走 ruleContent，下载地址在 ruleBookInfo.downloadUrls */
async function fetchDownloads(
    source: BookSource,
    chapterUrl: string,
    ctx: RuleContext,
): Promise<ChapterContent> {
    const rule = source.ruleBookInfo?.downloadUrls
    if (!rule || rule.trim() === '') {
        throw new UpstreamError('文件源没有配置下载地址规则（ruleBookInfo.downloadUrls）')
    }

    const plan = await buildPlan(chapterUrl, source, { ...ctx, baseUrl: chapterUrl })
    const html = await fetchText(plan)
    const sel = rootSelection(html)
    const values = await analyzeStrings(sel, rule, {
        ...ctx,
        baseUrl: plan.url,
        http: sandboxHttp(source, plan.url),
    })

    const downloads: MediaLink[] = []
    const seen = new Set<string>()
    // downloadUrls 常写成多行流水线，每行的结果又可能不止一个地址，
    // 所以「规则值」这一层还要再按行拆一次
    for (const value of values) {
        for (const line of value.split('\n')) {
            const raw = line.trim()
            if (raw === '') continue
            const url = resolveUrl(raw, plan.url)
            if (!/^https?:\/\//i.test(url)) continue
            if (seen.has(url)) continue
            seen.add(url)
            downloads.push({ url, name: fileNameOf(url) })
        }
    }

    if (downloads.length === 0) {
        throw new UpstreamError(
            '文件源没有取到下载地址。通常是 downloadUrls 规则没匹配到，或下载链接需要先登录。',
        )
    }
    return { kind: 'downloads', downloads }
}

/**
 * 取一章的内容，按书源类型返回对应形态
 *
 * 这是上层唯一的入口：路由不需要知道类型，也不需要知道有几种类型。
 */
export async function fetchChapterContent(
    source: BookSource,
    chapterUrl: string,
    ctx: RuleContext,
): Promise<ChapterContent> {
    switch (source.bookSourceType ?? SOURCE_TYPE.text) {
        case SOURCE_TYPE.image:
            return fetchImages(source, chapterUrl, ctx)
        case SOURCE_TYPE.audio:
            return fetchAudio(source, chapterUrl, ctx)
        case SOURCE_TYPE.file:
            return fetchDownloads(source, chapterUrl, ctx)
        default:
            return { kind: 'text', text: await fetchContent(source, chapterUrl, ctx) }
    }
}
