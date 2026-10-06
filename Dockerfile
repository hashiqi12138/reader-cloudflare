# 自建模式（Node）的容器镜像 —— 「接口」那一份（页面那一份是 `Dockerfile.page`）。
#
# 用法与参数见仓库根目录的 DOCKER.md；这里只留四件在文件里看得见的事：
#
#   1. **两个阶段**。构建阶段要打包器（esbuild），运行阶段只要那四个运行期依赖
#      （cheerio / hono / quickjs-emscripten / xpath）。单阶段 + `npm prune` 看着更短，
#      但镜像体积不会因此变小 —— 被删掉的文件仍然留在前面那些层里。
#   2. **构建阶段不装 devDependencies**。里面最大的一块是 wrangler（拖一个约 100 MB 的
#      workerd 运行时），容器里一行都用不到，装上只是让首次构建多等好几分钟。
#      打包器因此单独装（见下面那一步），版本从 package.json 读。
#   3. **基线是 node:22-slim，不是 alpine**。`node:sqlite` 是 Node 自带的（不需要任何原生
#      依赖，所以 musl 理论上也行），但这一条**没有实测过**，而 slim 是官方 Node 镜像里最
#      接近「本机 `node dist-node/server.mjs`」的那一种 —— 文档里写的必须是我真跑过的。
#   4. **不以 root 跑**。基础镜像里本来就有 uid 1000 的 `node` 用户；`/data` 先建好并改成
#      它的，于是**命名卷第一次创建**时会带着这个属主（见 DOCKER.md 的「数据放在哪」）。
#
# 这个镜像里同时有 `dist-node/public/`（打包时一起产出的），但 compose 里那个 api 服务
# 用 `SERVE_STATIC=false` 把它关掉了 —— 页面归另一份发。想只跑这一个容器（浏览器直接打它）
# 就把那个开关去掉，默认是发的。

# ---------- 构建阶段 ----------
FROM node:22-slim AS build

WORKDIR /app

# 先只拷清单与 scripts 再装依赖，让这一层能吃到缓存（改源码不会重装依赖）。
#
# 三件事的顺序不能换：
#   - `scripts/` 要在 `npm ci` **之前**到位 —— 装完会跑 prepare 钩子
#     （scripts/copy-quickjs-wasm.mjs），它从 node_modules 把 QuickJS 的 wasm 复制到
#     src/engine/。那份二进制不进仓库（见 .gitignore），只能在这一步生成。
#   - `src/engine/` 也先建出来，否则那个 copy 会因为目录不存在直接报 ENOENT。
#   - 所以 `.dockerignore` 里**排除**了 src/engine/*.wasm：镜像里那份必须与装上的
#     quickjs-emscripten 版本一致，而这件事只有 prepare 钩子保证得了。
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN mkdir -p src/engine && npm ci --omit=dev

# 打包器是 devDependency，上面那步装不到它。按 package.json 里钉的版本装进一个临时目录，
# 再把那两个包（esbuild 本体 + 它的平台二进制）搬进 node_modules —— 一共约 10 MB。
# 版本从 package.json 读而不是在这里写死：写死就会与仓库漂开，且 npm ci 不会发现。
RUN ESBUILD="$(node -p "require('./package.json').devDependencies.esbuild.replace(/^[^0-9]*/,'')")" \
    && npm install --prefix /tools --no-save --ignore-scripts "esbuild@${ESBUILD}" \
    && cp -r /tools/node_modules/esbuild /app/node_modules/ \
    && cp -r /tools/node_modules/@esbuild /app/node_modules/ \
    && rm -rf /tools

COPY . .

# 产出 dist-node/：server.mjs + quickjs.wasm + migrations/ + public/
RUN npm run build:node

# ---------- 运行阶段 ----------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# 只要运行期依赖。`--ignore-scripts` 是必须的：prepare 钩子要 scripts/ 目录，
# 而这一阶段没有（也不需要）它 —— 不跳过就会在 `npm ci` 那一步报找不到文件。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist-node ./dist-node

# 监听端口与数据库位置。DB_PATH 落到 /data 是为了让它挂得住卷（见 DOCKER.md）
ENV PORT=8787
ENV DB_PATH=/data/reader.sqlite
# 内置测试站点（那十几条 fixture 书源）默认关掉，与 wrangler.jsonc 线上那份一致
ENV ENABLE_FIXTURE=false
# 这个进程要不要发页面。默认发（单容器 / `npm run start:node` 都靠它）；
# compose 里的 api 服务改成 false —— 页面由 page 那一份的 nginx 发（见 DOCKER.md）
ENV SERVE_STATIC=true

# /data 的属主要在建镜像时就定好：命名卷第一次创建时**复制**镜像里那个目录的属主，
# 之后再改这里就没用了（老卷已经存在，不会被重新初始化）。
RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 8787
VOLUME ["/data"]

# 探活打 /api/version：它不碰数据库也不碰网，进程起来了就一定答得上。
# 换成 / 或 /api/sources 会掺进静态资源与库的状态，「活没活」这件事就说不清了。
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# exec 形式，node 就是 PID 1 —— src/server/node.ts 里那对 SIGTERM/SIGINT 处理器
# 能直接收到 `docker stop` 的信号，关库、退出。
CMD ["node", "dist-node/server.mjs"]
