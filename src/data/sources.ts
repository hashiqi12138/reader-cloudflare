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
import {
    countEnabledSources,
    getUserSource,
    listUserSources,
    listUserSourcesByIds,
    listUserSourcePage,
    saveSourceVariable,
} from './db'
import type { PlatformDb } from '../platform/types'
import { BUILTIN_ID_PREFIX, type RegisteredSource } from './types'

export type { RegisteredSource }

/**
 * 把 `source.setVariable(整串)` 的结果落到书源上
 *
 * 两件事，缺一不可：
 *  1. **先改内存里这一份**（`source.variable`）。同一次请求里同一个书源会被求值很多次
 *     （搜索地址的脚本 → 列表规则 → 每个字段规则 → 目录 → 正文），
 *     `ruleBookInfo.downloadUrls` 这种「搜索时算出 url、详情页再取回来」的写法全靠它。
 *  2. **再写库**。书源变量是**跨请求**的配置（备用域名、线路序号、设备号），
 *     只活在一次请求里的话，用户看到的是「设置成功了，下次进来又没了」。
 *
 * 内置测试源只做第 1 步：它们是代码的一部分（跟着版本走），库里没有对应行。
 */
export async function persistSourceVariable(
    db: PlatformDb,
    source: RegisteredSource,
    value: string,
): Promise<void> {
    source.variable = value
    if (source.builtin || source.id.startsWith(BUILTIN_ID_PREFIX)) return
    await saveSourceVariable(db, source.id, value)
}

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
 * 同一个测试站点，改用 **POST 表单** 提交搜索关键字
 *
 * 规则与 CSS 版**完全相同**，只换搜索地址 —— 这样「多方言对照」那一组断言仍然要求
 * 它与别的源给出逐字相同的结果，而它走的却是完全不同的请求形态（POST + 表单体）。
 *
 * 它守的是「带请求体必须自己声明 Content-Type」：测试站点那边**故意不宽容**，
 * 不是 `application/x-www-form-urlencoded` 就当作没收到参数（返回空结果页），
 * 与 PHP 的 `$_POST` 一致。少了这一行，这条源就会搜到 0 本 —— 而这个失败是静默的，
 * 正是它在线上藏了那么久的原因（见 src/lib/http.ts 的 requestHeaders）。
 */
export function fixturePostFormSource(origin: string): RegisteredSource {
    return {
        ...fixtureSource(origin),
        id: 'builtin:fixture-post-form',
        sortOrder: 12,
        bookSourceName: '内置测试站点（POST 表单搜索）',
        bookSourceComment:
            '同一个测试站点，搜索走 POST 表单；用来守住「带请求体必须声明 Content-Type」',
        searchUrl: `${origin}/fixture/search-post,{"method":"POST","body":"q={{key}}"}`,
    }
}

/**
 * 同一个测试站点，正文改用 **`@html` 取值**（原样拿到 HTML）
 *
 * 存在的意义：正文取值方式里 `@html` 占**一半以上**（线上 816 条启用源里 440 条，54%），
 * 而那一路取回来的是 HTML —— 阅读界面把正文当纯文本渲染，于是用户看到的是字面的
 * `<p>` / `<br>`，段落还全糊在一起。这个源打的是 `<br>` 版的章节页
 * （见 `fixtureBrChapterPage`），与 CSS 版**逐字同源**，所以冒烟能断言
 * 「`@html` 摊平出来的正文 == `@textNodes` 取到的那份」。
 *
 * 目录那一趟照旧，只把章节地址改到 `<br>` 版页面上。正文规则的尾巴
 * `##↑返回顶部↑` 也是照线上 `📂梦芳小说`（`id.rtext@html##↑返回顶部↑`）抄的：
 * 它把那段文字删掉，却留下一具 `<a href="javascript:top()">` 的空壳 ——
 * 摊平那一步要把它一起带走。
 */
export function fixtureBrHtmlSource(origin: string): RegisteredSource {
    const base = fixtureSource(origin)
    return {
        ...base,
        id: 'builtin:fixture-br-html',
        sortOrder: 13,
        bookSourceName: '内置测试站点（@html 正文 / <br> 分段）',
        bookSourceComment:
            '正文用 @html 取值（原样拿到 HTML）：守住「正文里的 <br> 与块级标签要摊平成换行、标签不能露出来」',
        ruleToc: {
            ...base.ruleToc,
            chapterUrl: '@css:a@href##/chapter/##/br-chapter/##',
        },
        ruleContent: {
            content: '@css:div#nr1@html##↑返回顶部↑',
        },
    }
}

