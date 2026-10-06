# 待办

按「现在就能动手」排序。每条都写清四件事：**为什么**、**已经到哪一步**、**下一步做什么**、
**怎么算做完**（能验的都要能验）。做完就删掉，别留在这里当装饰。

最后更新：2026-10-06（v0.69.0，第八十二轮之后）

---

## 1. 搜索的 CPU：成串发才会被掐 —— 已缓解，根治要换宿主

**规律（第六十八轮更正过；第六十七轮那句「一个源也超预算、指定源没用」说过了头）**：
真正会出事的是「**短时间内成串发**」，不是「单个请求超了必死」。实测（单源 / 三源交替、
中间留 8 秒）两边各 **4/4 成功**，`cpuTime` 72~443 ms —— **443 ms 的请求也拿到了 200**；
而一串超预算请求之后，运行时会把**每个**请求都截在 10 ms，那时连单源也是全 503。

**已经做的缓解**（第六十八轮）：

- 搜索页可以**指定书源**：只搜挑好的那几个，少搜就少占那个窗口；
- 「搜全部」那条路仍按健康度分页（一页 3 个）、撞上截断时折半重试 —— 那是它的自保机制；
- **自建 / 容器那两份不用受这条罪**：第八十轮起 `SEARCH_ALL_SOURCES` 默认开，
  一个请求把全部启用的书源搜完，根本没有「一页几个」这回事（见下面第 2 条）。

**仍然没解决**：`cpuTime` 几十到几百毫秒这件事没变（抓页面 + 解析 + 跑规则本来就贵），
免费计划的 10 ms/请求本来就装不下。所以用得猛了还是会撞上那个窗口。

**要根治，两条路（需要你定）**：

1. **升 Workers 付费计划**（CPU 默认 30 s、上限 5 min）—— 改 `wrangler.jsonc` 里那行
   `limits.cpu_ms` 即可（免费版写它会**部署直接失败**，code 100328）；要花钱。
2. **自建部署（Node / Docker）** —— 没有 10 ms 上限，等于把这个问题整个绕开。
   **第七十五轮已经把这一条做实了**：`npm run start:node` 起得来、冒烟对着它全绿，
   库换成本机的 SQLite（见 `## 2` 那条已完成记录）；**第七十九轮补上了容器那一份**
   （`docker compose up -d --build`），**第八十轮把「一次搜完全部书源」也接上了**
   （`SEARCH_ALL_SOURCES`，见下）。**现在就能用，不再是「计划」。**

**还没量的**：`/api/home` 的 `refresh=1`、以及 `/api/toc` / `/api/content` 的 `cpuTime`
（都只处理一个源，大概率没事，但没量过就别假设）。

**第七十四轮顺手量到一个具体的点**（比「搜索太贵」更极端，也更容易复现）：

|                                          | 本地 `wrangler dev` | 线上（免费计划，同一时刻） |
| ---------------------------------------- | ------------------- | -------------------------- |
| 📂少年小说网 的目录（950 章，10 页目录） | 200                 | **200 / 950 章**           |
| 🎨漫画搬运 的目录（462 章）              | **462 章**          | **503**（平台掐掉）        |

`wrangler dev` 不设 CPU 上限，所以本地能跑通的规则线上未必跑得通 —— 这两条是现成的对照。
🎨漫画搬运 那条一次求值要 ≈900 次 `Jsoup.parse` 加 ≈两万次宿主调用（宿主侧 ≈1.1 s）。

**可做的一步（还没做）**：给「一次求值的宿主工作量」加一条上限（`engine/js.ts` 里已经有
`busy.ms` 这个记账，直接拿来用）—— 超了就**干净地报错**（并且不产出半截结果），
而不是让平台把整个请求掐成 503。好处有两个：用户看到的是「这个源太重/超时」而不是一个
吓人的错误页；以及超预算请求会**污染运行时**（第六十八轮：一串之后连单源都会 503），
早点自己收手能少踩那个状态。要定的是阈值（得先在线上量几条能跑通的规则的宿主耗时）。

**第七十五轮起，阈值可以量了**：自建那侧（`npm run start:node`）**不设 CPU 上限**，
而那条源在免费计划下必被掐 —— 所以「同一条规则在自建上跑，宿主耗时是多少」正是要的那个数，
在那边量出来的数字才是阈值该取的量级。量完两条再回线上看有没有落进 10 ms 那个窗口。

