import { describe, expect, it } from 'vitest'

import { resultWantsArray, usesJsoupOnResult } from '../src/engine/resultShape'

/**
 * `选择器@js:` 里 `result` 绑数组还是字符串
 *
 * 夹具全部是**真实书源里的原字符串**（书源名与字段写在注释里）——
 * 这条判据唯一的依据就是线上写法，自己编的样例证明不了它。
 *
 * 两侧判错各自的代价不同，测试也按这个分：
 *   - 该字符串却绑了数组 → `result.split is not a function`，**报错**；
 *   - 该数组却绑了字符串 → `result[0]` 变成第一个**字符**，**不报错、值不对**。
 *     后者更难查，所以取值方式那几条（下标 / 数组方法）判得最优先。
 */
describe('resultWantsArray：按字符串写的', () => {
    it('用了 split —— 🎨🔞老司机 的正文（整章图读不出来的那条）', () => {
        const code = ` var lines = result.split("\\n"); var newLines = []; for (var i = 0; i < lines.length; i++) { if (lines[i]) { newLines.push('<img src="' + lines[i] + '">'); } } newLines.join("\\n")`
        expect(resultWantsArray(code)).toBe(false)
    })

    it('split 之后才 map —— 🎨漫蛙 的正文（map 是作用在切出来的数组上，不是 result）', () => {
        const code = `result.split("\\n").map(x=>'<img src="' + x + '">').join("\\n")`
        expect(resultWantsArray(code)).toBe(false)
    })

    it('字符串拼接 —— 🎨再漫画 的 bookUrl', () => {
        const code = `'https://v4api.zaimanhua.com/api/v1/comic2/comic/detail?comic_py='+result+'&channel=pc&app_name=zmh&version=1.0.0&timestamp=0&uid=0'`
        expect(resultWantsArray(code)).toBe(false)
    })

    it('字符串方法**压过**「原样返回」—— 🌍🔞爱丽丝书屋 的 wordCount', () => {
        // 这条代码同时命中 `result.split`（字符串）与结尾的 `; result`（原样返回）。
        // 必须判字符串：`split` 写在数组上会直接抛错，而「原样返回」只是条目数问题
        const code = ` if (/search/.test(baseUrl)) result = result.split(/\\s|\\u3000/)[1].replace(/.*?：/, ""); result;`
        expect(resultWantsArray(code)).toBe(false)
    })

    it('拼接后原样返回 —— 🌍🔞爱丽丝书屋 的 coverUrl', () => {
        const code = `let url = /^https?/.test(result) ? result : GetUL() + result; result = java.connect(url).code() == 200 ? url : 'https://img.321cdn.com/img/01.png'; result;`
        expect(resultWantsArray(code)).toBe(false)
    })

    it('indexOf / slice 这类两边都有的方法**不能**当判据', () => {
        // `String` 与 `Array` 上都有，拿它当判据就会把两侧判反
        expect(resultWantsArray(`result.indexOf('免費')>-1?'':1`)).toBe(false)
        expect(resultWantsArray(` result.slice(0, -4);`)).toBe(false)
        expect(resultWantsArray(`result.length > 0 ? result : ''`)).toBe(false)
    })

    it('String(result) / JSON.parse(result) —— 🏷书旗小说 的 intro、⚡📂云轩阁 的翻页', () => {
        expect(
            resultWantsArray(
                `var s = String(result); s = s.replace(/[\\[\\]]/g, '').replace(/[,，\\n\\r]+/g, ' ').replace(/\\s+/g, ' ').trim(); s`,
            ),
        ).toBe(false)
        expect(
            resultWantsArray(
                ` res = JSON.parse(result) list = []; for (var i = 2; i <= res; i++) { list.push(baseUrl.replace(/$/,"index_" + i + ".html")); } list;`,
            ),
        ).toBe(false)
    })

    it('toString() 之后才用字符串方法 —— 🎨武芊漫画 的 kind', () => {
        const code = ` let class_name="全部&修真&霸总&恋爱&校园&冒险&搞笑&生活&热血&架空&后宫&玄幻&悬疑&恐怖&灵异&动作&科幻&战争&古风&穿越&竞技&励志&同人&真人".split("&"); let class_url="0&2&1&3&4&5&6&7&8&9&10&12&13&14&15&16&17&18&19&20&21&23&24&26".split("&"); let map = {}; for(let i=0; i<class_url.length; i++){ map[class_url[i]] = class_name[i]; } let res = result.toString().replace(/\\[|\\]/g, '').split(/[,\\s]+/); let tags = []; for(let i=0; i<res.length; i++){ let id = res[i].trim(); if(map[id] && map[id] !== "全部"){ tags.push(map[id]); } } Array.from(new Set(tags)).join(" ");`
        expect(resultWantsArray(code)).toBe(false)
    })
})

