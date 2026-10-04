/**
 * 登录态：`loginUrl` 的三种形态与三层请求头
 *
 * 第五十七轮把三件事接起来：**能跑 `loginUrl`**、**落库**、**请求带上**。
 * 这里钉住其中不用起沙箱、不起网络的那三段（形态 + 调用 + 头序）：
 *
 *   ① `loginUrl` 里那段脚本的**形态** —— 语料里既有裸脚本，也有按「规则字段」
 *      加了 `@js:` / `<js>…</js>` 标记的；标记不剥掉，沙箱会拿它当 JS 解析，
 *      报出来的是 `SyntaxError: unexpected token '@'`（把人往「书源写错了」方向带）。
 *   ② **一条登录页地址**（116 条 loginUrl 里 65 条）—— 那是 App 用 WebView 打开的
 *      页面，硬当 JS 跑只会报 SyntaxError；要认出来、给一句明白话。
 *   ③ **补上调用 `login()` 那一步** —— 脚本按约定只是「定义 login() 等着被调」
 *      （40 条脚本型里 33 条如此、0 条自己调），不调用就等于没跑登录。
 *   ④ 请求头的**三层叠加顺序** —— 登录头 → 默认头 → 书源自己的 `header`，
 *      后面的盖前面的。写反了会让一次登录的快照把书源写过的 UA / Cookie 闷掉。
 *
 * 沙箱内那半（`putLoginHeader` 写穿、`getLoginInfo` 读回来）不走单测 ——
 * `src/engine/js.ts` 顶层 import 了 `.wasm`，vitest 加载不了（同第五十三轮），
 * 那部分由冒烟第 44 段在线的站点上验。
 */

import { describe, expect, it } from 'vitest'

import type { BookSource } from '../src/engine/types'
import { loginAddressOf, loginInvocation, normalizeLoginScript } from '../src/legado/loginScript'
import { requestHeadersFor } from '../src/legado/sourceHeaders'

/** 只放受测的那几列：`loginHeader` / `header` */
function sourceOf(patch: Partial<BookSource>): Pick<BookSource, 'loginHeader' | 'header'> {
    return { loginHeader: patch.loginHeader, header: patch.header }
}

describe('normalizeLoginScript：`loginUrl` 里那段脚本的形态', () => {
    it('裸脚本原样留着（语料里绝大多数就是这个形状）', () => {
        const src = 'function checkSite(){ try{ var t = Date.now(); } catch(e){} }'
        expect(normalizeLoginScript(src)).toBe(src)
    })

    it('开头的 `@js:` 剥掉（📂霹雳书屋 那个形状：标记后面接函数体）', () => {
        expect(
            normalizeLoginScript('@js:\nfunction login(){ var m = source.getLoginInfoMap() }'),
        ).toBe('function login(){ var m = source.getLoginInfoMap() }')
    })

    it('整段被 `<js>…</js>` 包住时连标签一起去掉，属性也认', () => {
        expect(normalizeLoginScript('<js>var QQ_GROUP = "1097919737"</js>')).toBe(
            'var QQ_GROUP = "1097919737"',
        )
        expect(normalizeLoginScript('<js type="text/javascript">login()</js>')).toBe('login()')
    })

    it('散落在**中间**的 `@js:` 不动 —— 那可能是脚本自己的字符串内容', () => {
        const src = 'var marker = "@js:"; login()'
        expect(normalizeLoginScript(src)).toBe(src)
    })

    it('空 / 只有空白 → 空串（调用方据此判「没写登录脚本」）', () => {
        expect(normalizeLoginScript(undefined)).toBe('')
        expect(normalizeLoginScript(null)).toBe('')
        expect(normalizeLoginScript('')).toBe('')
        expect(normalizeLoginScript('   \n\t ')).toBe('')
    })

    it('两侧的空白一并剪掉', () => {
        expect(normalizeLoginScript('  \n  login()  \n  ')).toBe('login()')
    })
})

describe('loginInvocation：宿主补上「调用 login()」那一步', () => {
    it('定义了 `login` 又没自己调 → 追加一句调用（语料 33/40 就是这个形状）', () => {
        const script = 'function checkSite(){} function login(){ checkSite(); }'
        const out = loginInvocation(script)
        expect(out.startsWith(script)).toBe(true)
        expect(out).toContain('if (typeof login === "function") { login(); }')
    })

    it('没有 `function login(` 的原样返回（🎬🔞黄豆短剧 那种没这一层）', () => {
        const script = 'java.toast("没有登录函数");'
        expect(loginInvocation(script)).toBe(script)
    })

    it('自己已经在顶层调过 `login()` 的原样返回（不重复跑一次登录）', () => {
        const script = 'function login(){ java.toast("hi") }\nlogin();'
        expect(loginInvocation(script)).toBe(script)
    })

    it('`function login()` 里那个 `login(` 不算调用 —— 只有声明时照样要追加', () => {
        const script = 'function login(){ return 1 }\nfunction other(){}'
        expect(loginInvocation(script)).toContain('if (typeof login === "function")')
    })

    it('`source.login()` 那种带点的也不算脚本自己调', () => {
        const script = 'function login(){ source.login(); }'
        expect(loginInvocation(script)).toContain('if (typeof login === "function")')
    })
})

