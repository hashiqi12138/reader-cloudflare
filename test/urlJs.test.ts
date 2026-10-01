import { describe, expect, it } from 'vitest'
import { findUrlJs, hasUrlJs } from '../src/legado/urlJs'

/**
 * URL 字段里的 JS 定位。样例全部取自线上真实书源的 `searchUrl` 原文 ——
 * 这个字段有 85 条带 JS，三种写法各不相同，认错哪一种都会得到
 * 「合法但完全不是那个地址」的 URL（它往往还能返回 200，只是内容全错）。
 */
describe('findUrlJs', () => {
    it('整条是 @js: 时没有前缀', () => {
        expect(findUrlJs('@js:qmSearch(key, page)')).toEqual({
            prefix: '',
            code: 'qmSearch(key, page)',
        })
    })

    it('前缀带空白的 @js: 同样算整条', () => {
        const out = findUrlJs('\n  @js:\nvar b = "https://www.szndz.com"\nb + "/search?q=" + key')
        expect(out?.prefix).toBe('')
        expect(out?.code).toContain('var b = "https://www.szndz.com"')
    })

    it('@js: 大小写不敏感', () => {
        expect(findUrlJs('@JS:key')?.code).toBe('key')
    })

    it('整条是 <js> 块时没有前缀，代码取块内内容', () => {
        const raw = `<js>
var url = "https://www.sososhu.com/?s=" + encodeURIComponent(key) + "&web=38kanshu";
if (page > 1) { url += "&page=" + page; }
url;
</js>`
        const out = findUrlJs(raw)
        expect(out?.prefix).toBe('')
        expect(out?.code).toContain('www.sososhu.com')
        expect(out?.code).not.toContain('</js>')
    })

    it('<js> 没写收尾标签时，代码一直取到末尾', () => {
        const out = findUrlJs('<js>url = source.key')
        expect(out?.prefix).toBe('')
        expect(out?.code).toBe('url = source.key')
    })

    it('「地址 + 请求选项」再跟 @js: 时，前面那段是 result（不是前缀）', () => {
        // 取自「全本同人小说网」的原文形状
        const raw = `https://www.qbtr.org/e/search/index.php,{
  "body": "show=title&keyboard={{key}}&classid=0",
  "method": "POST"
}
@js:
so = String(result).replace("{{key}}", key);
String(java.connect(so).raw().request().url());`
        const out = findUrlJs(raw)
        expect(out?.prefix.startsWith('https://www.qbtr.org/e/search/index.php,{')).toBe(true)
        expect(out?.prefix).toContain('"method": "POST"')
        expect(out?.code.trimStart().startsWith('so = String(result)')).toBe(true)
        // 前缀里那段请求选项不能被当成脚本的一部分
        expect(out?.code).not.toContain('"method": "POST"')
    })

    it('地址后面直接跟 <js> 块时，前面那段是 result', () => {
        const raw =
            'https://wap.maxreader.la/search/result.html?searchkey={{key}}<js>try { url = result } catch (e) {}</js>'
        const out = findUrlJs(raw)
        expect(out?.prefix).toBe('https://wap.maxreader.la/search/result.html?searchkey={{key}}')
        expect(out?.code.trim()).toBe('try { url = result } catch (e) {}')
    })

    it('普通的 URL（含 {{}} 与请求选项）不含 JS', () => {
        expect(
            findUrlJs('https://www.example.com/search?q={{key}}&p={{page}},{"charset":"gbk"}'),
        ).toBeNull()
        expect(findUrlJs('https://www.example.com/search?q={{key}}')).toBeNull()
        expect(findUrlJs('/search.html?word={{key}}')).toBeNull()
    })

    it('空串与纯文本不会被误判', () => {
        expect(findUrlJs('')).toBeNull()
        expect(findUrlJs('   ')).toBeNull()
        expect(findUrlJs('https://www.example.com/')).toBeNull()
    })

    it('hasUrlJs 与 findUrlJs 结论一致', () => {
        expect(hasUrlJs('@js:key')).toBe(true)
        expect(hasUrlJs('<js>key</js>')).toBe(true)
        expect(hasUrlJs('https://a.com?k={{key}}')).toBe(false)
    })

    it('@js: 出现在字符串中间时按「前缀 + 代码」切开', () => {
        const out = findUrlJs(
            '{{cookie.removeCookie(source.getKey())}}/search/?searchkey={{key}}@js:result+\',{"webView":true}\'',
        )
        expect(out?.prefix).toBe(
            '{{cookie.removeCookie(source.getKey())}}/search/?searchkey={{key}}',
        )
        expect(out?.code).toBe('result+\',{"webView":true}\'')
    })
})