/**
 * 同一个测试站点，目录改用 **jsoup 链式调用**（`org.jsoup.Jsoup.parse`）
 *
 * 线上 86 条源（10.5%）用它，这里的形状抄自两条真源：
 *
 *   - 📂少年小说网：`Jsoup.parse(result).select("style").first().data()` ——
 *     把 `<style>` 里的隐藏规则读出来当选择器（站点用这招躲爬虫）。
 *     以前**桥里根本没有 `data` 这个 op**，调用在沙箱那一侧就炸成
 *     `TypeError: not a function`，报错行号还指向规则里那一行 ——
 *     既不像选择器错，也不像「明确不支持」，无从下手。
 *   - 🎨漫画搬运：`Jsoup.parse(k).select("a")[0].attr("href")` ——
 *     `select()` 的结果要能**下标**。以前 `Jsoup.parse()` 给的是裸 `JsoupElements`
 *     （既不能下标也没有 `length`），`[0]` 恒为 undefined，接着 `.attr(...)`
 *     就报在 undefined 上。
 *
 * 两处都会 `select(...).remove()`。第七十三轮之前它是空操作，于是 `📂少年小说网`
 * 的目录里混着一堆站点藏起来的最新章 —— **不报错**，只是顺序看着是倒的。
 *
 * 打的是 `fixtureJsoupTocPage`：列表容器**只在 `<style>` 里出现**
 * （`.tocBox{display:none}`），所以 `data()` 一读不到，选择器就是空的、目录就是 0 条 ——
 * 「数得出章节」本身就是这条链通不通的判据。
 */
export function fixtureJsoupChainSource(origin: string): RegisteredSource {
    const base = fixtureSource(origin)
    return {
        ...base,
        id: 'builtin:fixture-jsoup-chain',
        sortOrder: 14,
        bookSourceName: '内置测试站点（jsoup 链式调用）',
        bookSourceComment:
            '目录规则用 org.jsoup.Jsoup.parse 链式调用：守住 data() / select(...)[0] / remove()',
        ruleBookInfo: {
            ...base.ruleBookInfo,
            tocUrl: '@css:a.toc-link@href##/toc/##/jsoup-toc/##',
        },
        ruleToc: {
            ...base.ruleToc,
            chapterList: `<js>
a = org.jsoup.Jsoup.parse(result)
sel = String(a.select("style").first().data()).replace(/{display:none}/g, ",").slice(0, -1)
a.select(sel).remove()
box = a.select("div.tocBox").html()
list = []
items = org.jsoup.Jsoup.parse(box).select("ul.chapter-list li a")
for (i = 0; i < items.size(); i++) {
  href = org.jsoup.Jsoup.parse(items.get(i).outerHtml()).select("a")[0].attr("href")
  list.push({ url: href, name: items.get(i).text() })
}
list
</js>`,
            chapterName: 'name',
            chapterUrl: 'url',
        },
    }
}

/**
 * 同一个测试站点，考的是**跨请求的会话变量**：`ruleBookInfo` 里 `java.put`、`ruleToc` 里 `java.get`
 *
 * 抄的是 📂少年小说网（规则原文见 `fixtureCrossVarBookPage` 的说明）。这类写法在
 * 816 条源里有 51 处跨组 put→get —— 写端与读端大多是 JS 的 `java.put` / `java.get`，
 * 而引擎原先只认规则文本里的 `@put:` / `@get:`，于是这些全部断掉。
 *
 * 断掉的表现**特别安静**：目录照样出得来，只是开头那一段（详情页上「全部章节目录」
 * 里预先给出的那几章）整块没了，而且**章节顺序看着是倒的** —— 因为该被 `remove()`
 * 删掉的「最新章」还留在列表里。
 *
 * 所以这个源同时钉住两件事，缺一个断言就会红：
 *   1. `java.put` 的值要能穿过「详情 → 目录」两次请求（借 `book_variables`）
 *   2. `select(...).remove()` 要**真删**（否则那条藏起来的条目会多出一章）
 */