---

## 2. ~~第二个平台适配器（Node / Docker）~~ —— 第七十五轮已做，第七十九轮补上容器

**做完了**（v0.63.0）。落地的东西：`src/platform/node.ts`（`node:sqlite` / `fs` / 内存 Map）、
`src/platform/wasm.node.ts`（`readFile` + `new WebAssembly.Module`）、`src/server/node.ts`
（入口：建库 / 跑迁移 / http ↔ Request·Response / SPA 回退）、`scripts/build-node.mjs`
（esbuild + 把 `platform/wasm` 换成 `wasm.node.ts` 的替换插件）、`test/platformNode.test.ts`（8 条）。
`engine/js.ts` 那句 import 一个字没改。

**验收标准达到了**：`npm run start:node` 起得来，`SMOKE_BASE=http://127.0.0.1:8790 node scripts/smoke.mjs`
**连跑两遍全绿**（11 个书源的链路 + 书源管理 + 登录态 + 媒体缓存 + PWA……）。单测 993 → 1001。

**跑起来才挖出来的两个缺陷**（这两个才是「抽了接口但没跑过第二个实现」的真正代价，
它们都只在**别处跑**才露头，详见 EXPERIENCE.md「第七十五轮」）：

1. `NodeDb.batch()` 一律走 `all()`，而 `.all()` 只给行 —— 写语句的 `meta.changes` 恒为 0。
   可 `setSourceEnabled` / `setSourcesEnabled` / `deleteSource` / `revokeSession` 四处都拿它
   判「到底改到没有」，于是冒烟一次红五条（数据改了、接口却说「找不到书源」）。
   D1 的 `batch()` 是**统一的按语句结果**，`node:sqlite` 是 `all()` / `run()` **两套 API** ——
   接口抽象没把这层差异暴露出来，所以只有真跑才碰得到。
2. `PlatformCache` 的 `put` 照字面实现成 `store.set(url, response.clone())`，等于把一根**活的流**
   留在缓存里；第二趟 `match` 去 clone 一根已被读过的分支，运行时抛
   `Response.clone: Body has already been consumed.` —— 表现是「第一张图正常、之后同一张图一律 500」。
   Cache API 的真实语义是**收完体存字节**。这条**连跑第二遍冒烟**才复现。

顺带被逼出来的两处（改的是已有的那份代码）：`cloudflare.ts` 的 `defaultCache` 从模块顶层常量
挪进函数（Node 上没有 `caches` 全局，顶层求值 = 自建入口 import 阶段就崩）；
`platformBoundary.test.ts` 那条「`.wasm` 只有一处」改成「**业务代码里一个都不许有**」。

**容器那一份在第七十九轮补上了**（v0.67.0）。落地的东西：`Dockerfile`（两个阶段，
构建阶段只装运行期依赖 + 单独装 esbuild —— 第一版把 `wrangler` 那约 100 MB 的 `workerd`
也拖了进来，首次构建十分钟没完）、`docker-compose.yml`（命名卷 + 可选 `READER_PORT` /
`ENABLE_FIXTURE`）、`.dockerignore`、以及单独的 `DOCKER.md`。

**验收标准达到了**：`docker compose up -d --build` 起得来、healthy，
自建那份冒烟指到容器**连跑两遍全绿**。冷构建 134 s / 重建 80 s / 镜像 249 MB；
非 root（uid 1000）；`docker stop` 0.33 s；重启容器后同一串签名代取地址仍然 200；
`tar` 整卷备份 → 恢复新卷 → 启动日志「本次新跑 0 个」。单测 1030 → 1041
（`test/docker.test.ts` 11 条防漂移断言）。

**没做的**：alpine 变体（没跑过就不写）、多架构（本机 x86_64）、反向代理与 HTTPS。

**顺带记下这条余量**：`build:node` 目前只打服务端 —— 前端仍是 `public/` 原样复制，
没有构建步骤（这一直是本项目的选择，不是欠账）。

**第八十轮又补了两样（v0.68.0）**：`SEARCH_ALL_SOURCES`（默认开：一次搜索把全部启用的
书源跑完，线上那份相反，写 `false` 回到「一页几个」）与详情页的**换源**。实测：干净的容器
实例（22 个内置源）一次全搜约 1 秒；924 个源那台 **184.5 秒**（多数是连不上的外部源，
它们的超时也要等完）—— 所以这条开关留着，不是「没得选」。

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
详见 EXPERIENCE.md「第七十二轮」。

