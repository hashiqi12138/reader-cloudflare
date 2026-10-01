# reader-cloudflare

书源聚合阅读器：**兼容 Legado 书源规则格式**的解析引擎 + 阅读器，整套跑在 Cloudflare 上（Workers + 静态资源，后续接 D1 / R2）。

## 当前状态

骨架已搭起，**「搜索 → 详情 → 目录 → 正文」主链路已跑通**（见下方「验证」）。

| 能力                                                 | 状态                                |
| ---------------------------------------------------- | ----------------------------------- |
| JSOUP 默认规则（`class.x.0@tag.a@href` 这类）        | 已实现                              |
| `@css:` CSS 选择器                                   | 已实现                              |
| `@json:` / `$.` JSONPath                             | 已实现（不含过滤器表达式）          |
| `##正则##替换` 链（净化 / `###` OnlyOne / AllInOne） | 已实现                              |
| `&&` / `                                             |                                     | `/`%%` 同级连接符 | 已实现 |
| `<js></js>` 中段脚本、`@js:` 尾段脚本                | 已实现（同步）                      |
| `{{key}}` / `{{page}}` 等 URL 模板                   | 已实现                              |
| GBK / GB2312 等非 UTF-8 站点                         | 已实现（自动嗅探 + 按站点声明解码） |
| 搜索 → 详情 → 目录 → 正文 四步链路                   | 已实现                              |
| **XPath**（`//` 或 `@XPath:`）                       | **未实现**，遇到会明确报错          |
| **`java.ajax` 等异步脚本**                           | **未实现**，遇到会明确报错          |
| 书源管理界面 / 书架 / 阅读进度                       | 未开始                              |
| 多用户 / 登录                                        | 未开始                              |

未实现的两项都**显式抛错**而不是静默返回空 —— 后者会让书源表现成「搜不到书」，排查成本极高。

## 为什么这件事不是「移植一个开源项目」

主流的小说阅读器都跑不在 Workers 上：

| 项目                              | 技术栈               | 能否上 Workers                        |
| --------------------------------- | -------------------- | ------------------------------------- |
| 阅读3.0 / Legado                  | Android + Kotlin     | 不能，是安卓 App                      |
| 阅读3服务器版（hectorqin/reader） | Kotlin + Spring Boot | 不能，JVM 且有状态                    |
| riowang88/reader                  | Python + FastAPI     | 不能                                  |
| any-reader                        | TypeScript           | 规则格式是 eso 源，与 Legado 生态不通 |

所以这里是**用 TypeScript 重写规则引擎**，前端后续自己写。好在书源规则是**声明式**的，
真正要复刻的是一套规则语法，而不是某个应用的内部实现。

## 一个绕不过去的硬约束

Cloudflare Workers **禁用 `eval()` 与 `new Function()`**，而 Legado 书源里的 `@js:` 规则、
`{{}}` 模板都是货真价实的 JS 代码。解决办法是外挂一个编译成 WASM 的 ECMAScript 引擎
（本项目用 QuickJS；Cloudflare 自己在 Kitesurf 里用的是 Rust 写的 Boa）。

Workers 上跑 QuickJS 有两个坑，都已处理：

1. **不能让 Emscripten 自己去取 `.wasm`**。Workers 没有文件系统，也禁止从字节编译 WASM，
   唯一可行的是让打包器处理一个**相对路径**的 `.wasm` import。因此
   `scripts/copy-quickjs-wasm.mjs` 会把 WASM 从 `node_modules` 复制到 `src/engine/`，
   并用 `newVariant()` 直接把手上的 `WebAssembly.Module` 交给 QuickJS。
2. **句柄必须自己 dispose**。`newFunction()` 返回的句柄归调用方所有，忘了释放会让
   runtime 销毁时断言失败（`list_empty(&rt->gc_obj_list)`），表现为整个请求 Aborted。

书源来自社区、内容不可控，所以沙箱按**不可信代码**对待：限制内存（8 MB）、栈（512 KB）、
执行时间（1.2 s，靠 QuickJS 的中断回调实现超时），且每次执行新建 runtime、用完即销毁。

## 目录结构

```
src/
├── index.ts              Worker 入口与 API 路由
├── fixture.ts            内置测试站点（ENABLE_FIXTURE=true 时才挂载）
├── data/sources.ts       书源注册表（当前只有内置测试源）
├── engine/               规则引擎（与"书源"无关，可单独复用）
│   ├── types.ts          公共类型
│   ├── jsoup.ts          JSOUP 默认规则的解析（规则 → 计划，不碰 cheerio）
│   ├── select.ts         用 cheerio 执行计划（计划 → 节点/文本）
│   ├── analyze.ts        规则求值主入口：选择器 → 正则链 → JS 串起来
│   ├── regex.ts          ## 正则链与 AllInOne
│   ├── jsonpath.ts       极简 JSONPath
│   └── js.ts             QuickJS 沙箱
├── legado/
│   ├── source.ts         书源模型、URL 与请求选项解析、{{}} 模板
│   └── ops.ts            搜索 / 详情 / 目录 / 正文 四步
└── lib/http.ts           取网：字符集处理、体积上限、默认请求头
```

`engine/` 与 `legado/` 分开是有意的：引擎只认规则字符串，不知道"书源"是什么；
换一套书源格式（比如 eso 源）只需要再加一个 `legado/` 这样的适配层。

## 验证

```bash
npm install
npm test          # 引擎纯函数的单元测试（32 项，Node 里毫秒级跑完）
npm run dev       # 另开一个终端
npm run smoke     # 端到端：搜索 → 详情 → 目录 → 正文
```

单元测试只覆盖**纯函数**（规则解析、位置选择、正则链、JSONPath），因此在 Node 里跑；
涉及 cheerio 与 QuickJS-WASM 的部分交给 `npm run smoke` 在**真实 workerd 运行时**里验证。
两者分工明确，缺一不可：前者保证语义正确，后者保证运行时可跑。

内置测试站点（`/fixture/*`）是项目自己造的，不依赖任何第三方站点 —— 第三方站会改版、
会挂、在 CI 机房会被墙，拿它做回归会出现"今天绿明天红，却说不清是谁的问题"。

## 部署

```bash
npm run deploy    # 需要先 npx wrangler login
```

`ENABLE_FIXTURE` 线上保持 `false`（默认值），它是测试内容，不该对外提供。

## 关于书源

本项目**不提供、也不分发任何书源**。规则引擎是中立的工具，指向哪个站点、抓取什么内容，
由使用者自行决定并自负其责 —— Legado、any-reader 这些项目也都是这么划线的。

请遵守目标站点的服务条款与 robots 协议，并注意所在地区的版权法规。
项目自带的"内置测试站点"只包含项目自己生成的内容，用于验证链路。

## 后续计划

1. **XPath 支持** —— 目前最大的覆盖率缺口，一部分书源会用到
2. **异步脚本（`java.ajax`）** —— 需要启用 QuickJS 的 asyncify 变体
3. **书源管理** —— D1 存书源 / 书架 / 阅读进度，支持导入 Legado 书源 JSON
4. **前端阅读器** —— 替换掉当前的占位页面
5. **`ENABLE_FIXTURE` 的 CI 检查** —— 把 smoke 接进 GitHub Actions

## 许可

待定。