export function fixtureCrossVarSource(origin: string): RegisteredSource {
    const base = fixtureSource(origin)
    return {
        ...base,
        id: 'builtin:fixture-cross-var',
        sortOrder: 15,
        bookSourceName: '内置测试站点（跨请求变量）',
        bookSourceComment:
            '规则在详情页 java.put、到目录页 java.get：守住「跨请求的会话变量」与 remove() 真删',
        ruleSearch: {
            // 搜索页给的书籍地址指向**普通的**详情页，这里把它改到这一版的详情页上 ——
            // 真实书源里 `ruleBookInfo.tocUrl` 要读的那个「全部目录」链接就在这一页
            ...base.ruleSearch,
            bookUrl: '@css:h3.title a@href##/fixture/book/##/fixture/cross-book/##',
        },
        ruleBookInfo: {
            ...base.ruleBookInfo,
            name: 'h1@text',
            tocUrl: `text.全部目录@href
@js:
java.put("html", java.getString("h2:contains(全部章节目录)+.book_list@html"))

result`,
        },
        ruleToc: {
            // 与 📂少年小说网 的 chapterList 逐字同源，只把选择器换成这个测试站点的
            chapterList: `<js>
a = org.jsoup.Jsoup.parse(result)
b = String(a.select("style").first().data()).replace(/{display:none}/g, ",").slice(0, -1)

a.select(b).remove()

w = result.includes("第1页") || !baseUrl.includes("/1/")

if (w) a.html(); else java.get("html")+a.html();
</js>
ul.row li a`,
            chapterName: 'text',
            chapterUrl: 'href',
        },
    }
}

/**
 * 同一个测试站点，目录规则**按标记分卷、并返回对象数组**（第七十四轮）
 *
 * 抄的是 🎨漫画搬运 的 `chapterList` 形状，只把选择器与结构换成本地这一份：
 * 一句选择器取到几「卷」，脚本用 `String(块).includes('<h3')` / `includes('<ul')`
 * **按标记**分出卷标题与章节块，再 `list.push({href, text, volume})` 返回**对象数组**，
 * 字段规则用 `text` / `href` / `volume` 三个键读。
 *
 * 这条链上两处都会静默变成 0 章，所以两边都钉住：
 *   - 选择器那一段得给 **HTML**（给文本 → 两个 filter 恒为空 → 空数组，**不报错**）
 *   - 返回的对象数组要能被 `text` / `href` / `volume` **当键读出来**
 *
 * 线上量过：这一形状（`push({…href/text…})`）在 816 条源里 33 处 / 29 个源。
 * 打的是 `fixtureMapTocPage`（两卷、共三章）。
 */
export function fixtureMapTocSource(origin: string): RegisteredSource {
    const base = fixtureSource(origin)
    return {
        ...base,
        id: 'builtin:fixture-map-toc',
        sortOrder: 16,
        bookSourceName: '内置测试站点（脚本返回对象数组）',
        bookSourceComment:
            '目录脚本按标记分卷并返回对象数组：守住「选择器给 HTML」与「条目按键名读」',
        ruleBookInfo: {
            ...base.ruleBookInfo,
            tocUrl: '@css:a.toc-link@href##/toc/##/map-toc/##',
        },
        ruleToc: {
            chapterList: `.map-block
@js:
voList = Array.from(result).filter(n => String(n).includes('<h3'))
ulList = Array.from(result).filter(n => String(n).includes('<ul'))
list = []
ulList.map((n, index) => {
  // 卷标题在这一块里的 <h3> 上。🎨漫画搬运 原文写的是 java.getString("text", …)，
  // 那是把**整块**的文本当标题（连章节名一起），取出来的是一坨 —— 那是它自己的写法问题，
  // 这里不去复刻那坨垃圾，只保持「块 → 标题」这条链的形状
  list.push({ href: "", text: java.getString("h3@text", voList[index]), volume: true })
  dList = []
  Array.from(org.jsoup.Jsoup.parse(n).select(".muludiv")).map(k => {
    dList.push({
      href: org.jsoup.Jsoup.parse(k).select("a")[0].attr("href"),
      text: org.jsoup.Jsoup.parse(k).select("a")[0].text(),
      volume: false,
    })
  })
  list = list.concat(dList)
})
list`,
            chapterName: 'text',
            chapterUrl: 'href',
            isVolume: 'volume',
        },
    }
}