---

## 7. ~~jsoup 的 `Attributes` 迭代~~ —— 第七十六轮已做，并挖出同一条链上更致命的一半

**做完了**（`Element.attributes()`）。落地的东西：

- 桥里的 `attributes` op：交出「键值对、**保持书写顺序**」的最小契约（宿主不该知道
  脚本会拿属性当什么用）
- 沙箱里的 `__attrList`：把键值对包成 jsoup 的 `Attribute`（`getKey()` / `getValue()` /
  `toString()` 给 `key="value"`），外加 `Attributes` 那三个集合级成员
  （`size()` / `hasKey(k)` / `get(i 或 键名)`）—— `Array.from` / 下标 / `length` 数组本来就有
- 靶子 `/fixture/attr-toc/:id` + 内置源 `builtin:fixture-attr-toc`：页面里**一半条目把书名放
  第 3 个属性、一半放第 4 个**（与 📂贝壳读书 的 `isBase64` 分支对应），冒烟 12g 三条断言

**顺带挖出来的那一半（比 `attributes()` 本身更要紧）**：做靶子时发现 📂贝壳读书 的目录
**仍然是 0 章**，真凶不在 `attributes()`，而在它外层那一句

```js
x = Array.from(java.getElements('class.BCsectionTwo-top-chapter'))
```

—— 沙箱里**根本没有 `Symbol.iterator`**，而 `Array.from` 对「既不可迭代、也没有 `length`」
的对象**不报错**，安静地给一个空数组：于是 `x` 是空的、目录 0 章、没有 warning、
书源也不报错。（第四十九轮修的是同一个坑的另一半：那时 `getElement("script")` 返回 `null`。）

补上 `JsoupElements.prototype[Symbol.iterator]` 之后，**同时**修好两条线上的源：

| 源         | 规则                                    | 修之前                     | 修之后                             |
| ---------- | --------------------------------------- | -------------------------- | ---------------------------------- |
| 📂贝壳读书 | `Array.from(java.getElements(…))`       | 0 章（静默）               | 能拿到「一串章节元素」             |
| 🎨51漫画   | `Array.from(java.getElement("script"))` | 落到兜底分支，只有**一章** | 从 script 里的 JSON 读出**真目录** |

🎨51漫画 那一条原来是**半好的**：不报错了（第四十九轮），但一直走兜底分支 ——
冒烟第 37 段原来那条断言写的就是「走兜底分支拿到那一章」。这一轮把它改成断言
**它本来要走的那一支**（真目录两章），另加一条只换过滤词的对照源守住兜底分支还在。

**还剩**（不再是「迭代」这一类）：`addClass` / `removeClass` / `append` / `prepend` /
`attr(k,v)` 仍是空操作 —— 语料里它们只当「顺手清理」，没有一条规则依赖改完之后再读回来，
所以继续按空操作处理（见下面第 12 条）。

---

## 8. ~~写在 `ruleSearch` 里的跨请求 `java.put`~~ —— 第七十六轮已做，第七十八轮把发现页也接上

**做完了**（按每条各自的 `bookUrl` 落库）。难点是搜索这一趟**没有「这本书」**，而
`java.put` 是在**每一条**的字段规则里写的（大半就写在 `ruleSearch.bookUrl` 上）——
所以只能「写的时候先收、这一条算完再按它自己的 bookUrl 落」：

- `RuleContext.itemVarSink`（`push` 收 / `flush(bookUrl)` 落）
- `booksFromItems` 每算完一条调一次 `flush`（放在 `finally`：这一条没算出来时，
  缓冲里那几个变量属于**一本没有身份的书**，只能丢掉 —— 留给下一条会把 A 书的 bid 挂到 B 书上）
- 走这条岔路时**不做**「一次请求只落一次」的去重：搜索里同一个键就是**逐条**写的
  （每条属于另一本书），去重会把第 2 条之后的全部丢掉
- 一个源一个 sink：搜索一页几十个源是并发的，共用缓冲会串源

**靶子** `builtin:fixture-search-var`：搜索里每条 put 一个**互不相同**的值（书地址最后一段），
详情里 `java.get` 读回来。冒烟 12h 断言**每一本读到的都是它自己那条写下的值** ——
这一条能同时区分三种实现：按条落（本轮的）、只落最后一次（两本都会是 `bid=2`）、
完全不落（两本都是 `bid=`）。实测两本分别是 `bid=1` / `bid=2`。

