# 待办

按「现在就能动手」排序。每条都写清四件事：**为什么**、**已经到哪一步**、**下一步做什么**、
**怎么算做完**（能验的都要能验）。做完就删掉，别留在这里当装饰。

最后更新：2026-10-05（v0.59.0，第七十一轮之后）

---

## 1. 搜索的 CPU：成串发才会被掐 —— 已缓解，根治要换宿主

**规律（第六十八轮更正过；第六十七轮那句「一个源也超预算、指定源没用」说过了头）**：
真正会出事的是「**短时间内成串发**」，不是「单个请求超了必死」。实测（单源 / 三源交替、
中间留 8 秒）两边各 **4/4 成功**，`cpuTime` 72~443 ms —— **443 ms 的请求也拿到了 200**；
而一串超预算请求之后，运行时会把**每个**请求都截在 10 ms，那时连单源也是全 503。

**已经做的缓解**（第六十八轮）：

- 搜索页可以**指定书源**：只搜挑好的那几个，少搜就少占那个窗口；
- 「搜全部」那条路仍按健康度分页（一页 3 个）、撞上截断时折半重试 —— 那是它的自保机制。

**仍然没解决**：`cpuTime` 几十到几百毫秒这件事没变（抓页面 + 解析 + 跑规则本来就贵），
免费计划的 10 ms/请求本来就装不下。所以用得猛了还是会撞上那个窗口。

**要根治，两条路（需要你定）**：

1. **升 Workers 付费计划**（CPU 默认 30 s、上限 5 min）—— 改 `wrangler.jsonc` 里那行
   `limits.cpu_ms` 即可（免费版写它会**部署直接失败**，code 100328）；要花钱。
2. **自建部署**（Node / Docker）—— 没有 10 ms 上限，等于把这个问题整个绕开。就是下面第 2 条。

**还没量的**：`/api/home` 的 `refresh=1`、以及 `/api/toc` / `/api/content` 的 `cpuTime`
（都只处理一个源，大概率没事，但没量过就别假设）。

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

---

## 6. 沙箱里 `Jsoup.parse(...).select(...)` 之后不能再链 jsoup 方法

**为什么**：第七十一轮抽检时 📂少年小说网 的目录规则报 `TypeError: not a function（脚本第 3 行）`。
规则是 `org.jsoup.Jsoup.parse(result)` → `a.select("style").first().data()` →
`a.select(b).remove()`。定位：`org.jsoup.Jsoup.parse()` 返回的 `__htmlApi`（字符串底座 + jsoup 方法）
里，`select()` 为了让 `links[i]` 与 `links.length` 能用，返回的是**裸数组** ——
于是 `select()` 之后再链 `.remove()` / `.first()` 就是 `not a function`
（`remove()` 本身在桥里是有的，只是挂在 `JsoupElements` 上，挂在数组上的调用不到）。

**影响面（已量）**：86 条源（10.5%）的规则里用了 `Jsoup.parse`，其中 8 条的规则里带
`.remove()`、12 条带 `.first()`。**注意这只是「同一份 payload 里两个字符串都出现」，
不等于「真的链在 select 后面」—— 下一步第一件事是逐条看，把真实受影响的那几条挑出来。**

**下一步**：

1. 把 8 + 12 条源的规则原文拉出来，看有几条真的是 `select(...).方法(...)` 的链式写法。
2. 修法：让 `__htmlApi` 里返回句柄的那几个方法（`select` / `not` / `filter` / `has` / `clone` …）
   返回的对象**同时**具备数组的下标与 `length` **和** `JsoupElements` 的方法链
   （形如「数组 + 方法挂到实例上、内部绑同一个句柄」）。别退化成裸 `JsoupElements`
   —— 那会把 🔞紫云宫 那条 `links[i]` / `links.length` 的写法重新弄坏（有过一次）。
3. 拿 📂少年小说网 做端到端的活靶子，另加一个内置测试源的 `<js>` 目录规则钉住链式调用。

**怎么算做完**：那几条源能在线上取到目录；冒烟里有「`Jsoup.parse(...).select(...)` 之后再链
`.first()` / `.remove()`」的断言；`jsoupBridge` 的方法面也像 `java.*` 那样有一张登记表
（现在沙箱侧的方法表在 `js.ts` 的 `JS_METHODS`，但**没有扫描**钉住「语料里用到的 jsoup 方法
都在表里」—— 这一条值得一起补）。
