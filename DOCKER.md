# Docker 部署

这份文档只讲容器这一条路：把项目跑在你自己机器的 Docker 里，不经过 Cloudflare。
它是 EXPERIENCE.md「自建：跑在自己的一台机器上」那一节的容器化版本，两者用的是同一个入口
（`src/server/node.ts`），区别只在「谁把进程拉起来」。

**它是两个容器，各管一件事**（与 Cloudflare 上「页面发 Pages、接口发 Worker」同一个分工）：

| 服务   | 里面是什么                                                               | 对外                |
| ------ | ------------------------------------------------------------------------ | ------------------- |
| `page` | nginx + `public/` 里的静态资源，并把 `/api/*` 与 `/fixture/*` 转给 `api` | 发端口              |
| `api`  | `src/index.ts` + 本机 SQLite（`SERVE_STATIC=false`，不发页面）           | 只在 compose 内网里 |

浏览器从头到尾只看到 `page` 那一个源 —— 所以会话 cookie 仍是第一方、前端里那些相对地址
（`/api/...`、`/api/media/<签名>`）一个都不用改。

选它的理由通常只有一个：**Workers 免费计划每个请求只有 10 毫秒 CPU**，重一点的目录规则
会被平台掐成 503（见 `TODO.md` 第 1 条）；自建这份没有那个上限。自建也可以不用 Docker
（`npm run start:node`，那一个进程同时发页面与接口），容器多给的是「依赖、Node 版本、
数据目录都封在镜像里」。

## 前提

Docker（本机 29.7.2 实测）。**不需要**在宿主机装 Node，也不需要 Cloudflare 账号 ——
接口那一份的基础镜像是 `node:22-slim`，页面那一份是 `nginx:alpine`，两边都自带运行时。

## 起起来

### 用 compose（推荐）

```powershell
docker compose up -d --build
```

`page` 会**等 `api` 健康了再起**（`depends_on: service_healthy`），所以第一次跑要等半分钟左右
才两个都 healthy；这样浏览器一打开就是好的，不会先看到几秒的 502。

```powershell
docker compose ps                     # 两个都 healthy 再看
docker compose logs -f                # 想盯着启动过程
```

打开 `http://127.0.0.1:8787`。第一次进来是**空的**，这是对的 —— 本项目不分发书源，
要去「书源」页导入一份 Legado 书源 JSON 才有东西可搜。

### 用 docker run

与上面等价，只是把 compose 文件里那几行敲在命令行上 —— 两个容器 + 一张自建网络：

```powershell
docker network create reader-net
docker build -t reader-cloudflare .
docker build -t reader-cloudflare-page -f Dockerfile.page .

docker run -d --name reader-api --network reader-net --network-alias api -e SERVE_STATIC=false `
  -v reader-data:/data --restart unless-stopped reader-cloudflare
docker run -d --name reader-page --network reader-net -p 8787:80 `
  --restart unless-stopped reader-cloudflare-page
```

**那个 `--network-alias api` 不能省。** 页面那一份的 nginx 是按 `api` 这个名字找接口的，
少了它 nginx 会**直接起不来**（`host not found in upstream "api"`，容器退成 `Exited (1)`）——
实测把接口那个容器命名成别的名字时就是这样。这是**故意**让它硬失败：比默默 502 好查。

这条路**没有** compose 那个「等健康再起」的保证：`reader-page` 一起来就打得到静态资源，
但头十几秒（`reader-api` 还在跑迁移）打 `/api/*` 会拿到 502。等一下就好，或者先看清楚：

```powershell
docker logs -f reader-api             # 看到那一行「自建模式：http://127.0.0.1:8787」就绪了
```

（这里的卷名就是 `reader-data` 本身；compose 那条路给的卷名带项目前缀，见「数据放在哪」。）

### 换个宿主机端口

8787 很可能是被先占着的（本项目的 `npm run dev` 自己就常驻这个端口）。宿主机那一侧随便换，
容器里那个 80 不用动：

```powershell
$env:READER_PORT='9000'; docker compose up -d      # PowerShell
READER_PORT=9000 docker compose up -d              # bash
```

**端口被占时的表现不一定是启动报错，而且这一个坑第一次拆两个容器时踩到了**：compose 建
`page` 容器时 `Bind for 0.0.0.0:8787 failed: port is already allocated`，容器留在
`Created`／半起状态；等你把占用者清掉再 `docker compose up -d`，它**复用**那个容器，
于是端口没真正接上（`docker ps` 里只有 `80/tcp`，宿主机打不通）。这时要重建它：