**按源账（第七十六轮重新数的，816 条）**：`ruleSearch` 里写了 `java.put` 的共 **9 条**，
其中「put 的键在**别的组**被读」的 7 条：

| 源           | put 在哪                                | 这一轮       |
| ------------ | --------------------------------------- | ------------ |
| 📂阿巴小说   | `ruleSearch.bookUrl`                    | **修好**     |
| ⚡📂飛天小說 | `ruleSearch.bookUrl`                    | **修好**     |
| 🔊潇社音乐   | `ruleSearch.lastChapter`                | **修好**     |
| 🏷七猫小说    | `ruleSearch.bookUrl`                    | **修好**     |
| 📂乐乎文章   | `ruleSearch.bookUrl` + `lastChapter`    | **修好**     |
| ⚡📂rezero   | `ruleSearch.bookList`（**列表规则**里） | 修不了，见下 |
| 🔞 Linpx     | `ruleSearch.bookList`（**列表规则**里） | 修不了，见下 |

（另外 📂豆花文学 的 put/get 都在同一组里，本来就走会话表；⚡📂丁丁小说 没有 get。）

**还剩**：

**第七十八轮把发现页那一趟接上了**（原来是「同一套写法，搜索能用、发现不能用」）：

- `exploreBooks` 补上 `infoVarCrossKeys: crossRequestInfoKeys(source, 'ruleExplore')`
- 落库通道由调用方注入 —— `/api/explore/books` 与首页推荐位各建一个 sink
  （`index.ts` 的 `itemVarSinkFor`，第七十六轮叫 `searchItemVarSink`，现在搜索与发现共用）；
  `home.ts` 的 `buildHomeSections` 多了一个可选的 `makeSink` 工厂（**一个源一个缓冲**）
- 靶子 `builtin:fixture-explore-var`（发现页每条 put 一个**互不相同**的值、详情里读回来），
  冒烟 12j 断言每一本读到的都是**它自己**那条写下的值

**实测（这份导出里 594 条带发现页的源，`live-explore-dump.json`）**：`ruleExplore` 里写
`java.put` 的共 4 条，其中 **3 条真的跨请求**（读端在别的组）：

| 源         | put 在哪                                       | 读端           | 这一轮   |
| ---------- | ---------------------------------------------- | -------------- | -------- |
| 📂阿巴小说 | `ruleExplore.bookUrl` → `bid`                  | `ruleBookInfo` | **修好** |
| 📂乐乎文章 | `ruleExplore.lastChapter` → `time`             | `ruleToc`      | **修好** |
| 📂小米书城 | `ruleExplore.kind` → `time`                    | `ruleBookInfo` | **修好** |
| 🏷七猫小说  | `ruleExplore.bookList` + `bookUrl` → `headers` | `ruleSearch`   | 见下     |

七猫那条的读端在**搜索**那一趟（不是取书链路），发现页写下的 `headers` 落不到搜索请求里；
而且它的 `bookList` 是列表脚本，与下面 rezero 同一个架构问题。

**还剩（现在只有一处了）**：

**写在整个 `bookList` 脚本里的 put**（⚡📂rezero）：那一段脚本**一次**产出整页条目，
写的时候无法归属到某一条 —— 要修得让「列表脚本」也能按条目分段，属于架构上的改动。
rezero 的 `is` 读端在 `ruleBookInfo`（真的跨请求），但它的语义本来就是「这次搜索匹配上没有」，
整页一个值 —— 先记着。

**顺手把一个「以为要做」的排除了**：🔞Linpx 的 `java.put('key')` / `java.get('key')`
**都在 `ruleSearch` 组里**，走会话表本来就读得到，根本不需要落库。第七十六轮把它列进
「剩 2 条源」是**数错了** —— 按「put 写在 bookList 里」这个形状数的，没看读端在哪一组。

---

## 9. ~~列表规则的 `<js>` 返回对象数组不被支持~~ —— 第七十四轮核实：**这条不是问题**

**当时（第七十三轮）的判断是错的**：以为「脚本 `return [{text, href}]` 会被逐项 `String()`
退化成 `[object Object]`」。第七十四轮做了一条调试副本直接看条目原文：

