/**
 * 书源的四步链路：搜索 → 详情 → 目录 → 正文
 *
 * 每一步都是「拼 URL → 取回源码 → 按规则解析」这三拍的组合，
 * 差别只在用哪几条规则、以及上一步的结果怎么传下去。
 */

import {
  analyzeSelections,
  analyzeString,
  analyzeStrings,
  rootSelection,
  type Selection,
} from '../engine/analyze'
import type { BookSource, Chapter, RuleContext, SearchBook } from '../engine/types'
import { UpstreamError, fetchText } from '../lib/http'
import { buildPlan } from './source'

/** 把规则取到的地址补全成绝对地址（书源里相对路径很常见） */
function resolveUrl(value: string, base: string): string {
  const v = value.trim()
  if (!v) return ''
  try {
    return new URL(v, base).href
  } catch {
    return v
  }
}

/** 正文清洗：规整空白、去掉空行，但不动段落本身 */
export function normalizeContent(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\u00a0\u3000]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

/** 搜索：返回该书源上命中的书籍列表 */
export async function searchBooks(
  source: BookSource,
  keyword: string,
  ctx: RuleContext,
): Promise<SearchBook[]> {
  const rule = source.ruleSearch
  if (!source.searchUrl) throw new UpstreamError('书源未配置搜索地址（searchUrl）')
  if (!rule?.bookList) throw new UpstreamError('书源未配置书籍列表规则（ruleSearch.bookList）')

  const page = ctx.page ?? 1
  const plan = await buildPlan(source.searchUrl, source, { ...ctx, key: keyword, page })
  const html = await fetchText(plan)

  const base = plan.url
  const searchCtx: RuleContext = { ...ctx, key: keyword, page, baseUrl: base }
  const sel = rootSelection(html)
  const items = await analyzeSelections(sel, rule.bookList, searchCtx)

  const books: SearchBook[] = []
  for (const item of items) {
    const name = await analyzeString(item, rule.name ?? 'text', searchCtx)
    if (!name) continue

    const bookUrlRaw = await analyzeString(item, rule.bookUrl ?? 'tag.a@href', searchCtx)
    books.push({
      name,
      author: await analyzeString(item, rule.author ?? '', searchCtx),
      kind: (await analyzeString(item, rule.kind ?? '', searchCtx)) || undefined,
      lastChapter: (await analyzeString(item, rule.lastChapter ?? '', searchCtx)) || undefined,
      intro: (await analyzeString(item, rule.intro ?? '', searchCtx)) || undefined,
      coverUrl:
        resolveUrl(await analyzeString(item, rule.coverUrl ?? '', searchCtx), base) || undefined,
      wordCount: (await analyzeString(item, rule.wordCount ?? '', searchCtx)) || undefined,
      bookUrl: resolveUrl(bookUrlRaw, base),
      sourceName: source.bookSourceName,
      sourceUrl: source.bookSourceUrl,
    })
  }

  return books
}

/** 详情页：主要目的是拿到目录地址（tocUrl） */
export async function fetchBookInfo(
  source: BookSource,
  bookUrl: string,
  ctx: RuleContext,
): Promise<{ tocUrl: string; name: string; author: string; intro: string; coverUrl: string }> {
  const rule = source.ruleBookInfo
  if (!rule) {
    // 没有详情页规则时，直接把书籍地址当作目录地址 —— 很多站是这样的
    return { tocUrl: bookUrl, name: '', author: '', intro: '', coverUrl: '' }
  }

  const plan = await buildPlan(bookUrl, source, { ...ctx, baseUrl: bookUrl })
  const html = await fetchText(plan)
  const sel = rootSelection(html)
  const infoCtx: RuleContext = { ...ctx, baseUrl: plan.url }

  const tocUrlRaw = await analyzeString(sel, rule.tocUrl ?? '', infoCtx)

  return {
    tocUrl: tocUrlRaw ? resolveUrl(tocUrlRaw, plan.url) : plan.url,
    name: await analyzeString(sel, rule.name ?? '', infoCtx),
    author: await analyzeString(sel, rule.author ?? '', infoCtx),
    intro: await analyzeString(sel, rule.intro ?? '', infoCtx),
    coverUrl: resolveUrl(await analyzeString(sel, rule.coverUrl ?? '', infoCtx), plan.url),
  }
}

/** 目录页：返回章节列表 */
export async function fetchChapters(
  source: BookSource,
  tocUrl: string,
  ctx: RuleContext,
): Promise<Chapter[]> {
  const rule = source.ruleToc
  if (!rule?.chapterList) throw new UpstreamError('书源未配置目录列表规则（ruleToc.chapterList）')

  const plan = await buildPlan(tocUrl, source, { ...ctx, baseUrl: tocUrl })
  const html = await fetchText(plan)
  const sel = rootSelection(html)
  const tocCtx: RuleContext = { ...ctx, baseUrl: plan.url }

  const items = await analyzeSelections(sel, rule.chapterList, tocCtx)
  const chapters: Chapter[] = []

  for (const item of items) {
    const name = await analyzeString(item, rule.chapterName ?? 'text', tocCtx)
    const urlRaw = await analyzeString(item, rule.chapterUrl ?? 'tag.a@href', tocCtx)
    if (!name || !urlRaw) continue
    chapters.push({ name, url: resolveUrl(urlRaw, plan.url) })
  }

  return chapters
}

/** 正文：返回清洗后的文本 */
export async function fetchContent(
  source: BookSource,
  chapterUrl: string,
  ctx: RuleContext,
): Promise<string> {
  const rule = source.ruleContent
  if (!rule?.content) throw new UpstreamError('书源未配置正文规则（ruleContent.content）')

  const plan = await buildPlan(chapterUrl, source, { ...ctx, baseUrl: chapterUrl })
  const html = await fetchText(plan)
  const sel = rootSelection(html)
  const contentCtx: RuleContext = { ...ctx, baseUrl: plan.url }

  const values = await analyzeStrings(sel, rule.content, contentCtx)
  let text = values.join('\n')

  // 书源自带的净化正则
  if (rule.replaceRegex) {
    for (const part of rule.replaceRegex.split('\n')) {
      const line = part.trim()
      if (!line) continue
      const m = /^(.*?)##(.*?)##(.*)$/.exec(line)
      if (!m) continue
      try {
        text = text.replace(new RegExp(m[1]!, 'g'), m[3] ?? '')
      } catch {
        /* 单条净化规则写坏不影响正文本身 */
      }
    }
  }

  return normalizeContent(text)
}

/** 供上层复用：把一个已取回的页面变成规则求值上下文 */
export function pageSelection(html: string): Selection {
  return rootSelection(html)
}