```powershell
docker compose up -d --force-recreate page
```

在 Windows + Docker Desktop 上还实测过一次更绕的：容器起来了、也 healthy，但从宿主机
`127.0.0.1:8787` 打过去是「连得上、不回应」—— 上一次 `npm run dev` 留下的 `workerd`
还占着 IPv4 loopback，把容器的转发挡在后面。查一遍谁占着：

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object LocalAddress, OwningProcess
```

## 那层反代做对了什么

`page.nginx.conf` 里除了「转两个前缀」，还有**三个数字**是踩出来的（不设就会在具体场景下坏掉，
所以每一条都在文件里写了理由）：

| 设置                               | 不设会怎样                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy_read_timeout 600s`          | 接口那一侧默认**一次搜索跑完全部启用的书源**，实测 924 个源要 **184.5 秒**；nginx 默认 60 秒就断 —— 表现是「搜索转一会儿弹 504」，而接口本身是好的 |
| `client_max_body_size 64m`         | nginx 默认上限 **1 MB**，而导入书源那一份语料是 800 多条、约 4.5 MB —— 不改的话导入直接 413，接口那边根本收不到                                    |
| `proxy_set_header Host $http_host` | 接口那一侧是**用 Host 推出请求源**的：夹具书源拼出来的地址、以及会话 cookie 的 `Secure` 判断都跟着它，少了这行两处会一起错                         |

`64m` 只是个安全阀：应用自己还有更小的限制（导入请求体 4 MB、单条书源 256 KB、一次最多 1000 条），
超了会回**说得清的** 413（`{"error":"请求体 2 MB，超过上限 4 MB"}`），而不是 nginx 那种空白错误页。

**上游是「按请求解析」的，不是启动时记死一个 IP。** 配置文件里那句
`set $api_upstream http://api:8787; proxy_pass $api_upstream;`（而不是直接写
`proxy_pass http://api:8787`）就是为了这个：直写的话 nginx 在**启动时**解析一次上游名、
之后一直用那个 IP —— 哪天 api 容器重建换了个地址，页面就一直在打旧地址（全站接口 502），
除非有人记得把 page 也重启一遍。变量 + `resolver 127.0.0.11 valid=10s`（Docker 的内嵌 DNS）
才会按这个有效期重新解析。

顺带一条**故意保留的硬失败**：上游名解析不出来时 nginx 根本起不来
（`host not found in upstream "api"`，容器直接 `Exited (1)`）。这是好事 ——
比「起来了但每个接口都 502」好查得多。

## 数据放在哪

容器里是 `/data/reader.sqlite`（SQLite，跑在 WAL 下，所以旁边还有 `-wal` 与 `-shm`）。
这一个文件装的是这台实例的**全部状态**：

- 书源，以及账号与会话
- 书架、阅读进度、书签、笔记
- 首页推荐位的缓存
- 给媒体代取地址**签名用的密钥**（存在库里，不是环境变量）

媒体缓存**不在**里面：它是进程内的内存表，重启就没了（与 Cloudflare 那份按机房缓存同一层定位，
只是不跨重启）。

卷 `reader-data` **只挂在 `api` 那一份上**，页面容器是无状态的（删掉重建随时可以）。
**不挂卷**的后果不只是数据没了 —— 签名密钥会重新生成，之前发出去的代取地址（含浏览器里
缓存着的那些封面）会全部变成 403。

卷的实际名字带一层 compose 项目名，是**目录名**加后缀（在 `reader-cloudflare/` 下就是
`reader-cloudflare_reader-data`）。拿不准就 `docker volume ls | findstr reader`。

### 备份

先停容器再打包，取到的是一份一致的 SQLite（连 WAL 一起）：

```powershell
docker compose stop
docker run --rm -v reader-cloudflare_reader-data:/data -v "${PWD}:/backup" alpine `
  tar czf /backup/reader-data.tar.gz -C /data .
docker compose start
```

实测产物 104 KB（一个刚跑完冒烟的库）。恢复就是把它解回一个卷，再让容器指过去：

```powershell
docker volume create reader-data-restored
docker run --rm -v reader-data-restored:/data -v "${PWD}:/backup" alpine `
  tar xzf /backup/reader-data.tar.gz -C /data
```

（我实测时容器是运行着的，包里的三个文件正好是一致的；但**停掉再打包更稳**，上面的命令按停掉写。）

