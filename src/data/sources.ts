/**
 * 书源注册表
 *
 * 两类书源合在一起对外提供：内置的测试源由代码定义，用户导入的存 D1。
 * 之所以不把内置源也塞进库：它们是**代码的一部分**（跟着版本走、随时可能改规则），
 * 放进库里就会出现「部署了新版本，但库里的旧定义还在」这种两边不一致的状态。
 *
 * 真正要用的书源由使用者自己导入 —— 规则引擎是中立的，指向哪个站点是使用者的选择。
 */

import type { BookSource } from '../engine/types'
import { getUserSource, listUserSources } from './db'
import { BUILTIN_ID_PREFIX, type RegisteredSource } from './types'

export type { RegisteredSource }

/** 注册表选项 */
export interface RegistryOptions {
    /**
     * 是否把内置测试源算进来。
     *
     * 线上必须为 false：测试站点本身不挂载（ENABLE_FIXTURE=false），
     * 列出来只会得到三个「搜不到书」的书源，让人以为引擎坏了。
     */
    includeFixture: boolean
}

/** 内置测试站点的书源定义。地址随请求来源变化，因此按 origin 现造 */
export function fixtureSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-css',
        builtin: true,
        sortOrder: 0,
        bookSourceName: '内置测试站点（CSS 规则）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '项目自带的测试站点，用 @css: 规则驱动',
        bookSourceType: 0,
        enabled: true,

        searchUrl: `${origin}/fixture/search?q={{key}}&p={{page}}`,
        ruleSearch: {
            bookList: '@css:div.result-item',
            name: '@css:h3.title@text',
            author: '@css:span.author@text',
            kind: '@css:span.kind@text',
            intro: '@css:p.intro@text',
            bookUrl: '@css:h3.title a@href',
        },
        ruleBookInfo: {
            name: '@css:h1.book-name@text',
            author: '@css:span.book-author@text',
            intro: '@css:div.book-intro@text',
            tocUrl: '@css:a.toc-link@href',
        },
        ruleToc: {
            chapterList: '@css:ul.chapter-list li',
            chapterName: '@css:a@text',
            chapterUrl: '@css:a@href',
        },
        ruleContent: {
            content: '@css:div#content@textNodes',
        },
    }
}

/**
 * 同一个测试站点，改用 XPath 规则
 *
 * 存在的意义是**对照验证**：两套方言打同一个页面，提取结果必须完全一致。
 * 只测一套的话，XPath 这条路径上的问题（上下文节点、取属性、取文本节点）
 * 都可以被掩盖过去。
 */
export function fixtureXPathSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-xpath',
        builtin: true,
        sortOrder: 1,
        bookSourceName: '内置测试站点（XPath 规则）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '项目自带的测试站点，用 XPath 规则驱动，用于与 CSS 版本对照',
        bookSourceType: 0,
        enabled: true,

        searchUrl: `${origin}/fixture/search?q={{key}}&p={{page}}`,
        ruleSearch: {
            bookList: '//div[@class="result-item"]',
            name: '//h3[@class="title"]/a/text()',
            author: '//span[@class="author"]/text()',
            kind: '//span[@class="kind"]/text()',
            intro: '//p[@class="intro"]/text()',
            bookUrl: '//h3[@class="title"]/a/@href',
        },
        ruleBookInfo: {
            name: '//h1[@class="book-name"]/text()',
            author: '//span[@class="book-author"]/text()',
            intro: '//div[@class="book-intro"]/text()',
            tocUrl: '//a[@class="toc-link"]/@href',
        },
        ruleToc: {
            chapterList: '//ul[@class="chapter-list"]/li',
            chapterName: '//a/text()',
            chapterUrl: '//a/@href',
        },
        ruleContent: {
            content: '//div[@id="content"]//text()',
        },
    }
}

/**
 * 同一个测试站点，正文改由 `@js:` 脚本 + `java.ajax` 取
 *
 * 存在的意义是验证沙箱的**异步取网**：正文不在网页里，而是要走站点的 JSON
 * 接口再取一次。这正是真实书源里最常见的写法之一，也是 asyncify 存在的理由 ——
 * 脚本里 `java.ajax(url)` 是当同步函数用的，实际底层要挂起脚本去发请求。
 */
export function fixtureJsSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-js',
        builtin: true,
        sortOrder: 2,
        bookSourceName: '内置测试站点（JS + java.ajax 规则）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '项目自带的测试站点，正文用 @js + java.ajax 二次取数',
        bookSourceType: 0,
        enabled: true,

        searchUrl: `${origin}/fixture/search?q={{key}}&p={{page}}`,
        ruleSearch: {
            bookList: '@css:div.result-item',
            name: '@css:h3.title@text',
            author: '@css:span.author@text',
            kind: '@css:span.kind@text',
            intro: '@css:p.intro@text',
            bookUrl: '@css:h3.title a@href',
        },
        ruleBookInfo: {
            name: '@css:h1.book-name@text',
            author: '@css:span.book-author@text',
            intro: '@css:div.book-intro@text',
            tocUrl: '@css:a.toc-link@href',
        },
        ruleToc: {
            chapterList: '@css:ul.chapter-list li',
            chapterName: '@css:a@text',
            chapterUrl: '@css:a@href',
        },
        ruleContent: {
            // 从当前章节地址里取出章节号，再请求 JSON 接口拿正文
            content:
                `@js:(function(){` +
                `var id = baseUrl.split('/fixture/chapter/')[1];` +
                `if (!id) { throw new Error('无法从地址里解析出章节：' + baseUrl) }` +
                `var data = JSON.parse(java.ajax('${origin}/fixture/api/chapter/' + id));` +
                `return data.paragraphs.join('\\n')` +
                `})()`,
        },
    }
}

/** 内置测试源，仅在测试站点挂载时可用 */
export function builtinSources(origin: string): RegisteredSource[] {
    return [fixtureSource(origin), fixtureXPathSource(origin), fixtureJsSource(origin)]
}

/** 全部书源：内置（可选）在前，用户导入的在后 */
export async function listSources(
    db: D1Database,
    origin: string,
    options: RegistryOptions,
): Promise<RegisteredSource[]> {
    const builtin = options.includeFixture ? builtinSources(origin) : []
    return [...builtin, ...(await listUserSources(db))]
}

/** 搜索时真正参与的书源：只要启用的 */
export async function listEnabledSources(
    db: D1Database,
    origin: string,
    options: RegistryOptions,
): Promise<RegisteredSource[]> {
    const all = await listSources(db, origin, options)
    return all.filter((source) => source.enabled !== false)
}

/** 按 id 取一条书源 */
export async function findSource(
    db: D1Database,
    origin: string,
    id: string,
    options: RegistryOptions,
): Promise<RegisteredSource | undefined> {
    if (id.startsWith(BUILTIN_ID_PREFIX)) {
        // 测试站点没挂载时，这条内置源等于不存在 —— 直接当作找不到，而不是返回一个必然失败的书源
        if (!options.includeFixture) return undefined
        return builtinSources(origin).find((source) => source.id === id)
    }
    return getUserSource(db, id)
}