```
SRC={"text":"甲页","href":"/dbg-a"}
```

条目本来就是一段 JSON —— `sandboxResultToStrings` 是**逐项** JSON 化的（对象那一条走
`JSON.stringify`），`text` / `href` / `volume` 这些裸键名也一直读得出来（`bareJsonField` → `$.键`）。
线上 📂趣书小说（`+@js:` 返回 `[{text, href}]`）实测 **232 章**、本来就通。

🎨漫画搬运 的 0 章是**另一回事**：选择器那一段给的是**文本**、脚本却在找 `<h3` / `<ul`
（`String(块).includes('<h3')` 恒为 false → 空数组 → 0 章、不报错）。已经在第七十四轮修掉
（`usesJsoupOnResult` 补「在字符串里找标签」+ `Array.from(result)` 归一化，见 EXPERIENCE.md 第七十四轮），
实测 **462 章**。**这一条到此结束**，下面两条是那一轮真挖出来的剩余项。

---

## 10. ~~连接符 `&&` 与 `@js:` 尾段的配合~~ —— 第七十六轮核实：**这条不是卷标题退化的原因**

**当时（第七十四轮）的推断是错的**：以为「脚本只拿得到最后一段的结果，所以 🎨漫画搬运 的
`voList` 恒为空、卷标题退化成整块文本」。第七十六轮先按那条要求写了扫描
（`test/connectorJsTail.scan.test.ts`），再做了三组对照，结论是**改它没用、而且不安全**。

**一、扫描：这个形状一共 54 处**

```
书源 816 条 / 「连接符 + 最后一段带 JS」54 处
  按连接符：|| 28 / && 26
  按字段：ruleBookInfo.lastChapter 7 / ruleBookInfo.intro 6 / ruleToc.chapterList 5 /
          ruleContent.content 5 / ruleSearch.kind 4 / … （22 个字段）
  列表规则（result 是一批节点）6 处 / 字段规则 48 处
  脚本把 result 当**标量字符串**用 36 处 ← 改成合并必然出错的那一批
  脚本按**元素集合**用 result 7 处 ← 只有这一批可能受益
```

**36 处把 `result` 当标量字符串用**（`'更新时间：'+result`、`result.replace(/(.*)\s/,'$1 • ')`、
`result+'字'`、`"https://…/"+result`…）—— 这一批全都指望 `result` 里**只有最后那一段**。
把合并结果交给脚本，它们会立刻多接上前面几段的值（`更新时间：a,b`）。
受损面 36 处、可能受益面 7 处，而 54 处里 48 处是**字段规则**：**这个改法不成立。**

**二、三组对照：连接符跟那个卷标题一点关系都没有**

拿现成的 `fixtureMapTocPage`（两卷，每卷一个 `<h3>` + 一个 `<ul>`）跑 🎨漫画搬运 的脚本原文，
只把诊断写进章节名：

| 规则                                                            | 卷标题                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A `.map-block@js:…`（无连接符）                                 | `vo=2 ul=2 同名=true \| title=[卷一 起风<换行>第一章 起风了<换行>第二章 雨落下来]` |
| B `div && .map-block@js:…`（真源的形状）                        | 与 A **逐字相同**                                                                  |
| C `.map-block && .map-block@js:…`（模拟「把合并结果交给脚本」） | 与 A **逐字相同**                                                                  |

**真因是 `voList` 与 `ulList` 是同一批节点**（每个块里**既有** `<h3>` **又有** `<ul>`，
两个 `filter` 命中的是同一批），于是 `voList[index]` 是**整块**，
`java.getString("text", 整块)` 自然连章节名一起取出来。
这与连接符无关，也与本引擎无关 —— Legado 的 `AnalyzeRule.getString("text", element)`
给的同样是那一块的 `text()`。**是书源自己的写法取错了粒度**（该写 `h3@text`）。

**所以：这一条到此结束，引擎不改。** 靶子里那条内置源用的是精确写法
（`java.getString("h3@text", …)`，见 `fixtureMapTocSource` 的注释），
只保「块 → 标题」这条链的形状。

留下的正面产物是那个扫描（`connectorJsTail.scan.test.ts`）：它把「谁受损、谁受益」
变成了可数的两列，以后谁再想动连接符语义，先看这两列。

---

