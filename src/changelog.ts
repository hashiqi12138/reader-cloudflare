/**
 * 更新记录：版本 → 一句话
 *
 * 它有两个出口：`/api/version`（前端「关于」页读它），以及 README 里那张能力表/轮次记录
 * 之外的「用户能看到的版本历史」。所以这里**只写用户视角的一句话**，
 * 内部怎么改的写在 README 的轮次小节里。
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
