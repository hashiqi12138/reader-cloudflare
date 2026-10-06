# Docker 部署

这份文档只讲容器这一条路：把项目跑在你自己机器的 Docker 里，不经过 Cloudflare。
它是 EXPERIENCE.md「自建：跑在自己的一台机器上」那一节的容器化版本，两者用的是同一个入口
（`src/server/node.ts`），区别只在「谁把进程拉起来」。

选它的理由通常只有一个：**Workers 免费计划每个请求只有 10 毫秒 CPU**，重一点的目录规则
会被平台掐成 503（见 `TODO.md` 第 1 条）；自建这份没有那个上限。自建也可以不用 Docker
（`npm run start:node`），容器多给的是「依赖、Node 版本、数据目录都封在一个镜像里」。

## 前提

Docker（本机 29.7.2 实测）。**不需要**在宿主机装 Node，也不需要 Cloudflare 账号。
Dockerfile 里的基础镜像是 `node:22-slim`，Node 那一半由镜像自带。

## 起起来

### 用 compose

```powershell
docker compose up -d --build
```

打开 `http://127.0.0.1:8787`。第一次进来是**空的**，这是对的 —— 本项目不分发书源，
要去「书源」页导入一份 Legado 书源 JSON 才有东西可搜。

### 用 docker run

与上面等价，只是把 compose 文件里那几行敲在命令行上：

```powershell
docker build -t reader-cloudflare .
docker run -d --name reader -p 8787:8787 -v reader-data:/data --restart unless-stopped reader-cloudflare
```

三种起法（compose / `docker run` / `npm run start:node`）的差别只是「怎么把同一个进程拉起来」，
运行起来的东西是一样的。

### 换个宿主机端口

8787 很可能是被先占着的（本项目的 `npm run dev` 自己就常驻这个端口）。宿主机那一侧随便换，
容器里那个 8787 不用动：

```powershell
$env:READER_PORT='9000'; docker compose up -d      # PowerShell
READER_PORT=9000 docker compose up -d              # bash
```

