/**
 * XPath 适配层测试
 *
 * 直接拿 cheerio（htmlparser2）解析出来的 DOM 跑真实 XPath 表达式，
 * 验证适配器把 W3C DOM 接口补齐到了标准实现能用的程度。
 * 这一层是本项目对 XPath 支持的全部依赖，它错了上层全错，所以覆盖要密。
 */

import { describe, expect, it } from 'vitest'

import { isAttributeView, runXPath } from '../src/engine/xpath'
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