/**
 * 同一个测试站点，目录规则是一段**死循环脚本**（第七十四轮）
 *
 * 存在的唯一理由：守住「VM 里转太久会被中断」这条底线。第七十四轮把
 * `deadline`（只卡 VM 内代码的那个时限）改成**减掉宿主函数耗时** —— 于是这条
 * 底线必须有一条显式的断言盯着，否则「改成不卡了」也不会有人发现。
 *
 * 打的是普通目录页（脚本不看内容），冒烟断言那次请求报「规则脚本超时」。
 */
export function fixtureSpinSource(origin: string): RegisteredSource {
    const base = fixtureSource(origin)
    return {
        ...base,
        id: 'builtin:fixture-spin',
        sortOrder: 17,
        bookSourceName: '内置测试站点（脚本死循环）',
        bookSourceComment: '目录规则是一段死循环：守住「脚本在 VM 里转太久会被中断」',
        ruleToc: {
            ...base.ruleToc,
            chapterList: '<js>var i = 0; while (true) { i = i + 1 }</js>',
        },
    }
}

/**
 * 同一个测试站点，目录规则**按属性序号取值**（第七十六轮）
 *
 * 抄的是 📂贝壳读书 的形状（线上唯一一处用 `attributes()` 的源）。它的脚本里有个小函数：
 *
 *     let b = Array.from(a.selectFirst(ys).attributes());
 *     return b[num - 1]?.toString().match(/"(.+)"/)?.[1];
 *
 * 不按属性名取值，而是**第 n 个属性** —— 于是两件事必须都对，缺一个就静默出错：
 *   - `attributes()` 得存在（桥里没有这个 op 时，报的是 `attributes is not a function`，
 *     报错指向规则里那一行，看着像书源写错了）
 *   - `Attribute.toString()` 得是 jsoup 那形状 `key="value"`，且顺序就是书写顺序
 *     （顺序错了取出来的是另一个属性 —— 不报错，只是标题变成一串 base64）
 *
 * 打的是 `fixtureAttrTocPage`（一半条目书名在第 3 位、一半在第 4 位，与真源的
 * `isBase64` 分支对应）。
 */
export function fixtureAttrTocSource(origin: string): RegisteredSource {
    const base = fixtureSource(origin)
    return {
        ...base,
        id: 'builtin:fixture-attr-toc',
        sortOrder: 18,
        bookSourceName: '内置测试站点（按属性序号取值）',
        bookSourceComment: '目录脚本用 attributes() 按序号取属性并靠 Attribute.toString() 抠值',
        ruleBookInfo: {
            ...base.ruleBookInfo,
            tocUrl: '@css:a.toc-link@href##/toc/##/attr-toc/##',
        },
        ruleToc: {
            chapterList: `@js:
function isBase64(t) {
  return typeof t === "string" && t.length !== 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(t)
}
function pick(html, ys, num) {
  var a = org.jsoup.Jsoup.parse(html);
  var b = Array.from(a.selectFirst(ys).attributes());
  return b[num - 1]?.toString().match(/"(.+)"/)?.[1];
}
var out = [];
Array.from(java.getElements("class.ch-item")).map(function (c) {
  var three = pick(c, "li>a", 3);
  var four = pick(c, "li>a", 4);
  out.push({
    text: isBase64(three) === true ? four : three,
    href: java.base64Decode(isBase64(three) === true ? three : four),
  });
});
out`,
            chapterName: 'text',
            chapterUrl: 'href',
        },
    }
}

/**
 * 同一个测试站点，**搜索里给每一条记一个变量、详情里读回来**（第七十六轮）
 *
 * 抄的是这一族写法（816 条源里 5 条真的能靠它修好）：
 *
 *   📂阿巴小说    ruleSearch.bookUrl      `$.bid <js> java.put('bid', result); '…/bid/'+result </js>`
 *                 ruleBookInfo.init       `java.get('bid')`
 *   ⚡📂飛天小說   同一位置 put `bid`，详情与正文都读它
 *   🔒潇社音乐    ruleSearch.lastChapter  `java.put('json', JSON.stringify(result))`，目录读它
 *   🏷七猫小说    同一位置 put `headers`，正文读它
 *   📂乐乎文章    `bookUrl` 与 `lastChapter` 里各 put 一个
 *
 * 它们的共同点正是难点：**搜索这一趟没有「这本书」**，而 `java.put` 是在**每一条**
 * 的字段规则里写的 —— 所以只能「先收、这一条算完再按它自己的 bookUrl 落」。
 *
 * 靶子让每一条写一个**互不相同**的值（书地址最后那一段），于是能钉住最关键的那件事：
 * 落的是**各条各自的值**，不是「最后一条覆盖前面」。只落最后一次的话，
 * 两本书的 `intro` 都会是 `bid=2`；完全不落则是 `bid=`。
 */