## 11. ~~桥的宿主调用开销：`__listOf` 每个元素三次往返~~ —— 第七十六轮已做

**做完了**：桥里多了一个 `list` op，宿主侧**一次**就把「每个元素的句柄 + 它自己的
`outerHTML`」算好交回去（开句柄是纯内存操作、取 HTML 是纯 cheerio 调用，都不需要过桥）。
`__listOf` 于是从 `1 + 2n` 次往返变成 **1 次**。

顺带修正了这条当初写的**受益面**：🎨漫画搬运 的目录**不在这条路上** —— 它那个
`Array.from(result)` 的 `result` 只有 **3 个** `.uk-switcher` 块（459 个章节条目是脚本自己
逐条 `Jsoup.parse` 出来的，不走 `__listOf`）。真正的大 n 出现在「一次 `select` 出几百个节点」
那种规则上（`jsoup.parse(整页).select(…)`、`java.getElements(…)`）。

**怎么量的**：新增 `scripts/probe-jsoup-trips.mjs`（临时导入一条源，`bookList` 是一次
`Jsoup.parse(整页).select('a')` + `map`，打内置测试站点的搜索页 `?n=600`，报节点数、
耗时中位与两种实现的往返次数）。同一份代码改成旧实现再跑一遍：

| 实现                                        | 604 个节点上的耗时中位           | 往返次数         |
| ------------------------------------------- | -------------------------------- | ---------------- |
| 旧（`size` + 每个元素 `get` + `outerHtml`） | **282ms**（256/269/282/298/452） | 1 + 2×604 = 1209 |
| 新（`list` 一次）                           | **223ms**（202/213/223/236/308） | 1                |

省掉的是 1208 次往返（总往返里的一半），耗时降 **约 21%**。剩下的两成半在
「每个节点两次 `text` / `attr`」上 —— 也就是下面第 13 条。

---

## 12. ~~jsoup 的写操作仍是空操作（`remove()` 之外的那几个）~~ —— 第七十八轮已做

**为什么当时留在那儿**：`remove()` 在第七十三轮已经做成**真删**（📂少年小说网 的目录靠它）。
剩下的 `addClass()` / `removeClass()` / `append()` / `prepend()` / `attr(k,v)` 一律返回 `null`。
当时的判断是「语料里它们只当顺手清理，**没有一条规则依赖改完再读回来**」—— 这句**只对了一半**。

**做完了**（v0.66.0）。真正的推手是 🎨笔趣漫画 的 `ruleContent.content`：

```js
imgs = java.getElements('.rd-article-wr img')
imgs.forEach((e) => {
    e.attr('src', e.attr('data-original'))
})
imgs
```

这条规则**整条都依赖写操作**，而且它同时踩中三处，缺哪一样都是「整章取不到」：

| 缺的东西                                       | 症状                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `attr(k, v)` 真改                              | 静默返回旧值 —— 不报错，图还是占位图                                  |
| 预取过的 HTML 缓存要失效                       | `String(e)` 吐的是**改之前**那份 HTML（第七十七轮刚加的那层缓存打架） |
| `java.getElements(...)` 的返回值得能 `forEach` | `TypeError: forEach is not a function`（裸 `JsoupElements` 没有它）   |

落地的东西：

- 桥的 `attr` / `text` / `html` 改成**按参数个数分派**读与写（jsoup 那边就是同名重载）；
  `addClass` / `removeClass` / `append` / `prepend` 真改；删掉纯死代码 `case 'attrSet'`
- `__wrapElement` 的预取缓存带上了 `invalidate()`：任何写操作落地就把这一格清空，
  之后的读一律过桥（读到的是改过的那份）。清的是**这个元素**的缓存
- **删掉了「裸 JsoupElements」那一份包装**：`java.getElements(...)` 改成与 `select()` /
  `Jsoup.parse()` 一样的**数组形态**（能下标、有 `length`、能 `forEach` / `map` / `Array.from`，
  集合级方法挂在数组上）。少一种形态、少一处漂移
- `java.getElement(...)` 给**含一个元素的数组形态**（与 `selectFirst` 同种东西）

**这里有一个差点写错的坑，如实记下**：删掉裸 `JsoupElements` 时，`getElement` 我第一版
写成返回「单个元素包装」（盒装字符串），结果是 🎨51漫画 那条规则**静默走错分支**：

```js
Array.from(java.getElement('script')).filter((e) => String(e).includes('目录'))
```