应用自己的「导出」不是这个包：它只有书架 / 进度 / 书签 / 笔记（可读 JSON），
**不含**书源、账号与那个密钥，是给「换个实例接着读」用的。整机搬家请用上面这份。

## 可配的环境变量

**三个开工开关都属于 `api` 那一份**（`page` 只发文件与转发，没有引擎可开关）：

| 变量                 | 默认                           | 属于 | 说明                                                                                   |
| -------------------- | ------------------------------ | ---- | -------------------------------------------------------------------------------------- |
| `PORT`               | `8787`                         | api  | 容器内监听端口。**别改** —— `page.nginx.conf` 里的 `proxy_pass` 写的就是它             |
| `DB_PATH`            | `/data/reader.sqlite`          | api  | 库的位置。除非你想把库放到别处，不用动                                                 |
| `SEARCH_ALL_SOURCES` | `true`                         | api  | 一次搜索覆盖**全部**启用的书源（见下）。与线上那份默认值相反                           |
| `ENABLE_FIXTURE`     | `false`                        | api  | 内置测试书源（十几条指向本进程自己的 fixture）。只有对容器跑冒烟才需要打开             |
| `SERVE_STATIC`       | `true`（compose 里设 `false`） | api  | 这个进程要不要发页面。compose 里由 `page` 那一份发，所以关掉；只起这一个容器时打开即可 |
| `ENGINE_VERSION`     | 构建时 `package.json` 的版本   | api  | 覆盖它会让「关于」页与更新记录对不上，没必要                                           |
| `PUBLIC_ROOT`        | 自动找                         | api  | 前端资源目录（`SERVE_STATIC=true` 时才有用）                                           |
| `MIGRATIONS_DIR`     | 自动找                         | api  | 迁移目录。同上                                                                         |
| `QUICKJS_WASM`       | 自动找                         | api  | 引擎用的 QuickJS 二进制。同上                                                          |

**要打开 `ENABLE_FIXTURE` 只用一行**（它对容器跑一遍冒烟时用）：

```powershell
$env:ENABLE_FIXTURE='true'; docker compose up -d --force-recreate api
```

**那个 `--force-recreate api` 不是多余的**：compose 看见容器已经存在就**复用**它，
`docker compose up -d` 不会把新的环境变量灌进去。实测踩过 —— 少了它，
`docker compose exec api printenv ENABLE_FIXTURE` 里还是 `false`，而界面上是
「内置测试书源一条都没有」，看起来像书源没导进去。所有「改环境变量」的用法都同理。

### 一次搜索搜多少个书源

线上那份**必须**一个一个来：Cloudflare 免费计划给每个请求 10 毫秒 CPU，
一次把几百个源的规则求值跑完必然被掐成 503（详见 EXPERIENCE.md 里那一轮）。
容器这份没有这个上限，所以默认反过来 —— 搜索页不挑源时，**一个请求把全部启用的书源跑一遍**，
界面上也就没有「继续加载」那一堆按钮。

代价是**这个请求会久一些**：耗时大致与书源条数成正比（实测 22 个内置源不到一秒；
924 个源那台 **184.5 秒** —— 其中大多数是连不上的外部源，它们的超时也要等完）。
前面那层 nginx 为此把 `proxy_read_timeout` 放到了 600 秒（见「那层反代做对了什么」）。
书源很多又只想快点出结果时，两条路：

```powershell
# 回到「一页几个」的老样子（线上那份的行为）
$env:SEARCH_ALL_SOURCES='false'; docker compose up -d --force-recreate api
```

或者在搜索页用「选择书源」挑几个源 —— 挑了源就只搜挑中的那些，与这条开关无关。

## 升级

```powershell
git pull
docker compose up -d --build
```

迁移在接口容器启动时自动跑，而且是幂等的：库里有一张自己的 `_migrations` 表记着跑过哪些文件，
第二次启动的日志是 `迁移：15 个文件，本次新跑 0 个`。数据在卷里，重建容器不影响它。

## 看状态与排障

- `docker compose ps` —— 两个服务；`api` 那个 healthy 是它自己的健康检查，每 30 秒打一次 `/api/version`
- `docker compose logs -f api` / `docker compose logs -f page` —— 分开看。**接口那一侧的启动日志里
  会写明它在不在发页面**（`静态资源 不发（SERVE_STATIC=false，页面由另一份发）`），一眼能确认分工对不对
