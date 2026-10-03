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
            // 空选择器 + 取值链：规则直接以 `##正则##$1###` 开头，从**整页原文**里抠字段。
            // 线上 55 处这么写（⚡📂未来天王 六个字段、🔞PO18文学 的 wordCount …），
            // 所以这一条钉住两件事：空选择器的输入是整页；`###` 是「取第一个匹配」
            // 而不是「整段里替换第一处」（后者会让 intro 等于整页）
            intro: '##class="book-intro">([^<]+)<##$1###',
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

/**
 * 同一个测试站点，改用 **JSONPath** 规则（搜索走 JSON 接口）
 *
 * 存在的意义是**对照验证**：接口型站点在真实书源里占比极高（音频、漫画的接口站几乎全是），
 * 而它们的搜索规则长这样：`bookList: "$.data.list"` —— 命中的是整个数组。
 *
 * 这一条同时钉住 JSON 列表规则的两个坑：数组要摊平成条目、条目要用自己的 JSON 作 source。
 * 两处任一没做对，结果都是「搜不到书」而且**不报任何错**，是最难查的一类问题。
 *
 * 它与其他三个源打的是同一份数据，因此照常参与第 3、4 节的逐字对照。
 */
export function fixtureJsonSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-json',
        builtin: true,
        sortOrder: 3,
        bookSourceName: '内置测试站点（JSON 接口规则）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '项目自带的测试站点，搜索走 JSON 接口、用 JSONPath 规则驱动',
        bookSourceType: 0,
        enabled: true,

        searchUrl: `${origin}/fixture/api/search?q={{key}}&p={{page}}`,
        ruleSearch: {
            bookList: '$.data.list',
            // 子规则刻意用**裸字段名**：真实接口型书源就是这么写的
            // （喜马拉雅的章节规则是 `title`、`playPathAacv224||playUrl64`）。
            // 裸名面对 JSON 内容时等价于 `$.名`；不当 JSON 处理的话会去找同名 HTML 标签，
            // 于是一个字段都取不到，整条源「搜不到书」。
            name: 'name',
            author: 'author',
            intro: 'intro',
            // 同一个源里两种写法都要能用
            kind: '$.kind',
            bookUrl: 'url',
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
 * 正文规则写成**顶格 `@js:`**、并且引用 `result` 的源
 *
 * `result` 在这种写法里应当绑成**当前页面的原文**（Legado 的语义）。
 * 绑错的话（比如绑成空串）有两个后果，都很难查：
 *   - 规则「执行成功但什么都取不到」→ 表现为空正文
 *   - 规则直接崩 → 表现为「规则脚本执行出错」
 *
 * 真实书源里这个形态非常普遍：图片源常用 `@js:var start = result.indexOf('id="cp_img"')`
 * 从整页里切出图片区，音频源的目录规则常用 `@js:JSON.parse(result)…` 算翻页。
 *
 * 它在这里不用任何选择器，靠正则从整页里抠出正文，因此结果必须与其他源逐字一致。
 */
export function fixtureJsResultSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-js-result',
        builtin: true,
        sortOrder: 4,
        bookSourceName: '内置测试站点（@js:result 规则）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '项目自带的测试站点，正文用顶格 @js: 引用 result 驱动',
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
            content:
                `@js:(function(){` +
                `var html = String(result);` +
                `var m = html.match(/<div id="content">([\\s\\S]*?)<\\/div>/);` +
                `if (!m) { throw new Error('整页里没有找到正文容器') }` +
                `var text = m[1].replace(/<\\/?p>/g, '\\n').replace(/<[^>]+>/g, '');` +
                `return text.split('\\n').map(function(s){return s.trim()})` +
                `.filter(function(s){return s !== ''}).join('\\n')` +
                `})()`,
        },
    }
}