盒装字符串是 String 对象 —— `Array.from` 见到 `length` 就按**字符**摊开，于是 `scripts[0]`
是 undefined，整条目录落到兜底那一支（**只剩一章**）。不报错，只是书的内容变成一章。
是冒烟第 37 段（第七十六轮刚改强的那条断言）把它抓出来的 —— 那一轮的「先写断言、再动实现」
在这里救了第二次。

**靶子与断言**：

- `builtin:fixture-img-write`（新）+ `fixtureImgWriteChapterPage`（新）。真源的属性名是
  `data-original`，靶子**故意换成 `data-real-src`**（`mediaLinks.ts` 的优先表里没有这个名字）——
  用 `data-original` 的话，改不改 `src` 都能取到真地址，靶子就分辨不出「脚本到底改没改」。
  于是「这一章取不到图」**直接等价于**「写操作（或它的缓存失效）没生效」。冒烟 12i 断言
  三张图取到的是脚本写进 `src` 的真地址。
- `test/sandboxRun.test.ts` 加一个 describe（9 条）：写操作真改 + 缓存失效 + 数组形态 +
  `getElement` 的数组形态 + `Array.from(getElement('script'))` 不再按字符摊开 + 取不到给 null。

---

## 13. ~~桥的下一半：逐节点的 `text` / `attr` 各是一次往返~~ —— 第七十七轮已做

**做完了**：`list` op 一次多带两样**宿主侧本来就有**的东西 —— 整个属性表
（`node.attribs`，解析时就有，零成本）与「**叶节点**的文本」（没有元素子节点的节点，
文本就是几个直接文本子节点拼起来；整块容器留 `null`、按需那条路照旧过桥）。
沙箱侧把 `attr` / `hasAttr` / `className` / `id` / `val` / `text` 这六个方法指到
预取的那份数据上（`__wrapElement` 里一层**纯缓存**，与桥那份实现逐字对齐）。

**数字（1600 个 `<a>`，只跑沙箱那一层，7 次取中位）：**

| 变体                                    | 每节点过桥 | 总往返 | 中位      |
| --------------------------------------- | ---------- | ------ | --------- |
| A 只读预取过的字段（`text` + `attr`）   | 0          | 4      | **250ms** |
| B 半数过桥（`ownText` 替掉 `text`）     | 1          | 1604   | **294ms** |
| C 每节点两次过桥（`ownText` + `index`） | 2          | 3204   | **318ms** |

过一次桥约 **0.025ms**；预取本身的代价几乎为零（1600 个叶节点各算一次 `text()` 共
**1.4ms**，整个 `list` op 14.8ms）。常用的「逐节点读 href + 文本」在 1600 个节点上
少花约 **40ms（15%）** —— 净赚。

**当初写的验收标准没达到，这一条要如实记下**：「`probe-jsoup-trips.mjs` 报出的耗时在
604 个节点上再降一档」—— **做不到**。那个探针测的是**整条 HTTP 请求**（取页面 + 解析 +
建沙箱 + 序列化响应全算在内），604 个节点上过桥只占其中十几毫秒，而同一条规则连跑 7 次的
极差就有 100ms：**差值落在抖动里**。所以这一轮改成两个能用的判据：

1. 那时**把沙箱那一层拎出来直测**（上表），这是数字的来源；
2. `test/sandboxRun.test.ts` 用 `SandboxSession.jsoupCalls` 断言
   **过桥次数不随节点数增长**（5 个节点与 50 个节点都是 4 次；对照 `ownText` 每次正好多 n 次），
   再加一条「拿宿主桥对拍」的等价性断言。

探针那边也改成了**同一份代码的两个变体**（一个读预取过的字段、一个读没预取的），
并把「差值小于抖动的极差时别当结论」直接打进输出。

---

## 14. ~~沙箱在 vitest 里跑不起来~~ —— 第七十七轮已做

**做完了**。落地的东西：

- `vitest.config.ts`（新）：把 `../platform/wasm` 指到 `platform/wasm.node.ts` ——
  与 `scripts/build-node.mjs` 里那个替换插件同一件事。它**只影响 vitest**
- `platform/wasm.node.ts`：改成**按候选顺序找那个 wasm**（`QUICKJS_WASM` → 产物旁边的
  `quickjs.wasm` → 源码目录里的 `../engine/RELEASE_ASYNC.wasm`），与 `server/node.ts`
  的 `dirOf` 同一条思路 —— 写死一种路径，另一种跑法就报「找不到 wasm」