- 起不来时先打 `/api/probe`（从**页面**那个端口打）：它一次回答三件事 —— cheerio 能不能解析 HTML、
  QuickJS 的 wasm 能不能加载、库连上没有。比翻日志快
- 每次启动都会有一行 `ExperimentalWarning: SQLite is an experimental feature`。这是 Node
  对内置 `node:sqlite` 的提示，不是错误，不影响功能（`npm run start:node` 同样会打）
- 想绕过页面那层直接调接口，把 `api` 的端口临时发出来即可（`docker compose run --rm -p 8787:8787 api`
  或者自己在 compose 里加一行 `ports`）—— 平时**不要**这么做：那样就有两个源了，会话与媒体地址
  都会被绕过去

## 与 Cloudflare 那份的差异

- **同样是「页面」与「接口」两份**，只是这边两份都在你自己的机器上：Cloudflare 用 Pages + Worker，
  这里用 nginx + node。分工、以及为什么都要一层同源反代，是同一套理由
- 缓存是**进程内的内存表**（上限 64 MB，超了按插入顺序丢最老的），重启即清空
- `waitUntil` 的语义改成了「发响应之前等它落地」（Workers 那边是响应之后接着跑）。
  本机没有「请求结束就掐掉 Promise」的问题，等它落地让「缓存写好了」对下一个请求是确定的
- 没有每请求的 CPU 上限 —— 这正是走这条路的目的
- **只支持单副本。** 库是本机文件，同时起两个 `api` 容器就是两份互不相干的数据
  （`page` 那份无状态，多起没有意义，但也不会坏）
- HTTPS 要自己加反向代理。有一处要留意：会话 cookie 的 `Secure` 标志是按**服务端看到的协议**
  加的，而这一层构造请求时用的是 `http` —— 所以放在 TLS 反代后面时 cookie 不带 `Secure`。
  单机自用无碍，直接暴露到公网则不然

## 实测记录

2026-10-05 的那批（冷构建 134 s / 重建 80 s / 接口镜像 249 MB / `docker stop` 0.33 s /
备份恢复）是**单容器**时的数，现在仍然成立 —— 接口那一份的镜像与起法没变。
下面是 2026-10-06 拆成两个容器之后补的：

| 项                                            | 结果                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 页面那一份的镜像                              | **63.3 MB**（`nginx:alpine` + `public/`）；接口那一份仍是 249 MB                                                     |
| `docker compose up -d --build`（两个服务）    | `api` 先 healthy，`page` 等它健康后再起；`docker compose ps` 两个都 Up                                               |
| 端口归属                                      | 只有 `page` 发端口（`0.0.0.0:8787->80/tcp`）；`api` 只有 `8787/tcp`（内网）                                          |
| 接口那一侧确实不发页面                        | 启动日志：`静态资源 不发（SERVE_STATIC=false，页面由另一份发）`                                                      |
| 经 nginx 取接口                               | `/api/version` → 200（返回接口那一份的版本号）                                                                       |
| 经 nginx 的静态资源                           | `/`、`/app.js`、`/js/*`、`/style.css`、`/sw.js`、`/manifest.json`、图标全 200，类型都对；不存在的路径回 `index.html` |
| 经 nginx 的会话                               | `POST /api/auth/register` → 201，`Set-Cookie` 逐字透传                                                               |
| 大请求体经 nginx（1.96 MB）                   | 200 —— 到了应用那一侧，按它自己的规则逐条回绝（**默认 1 MB 上限下这一步会 413**）                                    |
| 自建那份冒烟（`SMOKE_BASE` 指到**页面**端口） | 全绿：11 个书源对照 + 书源管理 + 登录态 + 媒体缓存与签名 + PWA（含一次 3 分钟量级的全量搜索，没被 nginx 断掉）       |
| 踩到的坑                                      | 端口被占时 `page` 容器会留在半起状态，清掉占用者后要 `--force-recreate`，否则端口接不上（见「换个宿主机端口」）      |

## 没做的

- **接口那一份没换 alpine。** `node:sqlite` 是 Node 自带的，musl 理论上没问题，但没跑过就不写。
  页面那一份本来就是 `nginx:alpine`（镜像 63 MB）
- **只按当前机器架构构建。** 本机是 x86_64。要在 arm64 上跑（树莓派、Apple 芯片），
  就在那台机器上 `docker build`，或者用 `docker buildx` 交叉构建
- 反向代理、HTTPS、多副本都没做，取舍见上一节