/**
 * 字段规则里带 `{{...}}` 模板的源
 *
 * 线上 816 条书源里有 939 处字段模板，是最容易「静默取空」的一类写法：
 * 展开之后如果还当选择器去筛，只会得到空串，而症状就是「这个字段读不出来」。
 *
 * 这一条把两种形态凑在一起，并且**结果与其他源逐字一致**，
 * 因此照常参与第 3、4 节的对照：
 *   - `{{$.name}}`             纯模板 → 展开即结果
 *   - `/fixture/book/{{$.id}}`  模板 + 字面文本（asmr 的 `/api/tracks/{{$.id}}` 就是这个形状）
 *
 * JS 表达式模板、冗余 `@` 标记、模板进 `##` 正则链这几种，在第 14 节单独验。
 */
export function fixtureTemplateSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-template',
        builtin: true,
        sortOrder: 5,
        bookSourceName: '内置测试站点（字段模板规则）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '项目自带的测试站点，字段规则用 {{}} 模板驱动',
        bookSourceType: 0,
        enabled: true,

        searchUrl: `${origin}/fixture/api/search?q={{key}}&p={{page}}`,
        ruleSearch: {
            bookList: '$.data.list',
            name: '{{$.name}}',
            author: '{{$.author}}',
            kind: '{{$.kind}}',
            intro: '{{$.intro}}',
            bookUrl: `/fixture/book/{{$.id}}`,
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
 * `选择器@js:` 的源 —— 选择器**命中多个**，而脚本按**字符串**用 `result`
 *
 * 专钉「`result` 绑数组还是字符串」这件事（见 README「`选择器@js:` 里 `result` 绑什么」）：
 * `div#content p@text` 会命中 3 个段落，早先引擎按「命中多个 → 数组」绑定，
 * 于是 `result.split` 按数组调直接抛 `TypeError`（🎨🔞鸟鸟韩漫 的正文就是这么坏的）。
 * 按字符串绑定时，它的正文与其余各方言**逐字相同**。
 *
 * 正因为参与第 3、4 节的对照，它才有断言价值：绑错类型时取到的是报错，
 * 而不是「差不多的一段字」。
 */
export function fixtureSelectorJsSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-selector-js',
        builtin: true,
        sortOrder: 11,
        bookSourceName: '内置测试站点（选择器@js: 规则）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '验证 选择器@js: 里 result 多命中时的绑法',
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
            /**
             * `p@text` 命中 3 个段落，而且**三段齐全**：
             *
             *   1. 选择器命中多个 → `result` 按字符串绑（旧行为绑数组，`split` 直接抛错）；
             *   2. `##第一段。##第1段。##` 这条链在 `@js:` **之前** ——
             *      旧实现先切链、再找 `@js:`，于是脚本一次都不执行、`第1段。` 留在正文里；
             *   3. 脚本再把 `第1段。` 换回 `第一段。`，所以正文与其余方言**逐字一致**。
             *
             * 顺序弄反、绑法弄错、链丢掉，三者任一都会让「逐字一致」这条断言失败。
             */
            content:
                `@css:div#content p@text##第一段。##第1段。##@js:` +
                `result.replace('第1段。', '第一段。')`,
        },
    }
}

/**
 * 图片源（bookSourceType=2）
 *
 * 正文规则取的是 `<img>` 标签，而且**真地址在 data-src 上**，与真实漫画站一致。
 * 这一条同时覆盖三件事：懒加载地址的选取、相对地址的补全、nextContentUrl 翻页。
 */
