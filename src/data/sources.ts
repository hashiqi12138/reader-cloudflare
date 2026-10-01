/**
 * 书源注册表
 *
 * 当前阶段只提供内置的测试站点。真正要用的书源由使用者自己导入 ——
 * 规则引擎是中立的，具体指向哪个站点是使用者的选择。
 *
 * 后续接入 D1 后，这里会变成「内置源 + 用户导入源」的合并视图，
 * 因此现在就把「取一张表」和「按 id 找一条」这两件事拆成函数，
 * 到时候只改实现、不动调用方。
 */

import type { BookSource } from '../engine/types'

export interface RegisteredSource extends BookSource {
    /** 稳定标识。内置源用 `builtin:` 前缀，避免与用户导入的地址型 id 撞车 */
    id: string
    /** 是否内置（内置源不可删除，也不进用户的书源管理列表） */
    builtin: boolean
}

/** 内置测试站点的书源定义。地址随请求来源变化，因此按 origin 现造 */
export function fixtureSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-css',
        builtin: true,
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

/** 当前可用的书源列表 */
export function listSources(origin: string): RegisteredSource[] {
    return [fixtureSource(origin), fixtureXPathSource(origin), fixtureJsSource(origin)]
}

/** 按 id 取一条书源 */
export function findSource(origin: string, id: string): RegisteredSource | undefined {
    return listSources(origin).find((s) => s.id === id)
}
