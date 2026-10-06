/**
 * 更新记录：版本 → 一句话
 *
 * 它有两个出口：`/api/version`（前端「关于」页读它），以及 EXPERIENCE.md 里那张能力表/轮次记录
 * 之外的「用户能看到的版本历史」。所以这里**只写用户视角的一句话**，
 * 内部怎么改的写在 EXPERIENCE.md 的轮次小节里。
 *
 * 几条规矩：
 * 1. **最新的一版在最前面**，`CHANGELOG[0].version` 必须等于 `wrangler.jsonc` 里的
 *    `ENGINE_VERSION`、也等于 `package.json` 的 `version` —— 三处漂了是**静默**故障
 *    （界面显示 0.53 而实际跑 0.52），所以 `test/changelog.test.ts` 直接读那两个文件比对。
 * 2. 发版时在这里加一条，与「版本号改哪几处」是同一件事，别只改版本号忘了它。
 * 3. 措辞尽量与那次发布的 `chore(release)` 提交标题一致 —— 这份记录最初就是从
 *    那批标题里导出来的（`v0.16.0` 起），保持一致才好对照。
 */

export interface ReleaseNote {
    /** 不带 `v` 前缀，与 `ENGINE_VERSION` 的写法一致 */
    version: string
    /** 发布当天的日期（`YYYY-MM-DD`） */
    date: string
    /** 一句话，说清「用户能感觉到的那件事」 */
    note: string
}