export function fixtureImageSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-image',
        builtin: true,
        sortOrder: 6,
        bookSourceName: '内置测试站点（图片源）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '验证 bookSourceType=2：正文是一串图片地址',
        bookSourceType: 2,
        enabled: true,

        searchUrl: `${origin}/fixture/search?q={{key}}&p={{page}}`,
        ruleSearch: {
            bookList: '@css:div.result-item',
            name: '@css:h3.title@text',
            author: '@css:span.author@text',
            bookUrl: '@css:h3.title a@href',
        },
        ruleBookInfo: {
            name: '@css:h1.book-name@text',
            tocUrl: '@css:a.toc-link@href',
        },
        ruleToc: {
            chapterList: '@css:ul.chapter-list li',
            chapterName: '@css:a@text',
            // 目录指向通用章节页，这里改写成图片专用的正文页（第 1 页）
            chapterUrl: "@js:result.replace('/fixture/chapter/', '/fixture/image-chapter/') + '/1'",
        },
        ruleContent: {
            // 取容器的**内部** HTML，一次拿到里面所有 <img> ——
            // 禁漫大王那类真实书源就是 `class.container@img@html` 这个写法。
            // 注意不能对 <img> 本身用 @html：img 是空元素，内部 HTML 恒为空串，
            // 规则会「正常执行但什么都没取到」，是图片源很容易踩的一个坑。
            content: '@css:div#cp_img@html',
            nextContentUrl: '@css:div.pager a@href',
        },
    }
}

/**
 * 音频源（bookSourceType=1）：正文规则取 `<audio>` 的 src
 *
 * 对应真实书源里 `ruleContent.content` 写成 `$id.jp_audio_0@src` 的那一类。
 */
export function fixtureAudioSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-audio',
        builtin: true,
        sortOrder: 7,
        bookSourceName: '内置测试站点（音频源）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '验证 bookSourceType=1：正文是一条音频直链',
        bookSourceType: 1,
        enabled: true,

        searchUrl: `${origin}/fixture/search?q={{key}}&p={{page}}`,
        ruleSearch: {
            bookList: '@css:div.result-item',
            name: '@css:h3.title@text',
            author: '@css:span.author@text',
            bookUrl: '@css:h3.title a@href',
        },
        ruleBookInfo: {
            name: '@css:h1.book-name@text',
            tocUrl: '@css:a.toc-link@href',
        },
        ruleToc: {
            chapterList: '@css:ul.chapter-list li',
            chapterName: '@css:a@text',
            chapterUrl: "@js:result.replace('/fixture/chapter/', '/fixture/audio-chapter/')",
        },
        ruleContent: {
            content: '@css:audio#jp_audio_0@src',
        },
    }
}

/**
 * 不写正文规则的音频源（bookSourceType=1）
 *
 * 真实音频源里这一步很常见：喜马拉雅、asmr 这类接口型站点的**章节地址本身就是音频直链**，
 * 书源根本不配 ruleContent。这条用来钉住「content 为空时回落到章节地址」的行为 ——
 * 少了这个回落，这类源会直接报「未配置正文规则」。
 */
export function fixtureAudioNoRuleSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-audio-norule',
        builtin: true,
        sortOrder: 8,
        bookSourceName: '内置测试站点（音频源·无正文规则）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '验证 bookSourceType=1 且 ruleContent 为空：章节地址本身就是音频直链',
        bookSourceType: 1,
        enabled: true,

        searchUrl: `${origin}/fixture/search?q={{key}}&p={{page}}`,
        ruleSearch: {
            bookList: '@css:div.result-item',
            name: '@css:h3.title@text',
            bookUrl: '@css:h3.title a@href',
        },
        ruleBookInfo: {
            name: '@css:h1.book-name@text',
            tocUrl: '@css:a.toc-link@href',
        },
        ruleToc: {
            chapterList: '@css:ul.chapter-list li',
            chapterName: '@css:a@text',
            // 章节地址直接就是音频文件
            chapterUrl: `@js:'${origin}/fixture/media/tone.mp3'`,
        },
        ruleContent: {},
    }
}

/**
 * 文件源（bookSourceType=3）
 *
 * 三个与其它类型不同的地方，也正是这类源「读不出来」的原因，全部照搬真实写法：
 *   - 正文规则为空：下载地址不在 ruleContent 里
 *   - 目录规则为空：它没有目录
 *   - 下载地址在 ruleBookInfo.downloadUrls 上，要回到详情页才取得到
 */
