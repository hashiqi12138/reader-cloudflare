/**
 * 「地址 + 请求选项」的拆解（`src/legado/urlOptions.ts`）
 *
 * 这一层的失败方式是**静默**的：拆不开不会报错，选项段会被当成 URL 的一部分，
 * `new URL()` 再把花括号百分号编码进路径，最后请求一个不存在的页面 ——
 * 症状是「搜不到书」，而书源看着完全正常。
 *
 * 两种真实写法都要认：
 *   - `search.php,{"method":"POST"}`       紧贴（8451 处，绝大多数）
 *   - `search.php, { "method": "POST" }`   逗号后带空白（407 处 / 31 个源，
 *     ⚡📂书趣阁、🏷书旗小说、⚡📂点众阅读 ……）—— 这种以前认不出来
 *
 * 反方向也要守：可选段 `<,{{page}}>` 里天然有 `,`，不能被当成选项分界，
 * 否则 URL 会被切成 `<` + `{{page}}>` 并报一个方向完全错误的错。
 */

import { describe, expect, it } from 'vitest'

import { splitUrlAndOptions } from '../src/legado/urlOptions'

describe('splitUrlAndOptions', () => {
    it('紧贴的 ,{ 照常拆开', () => {
        const out = splitUrlAndOptions('https://a.com/s?q=1,{"method":"POST","body":"k={{key}}"}')
        expect(out.url).toBe('https://a.com/s?q=1')
        expect(out.options).toEqual({ method: 'POST', body: 'k={{key}}' })
    })

    it('逗号后带空白（含换行缩进）也要拆开 —— 407 处 / 31 个源这么写', () => {
        const out = splitUrlAndOptions(
            'http://wap.xshuquge.net/search.php, {\n"method": "post",\n"body": "searchkey=斗破苍穹"\n}',
        )
        expect(out.url).toBe('http://wap.xshuquge.net/search.php')
        expect(out.options).toEqual({ method: 'post', body: 'searchkey=斗破苍穹' })
    })

    it('`\\t` 与多个空格同样算空白', () => {
        expect(splitUrlAndOptions('https://a.com/, \t {"charset":"gbk"}').url).toBe(
            'https://a.com/',
        )
        expect(splitUrlAndOptions('https://a.com/, \t {"charset":"gbk"}').options).toEqual({
            charset: 'gbk',
        })
    })

    it('地址里的那些东西不会被误拆：只有 `,{`（允许空白）才是分界', () => {
        // 逗号后面跟的不是花括号
        expect(splitUrlAndOptions('https://a.com/s?q=a,b&p=1').options).toEqual({})
        expect(splitUrlAndOptions('https://a.com/s?q=a,b&p=1').url).toBe(
            'https://a.com/s?q=a,b&p=1',
        )
        // 只有一个逗号、没有选项
        expect(splitUrlAndOptions('https://a.com/search.html,1.html').options).toEqual({})
    })

    it('可选段 `<,{{page}}>` 不是选项分界（那个逗号前面是 `<`）', () => {
        const out = splitUrlAndOptions('https://a.com/list/<,index_{{page}}.html>')
        expect(out.options).toEqual({})
        expect(out.url).toBe('https://a.com/list/<,index_{{page}}.html>')
    })

    it('带可选段又带选项时，只认后面那个逗号', () => {
        const out = splitUrlAndOptions(
            'https://a.com/list/<,index_{{page}}.html>, {"method":"GET"}',
        )
        expect(out.url).toBe('https://a.com/list/<,index_{{page}}.html>')
        expect(out.options).toEqual({ method: 'GET' })
    })

    it('前后空白会被吃掉（书源里常从下一行开始写 URL）', () => {
        const out = splitUrlAndOptions('\n  https://a.com/ , {"charset":"utf-8"}\n')
        expect(out.url).toBe('https://a.com/')
        expect(out.options).toEqual({ charset: 'utf-8' })
    })

    it('选项不是合法 JSON 时**抛错**（降级会把请求打到错地方）', () => {
        expect(() => splitUrlAndOptions('https://a.com/, {method: POST}')).toThrowError(
            /请求选项不是合法 JSON/,
        )
    })
})