export function fixtureSearchVarSource(origin: string): RegisteredSource {
    const base = fixtureSource(origin)
    return {
        ...base,
        id: 'builtin:fixture-search-var',
        sortOrder: 19,
        bookSourceName: '内置测试站点（搜索里 put、详情里 get）',
        bookSourceComment: '搜索逐条 java.put，详情 java.get —— 按每条各自的 bookUrl 落库',
        ruleSearch: {
            ...base.ruleSearch,
            // 每一条把「自己是第几本」记进 bid，再把地址交回去
            bookUrl: `h3.title a@href <js> java.put("bid", String(result).split("/").pop()); String(result) </js>`,
        },
        ruleBookInfo: {
            ...base.ruleBookInfo,
            // 详情那一趟读回来（写在**别的组**里，所以 bid 会进「跨请求键」）
            intro: '@js: "bid=" + java.get("bid")',
        },
    }
}

/**
 * 发现页里给每条记一个变量、详情里读回来（第七十八轮，TODO 第 8 条余量）
 *
 * 与 `fixtureSearchVarSource` 是**同一套写法换一个规则组**：那边 put 在
 * `ruleSearch.bookUrl`，这边 put 在 `ruleExplore.bookUrl`。
 *
 * 为什么值得单独做一条靶子：语料里 `ruleExplore` 写 `java.put` 的有 4 条源
 * （📂阿巴小说 / 🏷七猫小说 / 📂乐乎文章 / 📂小米书城），而发现这一趟原先**没接**
 * 落库通道 —— 于是同一套写法「搜索能用、发现不能用」，且两边都不报错。
 *
 * 读端放在 `ruleBookInfo.intro`（**别的组**），于是 `bid` 会被算进「跨请求键」，
 * 也只有在真的落库之后详情那趟才读得到。
 */
export function fixtureExploreVarSource(origin: string): RegisteredSource {
    const base = fixtureExploreSource(origin)
    return {
        ...base,
        id: 'builtin:fixture-explore-var',
        sortOrder: 21,
        bookSourceName: '内置测试站点（发现里 put、详情里 get）',
        bookSourceComment: '发现页逐条 java.put，详情 java.get —— 与搜索那条路同一机制',
        // 只留一个分类（用的是 `hot`：一页两本），避免与 fixture-explore 的分页断言纠缠
        exploreUrl: `${origin}/fixture/explore/hot?p={{page}}`,
        ruleExplore: {
            ...base.ruleExplore,
            // 每一条把「自己是第几本」记进 bid，再把地址交回去
            bookUrl: `h3.title a@href <js> java.put("bid", String(result).split("/").pop()); String(result) </js>`,
        },
        ruleBookInfo: {
            ...base.ruleBookInfo,
            intro: '@js: "bid=" + java.get("bid")',
        },
    }
}

/**
 * 图片源：正文真地址只能靠脚本写到 `src` 上（第七十八轮，TODO 第 12 条）
 *
 * 抄的是 🎨笔趣漫画 的 `ruleContent.content`：
 *
 *     imgs = java.getElements(".rd-article-wr img");
 *     imgs.forEach(e => { e.attr("src", e.attr("data-original")) });
 *     imgs
 *
 * 这条规则同时踩中三处：`getElements` 的返回值要能 `forEach`、`attr(k, v)` 要真改、
 * 改完返回的 HTML 要是改之后的那一份。属性名换成 `data-real-src` 的理由见
 * `fixtureImgWriteChapterPage` 的说明（`data-original` 在提取器优先表里，分辨不出改没改）。
 */