export const CHANGELOG: ReleaseNote[] = [
    {
        version: '0.69.0',
        date: '2026-10-06',
        note: 'Cloudflare 上那份拆成了**页面**与**接口**两次独立部署：页面发到 Cloudflare Pages（`npm run deploy:page`），接口仍是那个 Worker（`npm run deploy`）—— 改界面不必碰接口，改接口不必重发页面。浏览器看到的还是同一个源（Pages 上带了一层把 `/api` 接回去的同源反代），所以会话、封面代取、离线缓存全都照旧；两个入口都能打开：`reader-cloudflare.pages.dev` 与 `reader-api.…workers.dev`',
    },
    {
        version: '0.68.1',
        date: '2026-10-06',
        note: '返回键的手感：在阅读界面里读了十几章，按一次返回就回到进来之前那一页（以前得一章一章地退）；登录、退出、换源、发现页换源这些「换个界面」的跳转也不再压历史 —— 顺带修掉「登录后返回键在登录页与首页之间来回弹」；直接打开一个分享的阅读链接时，「‹ 返回」现在有去处（退回这本书的详情页），而不是点了没反应',
    },
    {
        version: '0.68.0',
        date: '2026-10-06',
        note: '两件事：一是**换源** —— 读到一半发现这个源的错字多、缺章，可以换到别的源接着读，书架上的记录与阅读位置一起搬过去（落点按章名对，对不上会如实说「从第一章开始」，而不是假装对上了）；二是自建与容器那份**一次搜索就把全部启用的书源搜完**，不用再挑源（`SEARCH_ALL_SOURCES` 控制，写 `false` 回到「一页几个」的老样子；线上那份本来就是 false）',
    },
    {
        version: '0.67.0',
        date: '2026-10-05',
        note: '多了容器这一份：`docker compose up -d --build` 就能把整套东西跑在自己的 Docker 里（不经过 Cloudflare，也就没有每请求 10 毫秒的 CPU 上限），数据落在命名卷里、重启不丢；用法与参数写在单独的 DOCKER.md',
    },
    {
        version: '0.66.0',
        date: '2026-10-05',
        note: 'jsoup 那几个「改了等于没改」的写操作变成真的了：`attr(k, v)` / `addClass` / `append` 之类以前一律静默无效，🎨笔趣漫画 那种「把真图地址塞回 `src`、再整批返回」的正文脚本因此一章都取不到 —— 现在能取到，而且「选出一批节点」的几种写法（`[i]` / `.length` / `forEach` / `size()`）统一成同一种形状；顺带把发现页的 `java.put` 跨请求变量接通（📂阿巴小说 / 📂乐乎文章 / 📂小米书城 这三条）',
    },
    {
        version: '0.65.0',
        date: '2026-10-05',
        note: '规则跑得再快一点：一次选出几百个章节链接时，脚本逐条读 `href` / 文本不再逐个来回问宿主（1600 个节点的实测少花约 15%）；另外把沙箱搬进了单元测试 —— 这是内部的事，但意味着预置里那层 JS 的改动从此有直接断言盯着',
    },
    {
        version: '0.64.0',
        date: '2026-10-05',
        note: '又修好两条**静默变 0 章**的路：脚本用 `Array.from(java.getElements(…))` 时拿到的永远是空数组（沙箱里没有迭代器），以及 `attributes()` 缺失 —— 📂贝壳读书 现在能出目录，🎨51漫画 也终于读到它藏在 script 里的**真目录**（以前只有兜底的一章）；顺带把桥取整串元素的往返从「每个元素三次」压成一次，604 个节点的规则上实测快约 21%',
    },
    {
        version: '0.63.0',
        date: '2026-10-05',
        note: '多了第二条腿：整套东西现在也能跑在自己的一台机器上（`npm run start:node`）—— 不碰 Cloudflare、没有每请求 10 毫秒的 CPU 上限，书源与进度存在本机 SQLite 里；线上那份部署一行没变',
    },
    {
        version: '0.62.0',
        date: '2026-10-05',
        note: '目录又修好一批：脚本要按标记认条目时（`Array.from(result)` + `String(块).includes("<h3")`）以前拿到的是纯文本，于是目录 0 章还不报错 —— 🎨漫画搬运 现在 462 章；顺带把「脚本执行时限」改成只算脚本自己转的时间（宿主解析不再被算成脚本在转），并且死循环照样会被中断',
    },
    {
        version: '0.61.0',
        date: '2026-10-05',
        note: '目录修全：`java.put` / `java.get` 的跨请求变量真正接通了（详情页存下的内容现在目录那次取得到），`remove()` 也从空操作改成真删 —— 📂少年小说网 的目录从 871 章乱序变成 950 章升序、开头 100 章不再丢；这一族写法在 816 条源里有 35 处断在 24 个源上',
    },
    {
        version: '0.60.0',
        date: '2026-10-05',
        note: '修好 jsoup 链式调用：补上 `data()` 与 `selectFirst()`，`Jsoup.parse(...).select(...)` 的结果现在能下标（线上 86 条源用这个写法，其中两条一直报 not a function / cannot read property of undefined）；顺带把沙箱里四份手抄的方法表合成一份并加了防漂移的扫描测试',
    },
    {
        version: '0.59.0',
        date: '2026-10-05',
        note: '正文里的 HTML 摊平成纯文本：`<br>` 与段落标签变成真正的换行，标签不再当字面文字显示（一半以上的书源用 @html 取值）；顺带不再把正文 div 里挂着的 <script> 读进来',
    },
    {
        version: '0.58.0',
        date: '2026-10-05',
        note: '书源可以按分组浏览与筛选（名字 / 分组 / 状态 / 能力），还能一次改一批的启用状态；选择书源的地方也都能按分组找；顺带修好了「启用 / 停用」开关（它一直点不动）',
    },
    {
        version: '0.57.0',
        date: '2026-10-05',
        note: '搜索可以指定书源（只搜挑好的那几个）；并更正上一轮「指定源也没用」的结论',
    },
    {
        version: '0.56.0',
        date: '2026-10-05',
        note: '媒体代取加了一层边缘缓存；搜索 503 的结论：免费计划的 10 ms 上限跑不动，需要换宿主',
    },
    {
        version: '0.55.0',
        date: '2026-10-05',
        note: '平台兼容层：数据库 / 静态资源 / WASM 收敛到 src/platform（只抽接口，还没落第二个适配器）',
    },
    {
        version: '0.54.1',
        date: '2026-10-05',
        note: '手机上的页脚回来了：版本号与「关于」入口不再在窄屏里消失',
    },
    {
        version: '0.54.0',
        date: '2026-10-05',
        note: '版本信息与更新记录：/api/version + 页脚版本号 + 关于页',
    },
    {
        version: '0.53.0',
        date: '2026-10-05',
        note: '压 CPU：书源列表下推 D1 + ETag/304 + 前端复用',
    },
    { version: '0.52.0', date: '2026-10-05', note: 'PWA：装到桌面 + 断网还能开' },
    { version: '0.51.1', date: '2026-10-05', note: '翻页步长与页数按布局量' },
    { version: '0.51.0', date: '2026-10-05', note: '搜索 / 发现的逐条字段走批量求值' },
    { version: '0.50.1', date: '2026-10-04', note: '搜索地址模板里的取网按搜索预算走' },
    { version: '0.50.0', date: '2026-10-04', note: '沙箱取网跟预算走' },
    {
        version: '0.49.0',
        date: '2026-10-04',
        note: '批量求值：预置只解析一次，标注上限 300 → 1200',
    },
    { version: '0.48.0', date: '2026-10-04', note: '登录界面：读 loginUi / 渲染表单 / 按钮可点' },
    { version: '0.47.0', date: '2026-10-04', note: '书源登录态：loginUrl / 落库 / 请求带上' },
    {
        version: '0.46.0',
        date: '2026-10-04',
        note: '目录标注：isVip / isPay / isVolume / updateTime',
    },
    {
        version: '0.45.0',
        date: '2026-10-04',
        note: '重定向自己跟：每一跳的 Set-Cookie 与第一跳的 Location',
    },
    { version: '0.44.0', date: '2026-10-04', note: 'cookie 罐：收 / 发 / 存' },
    { version: '0.43.0', date: '2026-10-04', note: '对象全局的方法面 + 预置解转义检查' },
    { version: '0.42.0', date: '2026-10-04', note: 'java.* 名字登记 + 第 14 条账本' },
    { version: '0.41.0', date: '2026-10-04', note: 'getLoginInfoMap 的 Map 语义 + 体检 2.0' },
    { version: '0.40.0', date: '2026-10-04', note: 'JSOUP `class.A B`' },
    { version: '0.39.0', date: '2026-10-04', note: 'script/style 节点' },
    { version: '0.38.0', date: '2026-10-04', note: 'http 封面代取' },
    { version: '0.37.0', date: '2026-10-04', note: '防盗链封面代取' },
    { version: '0.36.0', date: '2026-10-04', note: '单斜杠 XPath' },
    { version: '0.35.0', date: '2026-10-04', note: '字段级容错 + 抽样体检脚本' },
    { version: '0.34.0', date: '2026-10-04', note: '多行选项块' },
    { version: '0.33.0', date: '2026-10-04', note: 'URL 选项里的 body 写对象' },
    { version: '0.32.0', date: '2026-10-04', note: '地址类字段的请求选项' },
    {
        version: '0.31.0',
        date: '2026-10-04',
        note: '$[ 开头的 JSONPath 与 JSONPath 尾段的作用对象',
    },
    { version: '0.30.0', date: '2026-10-04', note: '跨请求的 @put:/@get:' },
    { version: '0.29.0', date: '2026-10-04', note: 'init 换根' },
    { version: '0.28.0', date: '2026-10-04', note: '@put:/@get: 与 ruleBookInfo.init' },
    { version: '0.27.0', date: '2026-10-04', note: '字段规则也能走 CSS 式多段 @' },
    { version: '0.26.0', date: '2026-10-04', note: '列表规则的首段下标后缀与 `!` 排除下标' },
    { version: '0.25.0', date: '2026-10-04', note: '列表规则末尾的标签当步骤' },
    { version: '0.24.0', date: '2026-10-04', note: 'JS 尾段列表规则保留节点' },
    { version: '0.22.1', date: '2026-10-04', note: '取网返回值两用' },
    { version: '0.22.0', date: '2026-10-04', note: '书源变量落库' },
    {
        version: '0.21.0',
        date: '2026-10-04',
        note: 'source.getKey / java.connect / result.toArray 三处引擎修复',
    },
    { version: '0.20.0', date: '2026-10-04', note: 'java 兼容层：纯计算那批' },
    { version: '0.19.0', date: '2026-10-04', note: 'java 兼容层' },
    { version: '0.18.0', date: '2026-10-04', note: '书源抽样体检后的引擎修复' },
    { version: '0.17.1', date: '2026-10-04', note: '翻页位置修复 + 搜索一页 3 个源与结果缓存' },
    { version: '0.16.0', date: '2026-10-03', note: '笔记 + 替换净化同步' },
]