describe('resultWantsArray：按数组写的', () => {
    it('下标 + 原样返回 —— 📂第一小说 的 nextTocUrl（11 条源共用的那套写法）', () => {
        const code = ` next = []; url = result[0]; length = result.length; p = src.match(/page-link">1\\/(\\d+)/)||[]; page = Number(p[1]); if(length < page){ for(i = 2; i <= page; i++){ link = String(url).replace(/_\\d+/, \`_\${i}\`); next.push(link) } next; }else result`
        expect(resultWantsArray(code)).toBe(true)
    })

    it('下标 —— 🔞环安小说网 的 nextContentUrl', () => {
        const code = ` pageSum=parseInt(result[0]) burl=String(baseUrl) result=Array.from({length:pageSum-1},(_,i)=>{return burl.replace(/.html/,\`_\${i+2}.html\`)}) result`
        expect(resultWantsArray(code)).toBe(true)
    })

    it('下标 —— 📂追书网 的 nextTocUrl', () => {
        const code = ` var resultStr = result && result.length > 0 ? result[0] : ""; var match = resultStr.match(/\\/index_(\\d+)\\.html/); var n = match && match[1] ? parseInt(match[1], 10) : 1; var list = []; for (var i = 1; i <= n; i++) { list.push("index_" + i + ".html"); } list;`
        expect(resultWantsArray(code)).toBe(true)
    })

    it('数组方法 —— 🔞西瓜书屋 的 chapterList', () => {
        const code = `var list=[]; result.forEach(e=>{ url=String(e.attr('href')); if(url.match(/javascript/)){ url=String(e.attr('href')).replace(/.*'(\\d+)','(\\d+)'.*/,'/book/$1/$2.html');} list.push({ text:e.text(), href:url } ) }) list`
        expect(resultWantsArray(code)).toBe(true)
    })

    it('显式转数组 —— 🎨漫画搬运 的 chapterList', () => {
        const code = ` list=[] voList = Array.from(result).filter(n=>String(n).includes('<h3')) ulList = Array.from(result).filter(n=>String(n).includes('<ul')) ulList.map((n,index)=>{ ... })`
        expect(resultWantsArray(code)).toBe(true)
    })

    it('原样返回 —— 🔞夜读集 的 chapterList（绑字符串会把整本目录塌成 1 章）', () => {
        const code = ` book.type = /comic/.test(baseUrl) ? 64 : 8; result`
        expect(resultWantsArray(code)).toBe(true)
    })

    it('下标压过 jsoup 方法 —— 🔞紫云宫 的 chapterList（两种写法混用的那条）', () => {
        const code = ` var list=[],links=result.select("a"),regex=/(\\w+-\\w+)(?==")/g; for (i=0;i<links.length;i++){ link=links[i]; aAttrs=String(link).match(regex); liAttrs=String(result[i]).match(regex); list.push({ num:result[i].attr(liAttrs[1]) }); } list`
        expect(resultWantsArray(code)).toBe(true)
    })
})

