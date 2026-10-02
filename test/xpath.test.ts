/**
 * XPath 适配层测试
 *
 * 直接拿 cheerio（htmlparser2）解析出来的 DOM 跑真实 XPath 表达式，
 * 验证适配器把 W3C DOM 接口补齐到了标准实现能用的程度。
 * 这一层是本项目对 XPath 支持的全部依赖，它错了上层全错，所以覆盖要密。
 */

import { describe, expect, it } from 'vitest'

import {
    isAttributeView,
    normalizeXPathFunctions,
    runXPath,
    splitXPathExtract,
} from '../src/engine/xpath'
import { parseHtml } from '../src/engine/select'

const HTML = `<!doctype html>
<html><head><title>示例</title></head>
<body>
  <div id="content" class="main box">
    <h1>标题一</h1>
    <p class="para">第一段</p>
    <p class="para">第二段</p>
    <p>第三段</p>
    <a href="/book/1" data-id="7">链接甲</a>
    <a href="/book/2">链接乙</a>
  </div>
  <ul class="chapter-list">
    <li><a href="/c/1">第一章</a></li>
    <li><a href="/c/2">第二章</a></li>
    <li><a href="/c/3">第三章</a></li>
  </ul>
  <div class="footer"><span>完</span></div>
</body></html>`

/** 把节点结果转成可断言的值：元素取文本，属性取 value，文本节点取 data */
function valuesOf($: ReturnType<typeof parseHtml>, expression: string): string[] {
    const outcome = runXPath($, expression)
    if (outcome.kind === 'scalar') return [outcome.value]
    return outcome.nodes.map((node) => {
        if (isAttributeView(node)) return node.value
        if (node.type === 'text') return String(node.data ?? '')
        return $(node).text()
    })
}

/** 元素文本：把源码缩进产生的空白折叠掉，只断言内容 */
function textsOf($: ReturnType<typeof parseHtml>, expression: string): string[] {
    return valuesOf($, expression).map((v) => v.replace(/\s+/g, ' ').trim())
}

/** 文本节点：丢掉纯空白节点（`//text()` 一定会带出标签之间的换行与缩进） */
function nonBlankTextsOf($: ReturnType<typeof parseHtml>, expression: string): string[] {
    return valuesOf($, expression)
        .map((v) => v.trim())
        .filter((v) => v !== '')
}

describe('XPath 适配层', () => {
    const $ = parseHtml(HTML)

    it('按标签名选元素', () => {
        const outcome = runXPath($, '//a')
        expect(outcome.kind).toBe('nodes')
        if (outcome.kind === 'nodes') expect(outcome.nodes).toHaveLength(5)
    })

    it('按 id 属性选元素', () => {
        expect(textsOf($, '//div[@id="content"]')).toEqual([
            '标题一 第一段 第二段 第三段 链接甲 链接乙',
        ])
    })

    it('按 class 属性选元素（全等匹配）', () => {
        // class 是多值属性，XPath 的 = 是全等比较，所以只会命中 id=content 那个
        expect(valuesOf($, '//div[@class="main box"]')).toHaveLength(1)
        expect(valuesOf($, '//div[@class="main"]')).toHaveLength(0)
    })

    it('contains() 可以匹配多值 class', () => {
        expect(valuesOf($, '//div[contains(@class,"main")]/h1')).toEqual(['标题一'])
    })

    it('子轴与后代轴', () => {
        expect(valuesOf($, '//div[@id="content"]/p')).toEqual(['第一段', '第二段', '第三段'])
        expect(valuesOf($, '//div[@id="content"]//a/@href')).toEqual(['/book/1', '/book/2'])
    })

    it('取属性', () => {
        expect(valuesOf($, '//a/@href')).toEqual(['/book/1', '/book/2', '/c/1', '/c/2', '/c/3'])
        expect(valuesOf($, '//a[@data-id]/@data-id')).toEqual(['7'])
    })

    it('取文本节点', () => {
        // `//text()` 会带出标签之间的换行与缩进，这是 XPath 的正常行为，
        // 真正的正文提取由引擎侧统一 trim 并丢掉空行
        expect(nonBlankTextsOf($, '//ul[@class="chapter-list"]//text()')).toEqual([
            '第一章',
            '第二章',
            '第三章',
        ])
    })

    it('位置谓词', () => {
        expect(valuesOf($, '//ul[@class="chapter-list"]/li[2]')).toEqual(['第二章'])
        expect(valuesOf($, '//ul[@class="chapter-list"]/li[last()]')).toEqual(['第三章'])
        expect(valuesOf($, '//div[@id="content"]/p[position()>2]')).toEqual(['第三段'])
    })

    it('文本谓词', () => {
        expect(valuesOf($, '//a[text()="链接乙"]/@href')).toEqual(['/book/2'])
        expect(valuesOf($, '//p[contains(text(),"第二")]')).toEqual(['第二段'])
    })

    it('标量表达式', () => {
        const title = runXPath($, 'string(//h1)')
        expect(title).toEqual({ kind: 'scalar', value: '标题一' })

        const count = runXPath($, 'count(//a)')
        expect(count).toEqual({ kind: 'scalar', value: '5' })
    })

    it('没匹配到返回空列表而不是报错', () => {
        const outcome = runXPath($, '//table')
        expect(outcome).toEqual({ kind: 'nodes', nodes: [] })
    })

    it('表达式写坏时抛 XPathError，而不是静默返回空', () => {
        expect(() => runXPath($, '//div[@@@')).toThrow(/XPath/)
    })

    it('并集去重：同一个节点在结果里只出现一次', () => {
        // `//p | //p` 两个路径选的是同一批节点，去重后应当仍是 3 个而不是 6 个。
        // 去重依赖节点对象标识，所以这条同时验证了视图缓存的稳定性
        // （每次访问都新建包装对象的话，这里会得到 6）
        const union = runXPath($, '//p | //p')
        expect(union.kind).toBe('nodes')
        if (union.kind === 'nodes') expect(union.nodes).toHaveLength(3)

        const single = runXPath($, '//p')
        if (single.kind === 'nodes') expect(single.nodes).toHaveLength(3)
    })

    it('文档序与相邻轴', () => {
        expect(valuesOf($, '//p[1]/following-sibling::p')).toEqual(['第二段', '第三段'])
        expect(valuesOf($, '//p[3]/preceding-sibling::p')).toEqual(['第一段', '第二段'])
        expect(valuesOf($, '//h1/parent::div/@id')).toEqual(['content'])
    })
})

