/**
 * 沙箱里那五个**对象全局**（source / book / chapter / cookie / cache）的面对照表
 *
 * 与 `JAVA_SURFACE`（`src/engine/platform.ts`）是同一个思路换到另一组名字上：
 * `java.*` 那一边靠 `JAVA_SURFACE` 生成预置、所以表与实现天然一致；这五个对象是
 * 手写在 `src/engine/js.ts` 的 `GLOBALS_PRELUDE` 里的，没有生成关系，所以**必须有东西钉住**，
 * 否则「语料里在调用、沙箱里没有」只会表现为一句
 * `TypeError: not a function`（QuickJS 不说**是哪一个**），几十行的 jsLib 里根本定位不到。
 *
 * 分工：
 *   - `test/sandboxObjects.test.ts`   跑一遍沙箱，核 `methods` 与实现一致（不依赖 dump，永远跑）
 *   - `test/sandboxObjects.scan.test.ts` 拿真实语料对差集，核「用到的方法」全在表里（默认跳过）
 *
 * `methods` **只收函数成员**：`source.key` / `book.name` 这些是数据（属性读不到只是
 * undefined，不抛错），不属于这里。
 */
export interface SandboxObjectSurface {
    /** 沙箱里**真的有**的方法名 */
    methods: string[]
    /**
     * 语料里出现了、但本引擎**故意不做**的名字：名字 → 为什么
     *
     * 它们分两类，两类都要写清楚，因为「不做的理由」决定将来谁该回来补：
     *   1. 上游有、但属于一条**整条没实现**的流程（补它一个没用）
     *   2. **根本不是沙箱对象** —— 扫描是按名字匹配的，源自己的局部变量会被一并数进来
     */
    notDone: Record<string, string>
}

export const SANDBOX_OBJECTS: Record<string, SandboxObjectSurface> = {
    source: {
        methods: [
            'get',
            'getHeaderMap',
            'getKey',
            'getLoginHeader',
            'getLoginHeaderMap',
            'getLoginInfo',
            'getLoginInfoMap',
            'getVariable',
            'getVariableMap',
            'put',
            'putConcurrent',
            'putLoginHeader',
            'putLoginInfo',
            'putVariable',
            'refreshExplore',
            'removeLoginHeader',
            'removeLoginInfo',
            'setExploreScreen',
            'setVariable',
        ],
        notDone: {},
    },
    book: {
        methods: [
            'get',
            'getVariable',
            'getVariableMap',
            'put',
            'putCustomVariable',
            'putVariable',
            'putVariableMap',
            'setReverseToc',
            'setVariable',
        ],
        notDone: {
            includes:
                '不是沙箱对象：源自己箭头函数的参数（🌍🔞爱丽丝书屋 的 booklist.findIndex(book => …)）',
        },
    },
    chapter: {
        methods: ['getVariable', 'getVariableMap', 'isVip', 'putImgUrl', 'putVariable'],
        notDone: {
            substring:
                '不是沙箱对象：源把 chapter 这个名字**重新赋成了字符串**（🏷晋江文学 的 replaceRegex 里 c = chapter; chapter = intro.match(…)）',
        },
    },
    cookie: {
        methods: [
            'getCookie',
            'getCookieMap',
            'getKey',
            'removeCookie',
            'replaceCookie',
            'setCookie',
        ],
        notDone: {
            mapToCookie:
                '上游有，但它属于**登录流程** —— 那条流程整条没实现（那条语句上一步的 response.cookies() 也没有、响应的 Set-Cookie 也不收进 jar），单独补它不解决问题',
            split: '不是沙箱对象：源自己作用域里的 cookie **字符串**（🌍🔞爱丽丝书屋 的 jsLib 里 var cookie = cookieArray[i].trim()）',
        },
    },
    cache: {
        methods: [
            'delete',
            'deleteMemory',
            'get',
            'getFile',
            'getFileUrl',
            'getFromMemory',
            'put',
            'putFile',
            'putFileUrl',
            'putMemory',
        ],
        notDone: {},
    },
}