export function fixtureFileSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-file',
        builtin: true,
        sortOrder: 9,
        bookSourceName: '内置测试站点（文件源）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '验证 bookSourceType=3：只提供下载，地址在 ruleBookInfo.downloadUrls',
        bookSourceType: 3,
        enabled: true,

        searchUrl: `${origin}/fixture/search?q={{key}}&p={{page}}`,
        ruleSearch: {
            bookList: '@css:div.result-item',
            name: '@css:h3.title@text',
            author: '@css:span.author@text',
            bookUrl: '@css:h3.title a@href',
        },
        ruleBookInfo: {
            name: '@css:h1.book-name@text',
            author: '@css:span.book-author@text',
            intro: '@css:div.book-intro@text',
            // 没有目录页，目录地址就是详情页自己 —— 与 Legado 把 bookUrl 当作下载入口的做法一致
            tocUrl: '@js:baseUrl',
            downloadUrls: '@css:a.download-link@href',
        },
        ruleToc: {},
        ruleContent: {},
    }
}

/**
 * 发现页（探索）
 *
 * exploreUrl 用 `<js>` 返回**分类数组**：线上更常见的是 `标题::地址` 文本，
 * 但脚本形态也真实存在，而且它顺带把「分类结构解析」这条路径（对象数组、
 * 相对地址、`{{page}}` 模板）全走了一遍。分类地址带 `{{page}}`，
 * 由 buildPlan 在真正请求时展开。
 */
export function fixtureExploreSource(origin: string): RegisteredSource {
    return {
        id: 'builtin:fixture-explore',
        builtin: true,
        sortOrder: 10,
        bookSourceName: '内置测试站点（发现）',
        bookSourceUrl: origin,
        bookSourceGroup: '测试',
        bookSourceComment: '验证 exploreUrl + ruleExplore：发现页分类、书目与分页',
        bookSourceType: 0,
        enabled: true,

        searchUrl: `${origin}/fixture/search?q={{key}}&p={{page}}`,
        ruleSearch: {
            bookList: '@css:div.result-item',
            name: '@css:h3.title@text',
            author: '@css:span.author@text',
            bookUrl: '@css:h3.title a@href',
        },

        exploreUrl: `<js>[{ title: '热门推荐', url: '/fixture/explore/hot?p={{page}}' }, { title: '最新上架', url: '/fixture/explore/new?p={{page}}' }, { title: '单页精选', url: '/fixture/explore/single' }]</js>`,
        ruleExplore: {
            bookList: '@css:div.result-item',
            name: '@css:h3.title@text',
            author: '@css:span.author@text',
            kind: '@css:span.kind@text',
            bookUrl: '@css:h3.title a@href',
            nextPageUrl: '@css:a.next-page@href',
        },

        ruleBookInfo: {
            name: '@css:h1.book-name@text',
            intro: '@css:div.book-intro@text',
            tocUrl: '@css:a.toc-link@href',
        },
        ruleToc: {
            chapterList: '@css:ul.chapter-list li',
            chapterName: '@css:a@text',
            chapterUrl: '@css:a@href',
        },
        ruleContent: { content: '@css:div#content@textNodes' },
    }
}

/** 内置测试源，仅在测试站点挂载时可用 */
export function builtinSources(origin: string): RegisteredSource[] {
    return [
        fixtureSource(origin),
        fixtureXPathSource(origin),
        fixtureJsSource(origin),
        fixtureJsonSource(origin),
        fixtureJsResultSource(origin),
        fixtureTemplateSource(origin),
        fixtureSelectorJsSource(origin),
        fixtureImageSource(origin),
        fixtureAudioSource(origin),
        fixtureAudioNoRuleSource(origin),
        fixtureFileSource(origin),
        fixtureExploreSource(origin),
    ]
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