- `test/sandboxRun.test.ts`（新，11 条）：**真的**建 QuickJS、真的跑预置

**当初担心的「一刀切会拖慢全套」没发生**：实测读 1ms + 编译 1ms（V8 对 wasm 惰性编译），
90 个文件约 0.2 秒。所以不需要「只给某几个文件开」的复杂配置 ——
那条顾虑本来是这条待办一直没做的理由，现在有数字了。

**「钉住往返次数」是怎么做到的**：新增 `SandboxSession.jsoupCalls`（宿主侧记账，
`__host.jsoup` 每被调一次加一）。次数**可复现**，时间会抖 —— 于是断言写成
「**不随节点数增长**」（比「少于 N 次」结实：后者会被实现细节的微调弄红）
加上一条「拿宿主桥对拍」的等价性断言。

---

## 15. 没有任何自动化步骤真的渲染过阅读界面

**为什么记这一条**：第八十一轮改「‹ 返回」的兜底时，`reader.js` 里 `import { bookUrl }`
被同文件一个同名局部常量遮住了 —— 语法没问题、`tsc` 不管 `public/`、单测不 import 这个文件、
冒烟只打 HTTP。**四个步骤全绿，而阅读页整页报「bookUrl is not a function」**，
直到在浏览器里真点开才看见。

当时补了一条源码级断言（`test/moduleHygiene.test.mjs`：import 进来的名字不许被同文件的
`const/let/var` 遮住，零误报），但它只堵住**这一种**错。阅读界面里别的运行时错
（拿错字段、`undefined` 上取属性、某个 helper 改名没跟上）一样是「谁也没自动化地打开过它」。

**要做到什么程度**：给「渲染一遍阅读界面」加一步自动化 —— 最小可行的是拿一份 DOM 替身
（`test/dom.test.mjs` 里已经有一个）把 `viewRead` 跑起来，断言它不抛、且顶栏那几颗按钮都在；
更彻底的是在冒烟里加一段无头浏览器（现在 `scripts/smoke.mjs` 只有 HTTP）。

**怎么算做完**：`npm test` 或 `npm run smoke` 里有一条会在阅读界面渲染出错时变红，
并且**先有人故意把 import 遮住一次**、确认它真的变红（不然就是又一条绿灯装饰）。

---

## 16. 底部导航栏的标签之间按返回要一格格退

**第八十一轮留下的**：这一轮把「同一页换内容」的跳转都改成了不压历史（换章、登录、
换源、发现页换源），但**底部/顶部导航栏的四个标签之间**仍是压历史 —— 依次点
首页 → 书架 → 发现 → 搜索，要按四次返回才出得去。

**为什么没一起改**：那是另一种取舍，App 界里两种做法都常见（「标签也进历史」与
「标签不进历史」）；而且阅读界面里导航栏本来就是收起来的，用户报的那条已经修掉。

**要定的是**：想让返回键「一次出应用」还是「一格格退标签」。定了再改，改的是
`public/app.js` 里 `renderTabs` 的两处 `go(#/${tab.route})`。

---

## 17. Pages 那份的两点余量（覆盖开关不在仓库里、没绑域名）

**现状**（第八十二轮）：页面部署在 `reader-cloudflare.pages.dev`，接口部署在 Worker；
Pages 侧的 `API_ORIGIN`（改接口地址用的那个覆盖开关）只能在 Dashboard 里设 ——
仓库里没有 Pages 的配置文件。

**要做**：① 想让那个开关跟着代码走，就得单独开一份带 `pages_build_output_dir` 的配置
（注意别和 `wrangler.jsonc` 混用：那个是接口那一份的 Workers 配置，`wrangler pages deploy`
在它缺 `pages_build_output_dir` 时只警告一句、然后忽略它）；② 想绑自定义域名，在 Dashboard
里加一条即可（账号里另外两个 Pages 项目绑的是 `hashiqi12138.ccwu.cc`）。

**怎么算做完**：改 `wrangler.jsonc` 里的 Worker 名字之后，`npm run deploy:page` 发出去的
那一份仍然指向新名字（现在得手动改 `public/_worker.js` 的默认值，或者去 Dashboard 改环境变量）。

---