/**
 * XPath 末尾的取值后缀
 *
 * 判据只有一条：**前面不是 `/` 的 `@` 才是取值后缀**。
 * 线上 594 条源里 XPath 段 250 处、末尾带 `@xxx` 的 101 处，其中 70 处是
 * `/@href` / `/@content` / `/@src` 这类**属性节点**（表达式的一部分），
 * 真正的取值后缀只有 3 处（`@html` 2 处、`@text` 1 处）。
 * 所以这里两边都要钉住：后缀要拆得出来，属性节点要原样留着。
 */
describe('splitXPathExtract', () => {
    it('拆出末尾的取值后缀（线上那 3 处的形状）', () => {
        expect(
            splitXPathExtract('//a[text()="下一页"]/../../../preceding-sibling::div[3]@html'),
        ).toEqual({
            expression: '//a[text()="下一页"]/../../../preceding-sibling::div[3]',
            extract: 'html',
        })
        expect(
            splitXPathExtract("//h3[contains(text(),'简介')]/following-sibling::div[1]/pre@text"),
        ).toEqual({
            expression: "//h3[contains(text(),'简介')]/following-sibling::div[1]/pre",
            extract: 'text',
        })
    })

    it('`/@属性` 是 XPath 自己的属性节点，不能当后缀（线上 70 处都是这一形态）', () => {
        for (const expression of [
            "//div[@class='title_box']/a[@class='title']/@href",
            "//meta[@property='og:novel:author']/@content",
            "//div[@class='synopsisArea_detail']/img/@src",
            '//img/@data-src',
            '//select/option[not(@selected)]/@value',
            '//@href',
        ]) {
            expect(splitXPathExtract(expression)).toEqual({ expression, extract: null })
        }
    })

    it('谓词里的 `@` 不算 —— 没有后缀时不能拿它当后缀，那会把表达式毁掉', () => {
        // `//div[@class='a']` 按「最后一个 @」切会变成 `//div[`：表达式直接坏掉
        expect(splitXPathExtract("//div[@class='a']")).toEqual({
            expression: "//div[@class='a']",
            extract: null,
        })
        expect(splitXPathExtract('//div[@class]')).toEqual({
            expression: '//div[@class]',
            extract: null,
        })
        // 引号里出现的 `@` 同理
        expect(splitXPathExtract('//a[@title="a@b"]').extract).toBeNull()
    })

    it('既有谓词又有后缀：只切最右边那个真后缀', () => {
        expect(splitXPathExtract("//div[@class='a']@html")).toEqual({
            expression: "//div[@class='a']",
            extract: 'html',
        })
        expect(splitXPathExtract("//div[@class='a'][2]/span@outerHtml")).toEqual({
            expression: "//div[@class='a'][2]/span",
            extract: 'outerHtml',
        })
    })

    it('后缀可以是带连字符的属性名', () => {
        expect(splitXPathExtract('//p@data-src')).toEqual({
            expression: '//p',
            extract: 'data-src',
        })
    })

    it('没有 @ 的表达式原样返回', () => {
        for (const expression of [
            '//h3/text()',
            'string(//title)',
            'count(//p)',
            '/html/body/div',
        ]) {
            expect(splitXPathExtract(expression)).toEqual({ expression, extract: null })
        }
    })

    it('`@` 后面不是裸标识符时原样交回 —— 交给 XPath 报错，不静默换语义', () => {
        expect(splitXPathExtract('//a@[1]').extract).toBeNull()
        expect(splitXPathExtract('//a@').extract).toBeNull()
        // `@js:` 由更早的分支切走，这里不能把它吞成取值后缀 `js:result`
        expect(splitXPathExtract('//a@js:result').extract).toBeNull()
    })
})