**端口被占时的表现不一定是启动报错。** 在 Windows + Docker Desktop 上实测过一次：
容器起来了、也 healthy，但从宿主机 `127.0.0.1:8787` 打过去是「连得上、不回应」——
上一次 `npm run dev` 留下的 `workerd` 还占着 IPv4 loopback，把容器的转发挡在后面。
查一遍谁占着：

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object LocalAddress, OwningProcess
```

## 数据放在哪

容器里是 `/data/reader.sqlite`（SQLite，跑在 WAL 下，所以旁边还有 `-wal` 与 `-shm`）。
这一个文件装的是这台实例的**全部状态**：

- 书源，以及账号与会话
- 书架、阅读进度、书签、笔记
- 首页推荐位的缓存
- 给媒体代取地址**签名用的密钥**（存在库里，不是环境变量）

媒体缓存**不在**里面：它是进程内的内存表，重启就没了（与 Cloudflare 那份按机房缓存同一层定位，
只是不跨重启）。

上面两条命令都挂了命名卷 `reader-data`。**不挂卷**的后果不只是数据没了 —— 签名密钥会重新生成，
之前发出去的代取地址（含浏览器里缓存着的那些封面）会全部变成 403。

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

| 变量                 | 默认                         | 说明                                                                       |
| -------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `PORT`               | `8787`                       | 容器内监听端口。换它的话 `-p` 右边也要跟着改                               |
| `DB_PATH`            | `/data/reader.sqlite`        | 库的位置。除非你想把库放到别处，不用动                                     |
| `SEARCH_ALL_SOURCES` | `true`                       | 一次搜索覆盖**全部**启用的书源（见下）。与线上那份默认值相反               |
| `ENABLE_FIXTURE`     | `false`                      | 内置测试书源（十几条指向本进程自己的 fixture）。只有对容器跑冒烟才需要打开 |
| `ENGINE_VERSION`     | 构建时 `package.json` 的版本 | 覆盖它会让「关于」页与更新记录对不上，没必要                               |
| `PUBLIC_ROOT`        | 自动找                       | 前端资源目录。镜像里已经放对，不用动                                       |
| `MIGRATIONS_DIR`     | 自动找                       | 迁移目录。同上                                                             |
| `QUICKJS_WASM`       | 自动找                       | 引擎用的 QuickJS 二进制。同上                                              |

**要打开 `ENABLE_FIXTURE` 只用一行**（它对容器跑一遍冒烟时用）：

```powershell
$env:ENABLE_FIXTURE='true'; docker compose up -d
```

### 一次搜索搜多少个书源

线上那份**必须**一个一个来：Cloudflare 免费计划给每个请求 10 毫秒 CPU，
一次把几百个源的规则求值跑完必然被掐成 503（详见 EXPERIENCE.md 里那一轮）。
容器这份没有这个上限，所以默认反过来 —— 搜索页不挑源时，**一个请求把全部启用的书源跑一遍**，
界面上也就没有「继续加载」那一堆按钮。

代价是**这个请求会久一些**：耗时大致与书源条数成正比（实测 22 个内置源不到一秒；
924 个源那台 **184.5 秒** —— 其中大多数是连不上的外部源，它们的超时也要等完）。
书源很多又只想快点出结果时，两条路：

```powershell
# 回到「一页几个」的老样子（线上那份的行为）
$env:SEARCH_ALL_SOURCES='false'; docker compose up -d
```

或者在搜索页用「选择书源」挑几个源 —— 挑了源就只搜挑中的那些，与这条开关无关。

## 升级

```powershell
git pull
docker compose up -d --build
```

迁移在容器启动时自动跑，而且是幂等的：库里有一张自己的 `_migrations` 表记着跑过哪些文件，
第二次启动的日志是 `迁移：15 个文件，本次新跑 0 个`。数据在卷里，重建容器不影响它。

## 看状态与排障

- `docker compose ps` —— 状态里那个 healthy 是容器自己的健康检查，每 30 秒打一次 `/api/version`
- `docker compose logs -f`
- 起不来时先打 `/api/probe`：它一次回答三件事 —— cheerio 能不能解析 HTML、QuickJS 的 wasm
  能不能加载、库连上没有。比翻日志快
- 每次启动都会有一行 `ExperimentalWarning: SQLite is an experimental feature`。这是 Node
  对内置 `node:sqlite` 的提示，不是错误，不影响功能（`npm run start:node` 同样会打）

## 与 Cloudflare 那份的差异

- 缓存是**进程内的内存表**（上限 64 MB，超了按插入顺序丢最老的），重启即清空
- `waitUntil` 的语义改成了「发响应之前等它落地」（Workers 那边是响应之后接着跑）。
  本机没有「请求结束就掐掉 Promise」的问题，等它落地让「缓存写好了」对下一个请求是确定的
- 没有每请求的 CPU 上限 —— 这正是走这条路的目的
- **只支持单副本。** 库是本机文件，同时起两个容器就是两份互不相干的数据
- HTTPS 要自己加反向代理。有一处要留意：会话 cookie 的 `Secure` 标志是按**服务端看到的协议**
  加的，而这一层构造请求时用的是 `http` —— 所以放在 TLS 反代后面时 cookie 不带 `Secure`。
  单机自用无碍，直接暴露到公网则不然

## 实测记录

下面这些是 2026-10-05 在 Windows + Docker Desktop（WSL2 后端，Docker 29.7.2）上真跑过的：

| 项                                    | 结果                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------- |
| 冷构建（`docker build --no-cache`）   | 134 s                                                                      |
| 改代码后重建（层缓存命中依赖）        | 80 s                                                                       |
| 镜像大小                              | 249 MB（`node:22-slim` 基础镜像占大头）                                    |
| 两条起法                              | compose 默认 8787、`docker run` 换端口，都验过                             |
| 自建那份冒烟（`SMOKE_BASE` 指到容器） | **连跑两遍全绿**：11 个书源对照 + 书源管理 + 登录态 + 媒体缓存与签名 + PWA |
| 运行身份                              | `uid=1000(node)`，`/data` 属主也是它                                       |
| `docker stop`                         | 0.33 s（SIGTERM 被接住，不是等超时被 KILL）                                |
| 数据持久化                            | 重启容器后，同一串签名代取地址仍然 200                                     |
| 备份 → 恢复到新卷 → 启动              | 日志为「本次新跑 0 个」，`/api/version` 200                                |
| `/` 与一个不存在的路径                | 都是 200 `text/html`（单页应用回退）                                       |

## 没做的

- **alpine 变体没试。** `node:sqlite` 是 Node 自带的，musl 理论上没问题，但没跑过就不写。
  换 alpine 镜像应该能小一截
- **只按当前机器架构构建。** 本机是 x86_64。要在 arm64 上跑（树莓派、Apple 芯片），
  就在那台机器上 `docker build`，或者用 `docker buildx` 交叉构建
- 反向代理、HTTPS、多副本都没做，取舍见上一节