describe('resultWantsArray：容易误判的边界', () => {
    it('**字面量里的** `result[0]` 不算代码', () => {
        // 不剥字面量的话，下面第一条会被判成数组 —— 那会真把它跑坏
        expect(resultWantsArray(`var note = 'result[0]'; result.split('|')`)).toBe(false)
        expect(resultWantsArray(`var note = "result.split"; result[0]`)).toBe(true)
    })

    it('空代码 / 不提 result 的代码一律按字符串', () => {
        expect(resultWantsArray('')).toBe(false)
        expect(resultWantsArray(`java.ajax(baseUrl)`)).toBe(false)
    })

    it('只有 `result` 一个词（原样返回）算数组', () => {
        // 📂福书网[分页] 的 `ruleExplore.author` 就是裸 `result`（后面跟 `##` 净化链）
        expect(resultWantsArray('result')).toBe(true)
        expect(resultWantsArray(' return result ')).toBe(true)
    })

    it('结尾只是**碰巧**是 result 这个词，不算原样返回', () => {
        expect(resultWantsArray(`'http://www.iyruan.info'+result`)).toBe(false)
        expect(resultWantsArray(`i>=0?result.substring(i):result`)).toBe(false)
        expect(resultWantsArray(`GetUL() + result`)).toBe(false)
    })

    it('`[result]` 没有判据，按字符串 —— 🎨🔞Cin漫 / Nhentai漫 的 chapterList', () => {
        // 选择器是 `img[1]`（只命中 1 个），绑字符串能原样放进数组里，条目数不受影响
        expect(resultWantsArray('[result]')).toBe(false)
    })
})

/**
 * `usesJsoupOnResult`：交给脚本的**内容**该是 HTML 还是文本
 *
 * 与上面那组是两件事：那一组判「绑数组还是字符串」，这一组判「内容里有没有标记」。
 * 判错的表现是**条目静默变少**（`String(条目).includes('<ul')` 恒为 false 之类），
 * 所以夹具同样取自真实书源，并且把「反向」（脚本自己拼 HTML）也钉住 ——
 * 那种写法要的恰恰是文本，放宽判据会把它误伤。
 */
describe('usesJsoupOnResult：内容给 HTML 还是文本', () => {
    it('在字符串里**找标签** —— 🎨漫画搬运 的 chapterList（找 <h3 分卷、找 <ul 取每卷的章节）', () => {
        const code = ` list=[] voList = Array.from(result).filter(n=>String(n).includes('<h3')) ulList = Array.from(result).filter(n=>String(n).includes('<ul')) ulList.map((n,index)=>{ list.push({href:"", text:java.getString("text", voList[index]), volume:true}) }) list`
        expect(usesJsoupOnResult(code)).toBe(true)
    })

    it('`Array.from(result)` 之后再动条目 —— 判据要透得过它（Legado 那边它们都是 Elements）', () => {
        expect(usesJsoupOnResult(`Array.from(result).filter(e => e.attr('href'))`)).toBe(true)
        expect(usesJsoupOnResult(`Array.from(result).map(e => e.text())`)).toBe(true)
        expect(usesJsoupOnResult(`[...result].forEach(e => e.attr('data-id'))`)).toBe(true)
        // 纯「转成数组再拼字符串」不要标记，别被顺手放宽
        expect(usesJsoupOnResult(`Array.from(result).join('|')`)).toBe(false)
    })

    it('脚本**自己拼 HTML** 时不算 —— 那种写法要的恰恰是文本', () => {
        expect(
            usesJsoupOnResult(`result.split("\\n").map(x => '<img src="' + x + '">').join("\\n")`),
        ).toBe(false)
        expect(
            usesJsoupOnResult(
                `list.map(x => '<li><a href="/c/' + x + '">第' + x + '章</a></li>').join('')`,
            ),
        ).toBe(false)
    })

    it('直接调节点方法、或在迭代回调里调 —— 老判据照旧', () => {
        expect(usesJsoupOnResult(`result.select("a")`)).toBe(true)
        expect(usesJsoupOnResult(`result.toArray()`)).toBe(true)
        expect(usesJsoupOnResult(`result.forEach(e => e.attr('href'))`)).toBe(true)
        expect(usesJsoupOnResult(`String(result).replace(/<b>/g, '')`)).toBe(false)
    })

    it('**正则字面量**形式（`html.match(/<h1>/)`）刻意不算', () => {
        // 语料里这一形式 25 处，绝大多数是在**整页字符串**上找标签（取页面里的某个块），
        // 与「条目要不要标记」无关 —— 收进来会把影响面从 17 处推到 40+ 处。
        expect(
            usesJsoupOnResult(`var m = String(result).match(/<h1[^>]*>([^<]*)<\\/h1>/); m`),
        ).toBe(false)
    })
})
