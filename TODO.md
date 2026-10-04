# 待办

按「现在就能动手」排序。每条都写清四件事：**为什么**、**已经到哪一步**、**下一步做什么**、
**怎么算做完**（能验的都要能验）。做完就删掉，别留在这里当装饰。

最后更新：2026-10-05（v0.55.0，第六十六轮之后）

---

## 1. 第二个平台适配器（Node / Docker）

**为什么**：v0.55.0 把「跑在哪」收敛成了一层（`src/platform/`），但**只抽了接口、
没落第二个适配器** —— 所以「能换平台」目前是个**结构上的承诺**，没被验证过。
真跑起来才会知道接口里还缺什么（`meta.last_row_id` 就是这么冒出来的：
它是抽这层时唯一发现「原来还用到这个」的东西）。

**已经到哪一步**：接口与那条缝都在了 —— `src/platform/types.ts`
（`PlatformDb` / `PlatformStatement` / `PlatformResult` / `PlatformAssets` / `AppEnv`）、
`src/platform/cloudflare.ts`（`cloudflareEnv(env)`）、`src/platform/wasm.ts`（WASM 从哪来）。
业务代码已经不认 D1，`test/platformBoundary.test.ts` 盯着不许漏回去。

**下一步**：

1. `src/platform/node.ts`：用 `node:sqlite`（Node 22 起内置）实现 `PlatformDb`；
   静态资源走 `fs` + 扩展名映射（或 `@hono/node-server/serve-static`）；
   WASM 走 `readFile` + `WebAssembly.compile`。
2. `src/server/node.ts`：入口，`app.fetch(request, nodeEnv)`。
3. **集成测试**：这个仓库刻意不写「假 D1」（那样测的其实是那个假实现，见
   `test/notes.test.ts` 等文件的说明），所以适配器得配自己的集成测试 ——
   真建一个临时库、跑一遍迁移、走几条读 / 写 / `batch`。

**怎么算做完**：`node src/server/node.ts` 起得来，`npm run smoke` 对着它跑通
（冒烟只打 HTTP，`SMOKE_BASE` 指过去就行）。

---

## 2. 搜索的 CPU 上限（503 没根治）

**为什么**：线上 `/api/search` 的 `cpuTime` 实测 **339~469 ms**（第二十六轮记下的那笔账），
而免费计划的上限是**每次请求 10 ms**，超了就是 503（日志 `outcome: exceededCpu`、
浏览器拿到 `1102`）。第六十四轮把 `/api/sources` 那 27 ms 挪出了计费区（现在 3~10 ms），
**搜索这一块没动** —— 它是真在 quickjs 沙箱里逐条求值，压不动，只能换路子。

**已经到哪一步**：量准了（`wrangler tail` 抓到 `exceededCpu`）；有「一页几个源」
的分片（`public/js/searchPlan.js`，一页 3 个源）与结果缓存；书源按健康度排序
（连续失败的排最后）。

**三条出路**（任选或组合）：

1. **升 Workers Paid**：CPU 默认 30 s、上限 5 分钟，`wrangler.jsonc` 里那行
   `limits.cpu_ms` 也能写了（免费版写它会**部署直接失败**，code 100328）。
2. **把搜索拆成多个小请求**：现在一次请求里要处理一整页书源；拆成「一次一个源」，
   前端并发几路，每个请求都落在预算内。
3. **只搜用户选中的书源**：默认不搜全部 816 个，让用户自己挑。

**还没量的**：`/api/home` 的 `refresh=1`（它要跨书源跑发现页）、以及
`/api/toc` / `/api/content` 这些「只处理一个源」的接口 —— 后者大概率在预算内，
但**没有逐个量过**，别假设。

---

## 3. PWA 的两个小缺口（不影响能不能用）

**为什么**：核对「移动端能不能触发 PWA」时发现的，当时没做。

- **没处理 `beforeinstallprompt`**：Android 上装到桌面只能靠浏览器自带的入口，
  站内没有自己的「装到桌面」按钮；iOS 更得靠引导文案（分享 → 添加到主屏幕）。
- **少了 `apple-mobile-web-app-status-bar-style`**：iOS 独立窗口的状态栏是默认样式，
  纯观感问题。

**怎么算做完**：接上 `beforeinstallprompt` 出一个按钮（iOS 走文案提示），两个 meta 补齐；
冒烟里那组 PWA 静态检查补一条。

---

## 4. 窄屏（≤ 720px）没有真机确认

**为什么**：v0.54.1 修掉了「手机上页脚被整个藏掉」，但验证方式是**读解析后的 CSS 规则**
（`.footer => flex`），不是真的在窄视口里看一眼 —— 浏览器工具没法缩视口，
所以那条结论是**推断**，不是眼见。

**下一步**：拿手机打开线上地址，看页脚（版本号 + 源代码链接）在不在、
底部那条固定导航有没有把它盖住、点击区域够不够；顺带看「关于」页
（41 条记录那个列表）在手机上的排版。

---

## 5. R2（媒体存储）

README 开头写着「Workers + D1 + 静态资源，**后续接 R2**」，一直没动。
现在媒体（图片 / 音频）是**每次请求都回源代取**（`/api/media/:token`，
理由见「媒体为什么必须由服务端代取」）—— 热图会反复打上游。

要动它得先想清楚**哪些能存**：有些图要带账号 cookie 才取得到，存错了会串号。