describe('loginAddressOf：`loginUrl` 是「一条登录页地址」的那种', () => {
    it('裸地址认得出来（语料里 116 条 loginUrl 有 65 条是这种）', () => {
        expect(loginAddressOf('https://m.uaa.com/')).toBe('https://m.uaa.com/')
        expect(loginAddressOf('/login.php')).toBe('/login.php')
        expect(loginAddressOf('http://m.zhuishushenqi.com/login?source=/setting')).toContain(
            'zhuishushenqi',
        )
        // `###挂梯` 那种尾巴不影响判断（🎬🔞VirtalTaboo直播）
        expect(loginAddressOf('https://zh.virtualtaboo.live###可能要挂梯')).toContain(
            'virtualtaboo',
        )
    })

    it('「地址 + 选项」的 JSON 写法取出 url（`{ "url": "null" }`，空串也认）', () => {
        expect(loginAddressOf('{ "url": "null" }')).toBe('null')
        expect(loginAddressOf('{ "url": "" }')).toBe('')
    })

    it('脚本一律返回 undefined（不能把脚本误判成地址）', () => {
        expect(loginAddressOf('function login(){ source.putLoginInfo("{}") }')).toBeUndefined()
        expect(loginAddressOf('@js:\nfunction login(){}')).toBeUndefined()
        expect(loginAddressOf('var QQ_GROUP = "1097919737"; function login(){}')).toBeUndefined()
        // 以 `{` 开头但不是合法 JSON：按脚本处理
        expect(loginAddressOf('{ if (a) { login() } }')).toBeUndefined()
        // 块注释起手（`// 站点配置…`）有空白，不算相对路径
        expect(loginAddressOf('// 说明\nfunction login(){}')).toBeUndefined()
    })

    it('空 / 只有空白 → undefined（与「没写登录脚本」是两回事）', () => {
        expect(loginAddressOf(undefined)).toBeUndefined()
        expect(loginAddressOf('')).toBeUndefined()
        expect(loginAddressOf('   ')).toBeUndefined()
    })
})

describe('三层请求头：登录头 / 默认头 / 书源自己写的 header', () => {
    it('书源自己写的头最优先，能盖过登录时的快照', () => {
        const source = sourceOf({
            loginHeader: JSON.stringify({ 'User-Agent': 'LoginUA', 'X-Login': '1' }),
            header: JSON.stringify({ 'User-Agent': 'SourceUA', 'X-Source': '1' }),
        })
        const headers = requestHeadersFor('https://a.com/x', source)
        // 登录头带来的、书源没表态的头保留下来
        expect(headers['X-Login']).toBe('1')
        expect(headers['X-Source']).toBe('1')
        // 书源明确写过的 UA 盖过登录快照
        expect(headers['User-Agent']).toBe('SourceUA')
    })

    it('登录头只**补**默认头里没有的那几个；默认的 UA 它盖不过', () => {
        const source = sourceOf({
            loginHeader: JSON.stringify({ 'User-Agent': 'LoginUA', Cookie: 'sid=1' }),
        })
        const headers = requestHeadersFor('https://a.com/x', source)
        // 默认头里没有 Cookie，登录头把它补上（这正是登录头的作用）
        expect(headers['Cookie']).toBe('sid=1')
        // 默认头里有 UA，且它排在登录头后面 —— 登录那一刻的 UA 快照盖不过它
        expect(headers['User-Agent']).toContain('Mozilla/5.0')
        // 默认头的其余几条还在
        expect(headers['Accept']).toBeDefined()
    })

    it('登录头坏了当没有，不报错（🎨🔞18色漫画 往这里塞的是配置，还带 `#` 前缀）', () => {
        for (const raw of ['#{not json}', 'not json at all', '[1,2,3]', '', 'null']) {
            const source = sourceOf({ loginHeader: raw })
            const headers = requestHeadersFor('https://a.com/x', source)
            // 坏掉的登录头不该带出任何自定义头；默认头照常
            expect(headers['User-Agent']).toContain('Mozilla/5.0')
        }
    })

    it('登录头里的值统一成字符串（数字 token 也算）', () => {
        const source = sourceOf({ loginHeader: JSON.stringify({ 'X-Uid': 12345 }) })
        const headers = requestHeadersFor('https://a.com/x', source)
        expect(headers['X-Uid']).toBe('12345')
    })
})
