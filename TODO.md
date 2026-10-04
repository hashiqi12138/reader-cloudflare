# 待办

按「现在就能动手」排序。每条都写清四件事：**为什么**、**已经到哪一步**、**下一步做什么**、
**怎么算做完**（能验的都要能验）。做完就删掉，别留在这里当装饰。

最后更新：2026-10-05（v0.56.0，第六十七轮之后）

---

## 1. 搜索 503：已定论 —— 免费计划跑不动，**等你拍板**

**结论**（第六十七轮量死的，细节见 README「第六十七轮」）：**一个书源就要 60~220 ms CPU**，
而免费计划是 10 ms/请求 —— 一上来就超 6~22 倍。所以：

- 「拆成一次一个源」**不行**：下限仍是「一个源」，照样超 20 倍；
- 「只搜用户选中的源」**也不行**：同上；
- 连着超预算之后，运行时会把**每个**请求都按 10 ms 截断（实测逐源单发 14 次全部 503），
  所以「失败就重试」在这里是**有害的**。

**真出路只有两条，都需要你定：**

1. **升 Workers 付费计划**（CPU 默认 30 s、上限 5 min）。改 `wrangler.jsonc` 里那行
   `limits.cpu_ms` 就生效（免费版写它会**部署直接失败**，code 100328）；要花钱。
2. **自建部署**（Node / Docker）—— 没有 10 ms 上限，等于把这个问题整个绕开。
   这就是下面第 2 条要做的事。

**顺带一提**：`/api/home` 的 `refresh=1`、以及「只处理一个源」的那些接口
（`/api/toc` / `/api/content`）**还没有逐个量过**。搜索之外的接口里，
只有真的要跑沙箱规则的才会贵（沙箱本身有地板价），量一遍可以确认还有哪些会中招。

---

## 2. 第二个平台适配器（Node / Docker）

**为什么**：v0.55.0 把「跑在哪」收敛成了一层（`src/platform/`），但**只抽了接口、
没落第二个适配器** —— 「能换平台」目前是个**结构上的承诺**，没被验证过。
真跑起来才会知道接口里还缺什么（`meta.last_row_id`、以及第六十七轮新增的
`PlatformCache` 都是这么冒出来的）。**而且它就是上面第 1 条的第二条出路。**

**已经到哪一步**：接口与那条缝都在了 —— `src/platform/types.ts`
（`PlatformDb` / `PlatformStatement` / `PlatformResult` / `PlatformAssets` /
`PlatformCache` / `AppEnv`）、`src/platform/cloudflare.ts`（`cloudflareEnv(env)`）、
`src/platform/wasm.ts`（WASM 从哪来）。业务代码已经不认 D1 与 Cache API，
`test/platformBoundary.test.ts` 四条断言盯着不许漏回去。

**下一步**：

1. `src/platform/node.ts`：用 `node:sqlite`（Node 22 起内置）实现 `PlatformDb`；
   静态资源走 `fs` + 扩展名映射（或 `@hono/node-server/serve-static`）；
   缓存走内存 Map（实现 `PlatformCache` 那两件事）；WASM 走 `readFile` + `WebAssembly.compile`。
2. `src/server/node.ts`：入口，`app.fetch(request, nodeEnv)`。
3. **集成测试**：这个仓库刻意不写「假 D1」（那样测的其实是那个假实现），所以适配器得配
   自己的集成测试 —— 真建一个临时库、跑一遍迁移、走几条读 / 写 / `batch`。

**怎么算做完**：`node src/server/node.ts` 起得来，`npm run smoke` 对着它跑通
（冒烟只打 HTTP，`SMOKE_BASE` 指过去就行）——**搜索那一串应该全绿**，
那正是第 1 条要的结果。

---

## 3. R2（媒体存储）

**状态**：**卡在账号上**。`wrangler r2 bucket list` 报
`Please enable R2 through the Cloudflare Dashboard. [code: 10042]` ——
R2 没开通就建不了 bucket；不能在 `wrangler.jsonc` 里声明绑定（声明了部署会直接失败）。

**已经做了替代方案**（第六十七轮）：媒体缓存改走 **Cache API**（免费版可用、零配置），
按机房生效。所以「热门封面被反复回源」这件事已经有了一层。

**还需要你做的**：要在 Dashboard 里开通 R2（可能还要绑支付方式）。

**开通之后要做什么**：把 `platform/cloudflare.ts` 里的 `CACHE` 换成 R2 实现
（或者缓存 miss 时回源、hit 时走 R2），拿到**全局、可持久**的那一层。
比 Cache API 强的地方：跨机房共享、能设生命周期、能看用量。

---

## 4. PWA 的两个小缺口（不影响能不能用）

- **没处理 `beforeinstallprompt`**：Android 上装到桌面只能靠浏览器自带入口，
  站内没有自己的「装到桌面」按钮；iOS 更得靠引导文案（分享 → 添加到主屏幕）。
- **少了 `apple-mobile-web-app-status-bar-style`**：iOS 独立窗口的状态栏是默认样式。

**怎么算做完**：接上 `beforeinstallprompt` 出一个按钮（iOS 走文案提示），两个 meta 补齐；
冒烟里那组 PWA 静态检查补一条。

---

## 5. 窄屏（≤ 720px）没有真机确认

**为什么**：v0.54.1 修掉了「手机上页脚被整个藏掉」，但验证方式是**读解析后的 CSS 规则**
（`.footer => flex`），不是真的在窄视口里看一眼 —— 浏览器工具没法缩视口，
所以那条结论是**推断**，不是眼见。

**下一步**：拿手机打开线上地址，看页脚（版本号 + 源代码链接）在不在、
底部那条固定导航有没有把它盖住、点击区域够不够；顺带看「关于」页
（40+ 条记录那个列表）在手机上的排版。