/**
 * 函数名与 `(` 之间的空白
 *
 * `xpath` 包不接受 `contains (`（虽然 XPath 1.0 的语法允许），而线上真有源这么写
 * （⚡📂书荒小说 的 `ruleToc.chapterList`），代价是整条目录取不到。
 * 这里做的是**语义等价的规范化**，所以「动了不该动的」比「少动一处」危险得多 ——
 * 下面一半用例是在钉「不能动」的那几类。
 */
describe('normalizeXPathFunctions', () => {
    it('去掉函数名与 `(` 之间的空白', () => {
        expect(normalizeXPathFunctions("//h3[contains (.,'章节列表')]")).toBe(
            "//h3[contains(.,'章节列表')]",
        )
        expect(normalizeXPathFunctions('//div[normalize-space (text ())]')).toBe(
            '//div[normalize-space(text())]',
        )
        expect(normalizeXPathFunctions('//div[position () = 1]')).toBe('//div[position() = 1]')
        // 制表符/换行也算空白
        expect(normalizeXPathFunctions("//div[contains\n  (., 'x')]")).toBe(
            "//div[contains(., 'x')]",
        )
    })

    it('线上那条真实的目录规则：规范化之后就能解析了', () => {
        const expression = "//h3[(contains (.,'章节列表'))]/following-sibling::div[1]/ul/li/a"
        const $ = parseHtml('<html><body><h3>章节列表</h3></body></html>')
        expect(() => runXPath($, expression)).toThrow(/XPath 执行失败/)
        expect(() => runXPath($, normalizeXPathFunctions(expression))).not.toThrow()
    })

    it('**运算符不能碰**：`and (` / `or (` 去掉空白会变成函数调用，语义就变了', () => {
        const cases = [
            '//a[position() = 1 and (2 > 1)]',
            "//a[contains(@class,'x') or (1 = 1)]",
            "//a[. = 'x' and (2)]",
        ]
        for (const expression of cases) {
            expect(normalizeXPathFunctions(expression)).toBe(expression)
        }
    })

    it('引号里的内容一律不动', () => {
        const cases = [
            "//div[contains(text(),'a (b')]",
            "//div[contains(@title,'contains (')]",
            '//div[@class="normalize-space ("]',
        ]
        for (const expression of cases) {
            expect(normalizeXPathFunctions(expression)).toBe(expression)
        }
    })

    it('本来就没空白的表达式原样返回', () => {
        for (const expression of [
            "//h3[contains(.,'x')]",
            '//div[@class="a"]',
            '//ul/li/text()',
            'string(//title)',
        ]) {
            expect(normalizeXPathFunctions(expression)).toBe(expression)
        }
    })

    it('不是函数调用的括号不动（`Name (` 之外的形式）', () => {
        // `(//a)[1]` 这种分组表达式不涉及函数名
        expect(normalizeXPathFunctions('(//a)[1]')).toBe('(//a)[1]')
        // 集合之外的名字（这里是自定义的命名空间前缀）不动
        expect(normalizeXPathFunctions('my:func (1)')).toBe('my:func (1)')
    })
})