export function fixtureImgWriteSource(origin: string): RegisteredSource {
    const base = fixtureSource(origin)
    return {
        ...base,
        id: 'builtin:fixture-img-write',
        sortOrder: 22,
        bookSourceName: '内置测试站点（图片源·脚本改 src）',
        bookSourceComment:
            '正文脚本用 java.getElements(...).forEach(e => e.attr("src", e.attr("data-real-src"))) 把真地址写到 src 上',
        bookSourceType: 2,
        ruleToc: {
            ...base.ruleToc,
            // 目录指向脚本专用的正文页（与图片源那条路同一手法）
            chapterUrl: "@js:result.replace('/fixture/chapter/', '/fixture/img-write-chapter/')",
        },
        ruleContent: {
            // 注意选择器是**带点**的 CSS 写法 `".rd-article-wr img"`：JSOUP 简写的
            // `class.a b` 在这个引擎里是「两个类都要有」（见冒烟第 38 段），
            // 不是后代选择器 —— 写成 `class.rd-article-wr img` 会一枚都不命中。
            content: `@js:
var imgs = java.getElements(".rd-article-wr img");
imgs.forEach(function (e) { e.attr("src", e.attr("data-real-src")) });
imgs`,
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
 * 专钉「`result` 绑数组还是字符串」这件事（见 EXPERIENCE.md「`选择器@js:` 里 `result` 绑什么」）：
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
        fixturePostFormSource(origin),
        fixtureBrHtmlSource(origin),
        fixtureJsoupChainSource(origin),
        fixtureCrossVarSource(origin),
        fixtureMapTocSource(origin),
        fixtureSpinSource(origin),
        fixtureAttrTocSource(origin),
        fixtureSearchVarSource(origin),
        fixtureExploreVarSource(origin),
        fixtureImgWriteSource(origin),
    ]
}

/** 全部书源：内置（可选）在前，用户导入的在后 */
export async function listSources(
    db: PlatformDb,
    origin: string,
    options: RegistryOptions,
): Promise<RegisteredSource[]> {
    const builtin = options.includeFixture ? builtinSources(origin) : []
    return [...builtin, ...(await listUserSources(db))]
}

/** 搜索时真正参与的书源：只要启用的 */
export async function listEnabledSources(
    db: PlatformDb,
    origin: string,
    options: RegistryOptions,
): Promise<RegisteredSource[]> {
    const all = await listSources(db, origin, options)
    return all.filter((source) => source.enabled !== false)
}

/**
 * 搜索用的一页书源
 *
 * 内置书源不落库，所以「前几个」得把它算进去：offset 落在内置段里时先给内置源，
 * 剩下的再从库里按页取（`listUserSourcePage` 只读这一页的规则）。
 * 返回的 total 是**内置 + 用户**的总数，界面靠它算「还有多少个源没搜」。
 */
export async function listEnabledSourcePage(
    db: PlatformDb,
    origin: string,
    options: RegistryOptions,
    page: { offset: number; limit: number },
): Promise<{ sources: RegisteredSource[]; total: number }> {
    const builtin = options.includeFixture
        ? builtinSources(origin).filter((source) => source.enabled !== false)
        : []
    const total = builtin.length + (await countEnabledSources(db))

    const offset = Math.max(0, Math.floor(page.offset) || 0)
    const limit = Math.max(1, Math.floor(page.limit) || 1)
    // 内置源在前（只有本地/测试才有），不够一页的再从库里补
    const out: RegisteredSource[] = builtin.slice(offset, offset + limit)

    const userOffset = Math.max(0, offset - builtin.length)
    const userLimit = limit - out.length
    if (userLimit > 0) out.push(...(await listUserSourcePage(db, userOffset, userLimit)))

    return { sources: out, total }
}

/** 按 id 批量取「启用的」书源（只读点到的这几条） */
export async function listEnabledSourcesByIds(
    db: PlatformDb,
    origin: string,
    ids: string[],
    options: RegistryOptions,
): Promise<RegisteredSource[]> {
    const wanted = new Set(ids)
    const builtin = options.includeFixture
        ? builtinSources(origin).filter(
              (source) => source.enabled !== false && wanted.has(source.id),
          )
        : []
    const users = await listUserSourcesByIds(
        db,
        ids.filter((id) => !id.startsWith(BUILTIN_ID_PREFIX)),
    )
    return [...builtin, ...users.filter((source) => source.enabled !== false)]
}

/** 按 id 取一条书源 */
export async function findSource(
    db: PlatformDb,
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
