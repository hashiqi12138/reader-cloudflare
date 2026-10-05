# 待办

按「现在就能动手」排序。每条都写清四件事：**为什么**、**已经到哪一步**、**下一步做什么**、
**怎么算做完**（能验的都要能验）。做完就删掉，别留在这里当装饰。

最后更新：2026-10-05（v0.60.0，第七十二轮之后）

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

## 6. ~~沙箱里 `Jsoup.parse(...).select(...)` 之后不能再链 jsoup 方法~~ —— 第七十二轮已修

**修完了**（v0.60.0）。当时那条诊断有一半写歪了，修正后的真相：

- **不是**「`select()` 返回裸数组所以链 `.remove()` 炸」。`Jsoup.parse()` 返回的是裸
  `JsoupElements`，`.remove()` 在它上面**是有的**。
- 真病因两处：**桥里根本没有 `data` 这个 op**（📂少年小说网 的
  `Jsoup.parse(result).select("style").first().data()` 要读 `<style>` 里的隐藏规则）；
  以及 `Jsoup.parse()` 返回的裸 `JsoupElements` **不能下标**（🎨漫画搬运 的
  `select("a")[0].attr("href")`）。
- 上一轮记的另一半是对的：`remove` / `addClass` 那几个只在四份手抄方法表的一份上，
  所以 `result.select(css).remove()` 会炸 —— 四份表已经合成一份 `JS_SURFACE`。

**做了什么**：桥补 `data` + `selectFirst`；`Jsoup.parse` 改成返回数组形态（与脚本里
`result` 一致）；`test/jsoupSurface.test.ts` 做「沙箱方法面 ↔ 桥 op」的双向对账；
靶子 `/fixture/jsoup-toc/1` + `builtin:fixture-jsoup-chain`；冒烟 12c。
详见 README「第七十二轮」。

---

## 7. jsoup 那边还剩两处没实现

**为什么**：第七十二轮把 `data` / `selectFirst` 补上了，下面两处是量过的剩余：

1. **`Attributes` 迭代**：`Array.from(doc.selectFirst(ys).attributes())` —— jsoup 的
   `Attributes` 是可迭代的（每项 `getKey()` / `getValue()`）。线上 **1 处**。
2. **写操作仍是空操作**：`remove()` / `addClass()` / `removeClass()` / `append()` / `prepend()`
   在桥里是空的，所以「先删掉广告条目再取目录」那类源**不会崩、但会多出条目**
   （📂少年小说网、📂PO5、hareading、ao3mirror、📂97k.cc、m.xs8.cn 这一族用到了）。
   真要支持得让句柄**复制节点集**再改，会牵动两千多处调用形态 —— 不是顺手能做的。

**下一步**：先只做第 1 条（纯新增，不牵动别的）；第 2 条要么做成显式的
「拷贝后修改」语义，要么就一直留着并在 README 里说清。

**怎么算做完**：第 1 条有一处内置源的目录规则用 `attributes()` 跑通 + 冒烟断言；
第 2 条要么有实现，要么 README 里那句「多出条目」的说法被替换成真实行为。

---
