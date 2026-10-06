/*
 * 容器那份（`Dockerfile` / `docker-compose.yml` / `DOCKER.md`）的防漂移测试
 *
 * 为什么不只在真机上跑一遍就算完：容器这条路上的错**都不会当场报错**，
 * 而是过一阵子才以别的样子出现 ——
 *
 *   - `.dockerignore` 漏了 `dist-node/`：构建时把宿主上那份**旧产物** COPY 进去，
 *     镜像里跑的是上一次的代码，而构建日志一切正常
 *   - `Dockerfile` 的 `DB_PATH` 落在 `/data` 之外：卷仍然挂得上，但数据**不在卷里**，
 *     重建容器就全没了（签名密钥一起没，浏览器里缓存的封面全变 403）
 *   - 代码里新读一个环境变量（比如以后再加个开关），而 `DOCKER.md` 那张表没跟上：
 *     容器里没人能让它生效，文档里也查不到
 *
 * 这三条都能用几行正则钉住，所以钉住。读的都是仓库里那几份真文件，不另抄一份。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

const dockerfile = read('Dockerfile')
const pageDockerfile = read('Dockerfile.page')
const nginx = read('page.nginx.conf')
const compose = read('docker-compose.yml')
const dockerignore = read('.dockerignore')
const doc = read('DOCKER.md')

/** 容器里那个数据库路径（`ENV DB_PATH=…` 那一行） */
const dbPath = /^ENV DB_PATH=(\S+)$/m.exec(dockerfile)?.[1] ?? ''
/** 接口那一份在容器里监听的端口（`ENV PORT=…`） */
const apiPort = /^ENV PORT=(\d+)$/m.exec(dockerfile)?.[1] ?? ''
/** 页面那一份暴露的端口（`EXPOSE …`） */
const pagePort = /^EXPOSE (\d+)$/m.exec(pageDockerfile)?.[1] ?? ''
/** compose 里两个服务的配置块（按缩进切，够用且不必引 YAML 依赖） */
const apiBlock = compose.slice(compose.indexOf('\n    api:\n'), compose.indexOf('\n    page:\n'))
const pageBlock = compose.slice(compose.indexOf('\n    page:\n'), compose.indexOf('\nvolumes:'))

describe('Dockerfile', () => {
    it('两阶段构建：构建阶段装了打包器，运行阶段只装运行期依赖', () => {
        expect(dockerfile).toMatch(/^FROM .+ AS build$/m)
        expect(dockerfile).toMatch(/^FROM .+ AS runtime$/m)
        // 运行期那一份必须带上 --omit=dev：不然 wrangler 与 vitest 都会进镜像
        expect(dockerfile).toMatch(/npm ci --omit=dev --ignore-scripts/)
    })

    it('构建阶段没装 devDependencies —— wrangler 那一坨在容器里用不到', () => {
        // 装依赖的那一步（`mkdir -p src/engine && npm ci --omit=dev`）
        expect(dockerfile).toMatch(/RUN mkdir -p src\/engine && npm ci --omit=dev\n/)
        // 打包器单独装，版本从 package.json 读（不在这里写死）
        expect(dockerfile).toMatch(/devDependencies\.esbuild/)
    })

    it('不用 root 跑，并且先把 /data 的属主定好', () => {
        const userLine = dockerfile.indexOf('USER node')
        const chownLine = dockerfile.indexOf('chown -R node:node /data')
        expect(userLine).toBeGreaterThan(-1)
        expect(chownLine).toBeGreaterThan(-1)
        // 顺序要紧：命名卷第一次创建时复制的是**那一刻**镜像里那个目录的属主
        expect(chownLine).toBeLessThan(userLine)
    })

    it('CMD 用 exec 形式起自建入口（node 必须是 PID 1，SIGTERM 才收得到）', () => {
        expect(dockerfile).toMatch(/^CMD \["node", "dist-node\/server\.mjs"\]$/m)
    })

    it('健康检查打 /api/version（不碰库也不碰网）', () => {
        expect(dockerfile).toContain('/api/version')
        expect(dockerfile).toMatch(/^HEALTHCHECK/m)
    })
})

describe('两服务分工：页面（nginx）与接口（node）', () => {
    it('两个服务各建各的镜像，页面那份用 `Dockerfile.page`', () => {
        expect(apiBlock).toContain('build: .')
        expect(pageBlock).toContain('dockerfile: Dockerfile.page')
        // 页面那份是 nginx（只有它与静态资源），接口那份是 node
        expect(pageDockerfile).toMatch(/^FROM nginx:/m)
        expect(pageDockerfile).toContain('COPY public /usr/share/nginx/html')
        expect(dockerfile).toMatch(/^CMD \["node", "dist-node\/server\.mjs"\]$/m)
    })

    it('只有页面那一份对外发端口 —— 浏览器只该看到一个源', () => {
        expect(pageBlock).toMatch(/ports:/)
        expect(pageBlock).toContain(`:${pagePort}'`)
        // 接口那一份不 publish（要直接调它就在 compose 里自己加一行，见 DOCKER.md）
        expect(apiBlock).not.toMatch(/^\s+ports:/m)
    })

    it('接口那一份关掉静态资源，页面那一份的 nginx 打到接口的监听端口', () => {
        // compose 里关掉；代码里的默认仍是「发」（单容器与 `npm run start:node` 靠它）
        expect(apiBlock).toContain(`SERVE_STATIC: 'false'`)
        expect(read('src/server/node.ts')).toMatch(/process\.env\.SERVE_STATIC !== 'false'/)
        expect(dockerfile).toMatch(/^ENV SERVE_STATIC=true$/m)
        // 这一条最要紧：接口换了端口而 nginx 没跟着改 = 全站接口 502
        expect(apiPort).toBeTruthy()
        expect(nginx).toContain(`set $api_upstream http://api:${apiPort};`)
    })

    it('上游按请求解析，而不是启动时解析一次就记死', () => {
        // `proxy_pass http://api:8787` 直写的话，nginx 启动时解析一次并一直用那个 IP ——
        // api 容器重建换了地址就全站 502，除非有人记得把 page 也重启一遍。
        // 写成变量 + 声明 Docker 内嵌 DNS 才会按 ttl 重新解析。
        expect(nginx).toMatch(/proxy_pass \$api_upstream;/)
        expect(nginx).toMatch(/resolver 127\.0\.0\.11/)
    })

    it('页面那一份等接口健康了再起（否则头几秒打开页面会拿到 502）', () => {
        expect(pageBlock).toMatch(/depends_on:/)
        expect(pageBlock).toContain('condition: service_healthy')
        // 健康检查得真的存在，不然 compose 会直接拒绝启动
        expect(dockerfile).toMatch(/^HEALTHCHECK/m)
    })

    it('nginx 的三个数字都设对了（不设就会在具体场景下坏掉）', () => {
        // ① 全量搜索实测要 184.5 秒，默认 60 秒就断 —— 表现是「搜索转一会儿 504」
        const readTimeout = Number(/proxy_read_timeout (\d+)s/.exec(nginx)?.[1] ?? 0)
        expect(readTimeout).toBeGreaterThanOrEqual(300)
        expect(Number(/proxy_send_timeout (\d+)s/.exec(nginx)?.[1] ?? 0)).toBeGreaterThanOrEqual(
            300,
        )
        // ② 书源那份语料约 4.5 MB，而 nginx 默认上限 1 MB（导入会 413）
        const maxBody = Number(/client_max_body_size (\d+)m/.exec(nginx)?.[1] ?? 0)
        expect(maxBody).toBeGreaterThanOrEqual(8)
        // ③ 接口那一侧用 Host 推请求源（夹具地址与 cookie 的 Secure 判断都跟着它）
        expect(nginx).toContain('proxy_set_header Host $http_host;')
    })

    it('静态资源的回退策略与另外两份一致（都回 index.html）', () => {
        expect(nginx).toMatch(/try_files \$uri \$uri\/ \/index\.html;/)
    })
})

describe('数据落点与 compose 对得上', () => {
    it('DB_PATH 在 /data 里，而这个目录正是 compose 挂卷的地方', () => {
        expect(dbPath.startsWith('/data/')).toBe(true)
        expect(apiBlock).toMatch(/- reader-data:\/data/)
        expect(dockerfile).toMatch(/^VOLUME \["\/data"\]$/m)
    })

    it('卷只挂在接口那一份上 —— 页面容器是无状态的', () => {
        expect(pageBlock).not.toContain('reader-data')
        expect(pageDockerfile).not.toContain('VOLUME')
        expect(pageDockerfile).not.toContain('DB_PATH')
    })

    it('compose 的容器端口与 EXPOSE 的是同一个', () => {
        expect(pagePort).toBeTruthy()
        // 端口那行长这样：'${READER_PORT:-8787}:80'
        expect(pageBlock).toContain(`:${pagePort}'`)
    })

    it('compose 的 ENABLE_FIXTURE 默认关，与 wrangler.jsonc 线上那份一致', () => {
        expect(apiBlock).toMatch(/ENABLE_FIXTURE: '\$\{ENABLE_FIXTURE:-false\}'/)
    })

    it('compose 的 SEARCH_ALL_SOURCES 默认开，而且能与线上那份对得上', () => {
        // 自建这份没有每请求的 CPU 上限，「一次搜完全部书源」是它该有的能力
        expect(apiBlock).toMatch(/SEARCH_ALL_SOURCES: '\$\{SEARCH_ALL_SOURCES:-true\}'/)
        // 线上反过来：免费计划每请求 10 ms，一次求值几百个源必然被掐
        expect(read('wrangler.jsonc')).toMatch(/"SEARCH_ALL_SOURCES":\s*"false"/)
    })

    it('两个开工开关都挂在接口那一份上（页面那份不该拿到引擎的开关）', () => {
        for (const name of ['ENABLE_FIXTURE', 'SEARCH_ALL_SOURCES', 'SERVE_STATIC']) {
            expect(apiBlock, name).toContain(name)
            expect(pageBlock, name).not.toContain(name)
        }
    })
})

describe('.dockerignore', () => {
    it('构建产物与依赖一律不进上下文 —— 否则会跑上一次的旧产物', () => {
        for (const one of [
            'node_modules',
            'dist-node',
            'dist',
            'dist-pages',
            '.wrangler',
            'data',
        ]) {
            expect(dockerignore.split('\n'), one).toContain(one)
        }
    })

    it('排除 src/engine/*.wasm：那一份必须由 prepare 钩子按依赖版本重新生成', () => {
        expect(dockerignore).toContain('src/engine/*.wasm')
    })
})

describe('DOCKER.md 与代码里的环境变量对得上', () => {
    /**
     * 容器这条路上「谁能被配置」只有两个出口：`Dockerfile` 里的 `ENV`，
     * 或者文档里那张表。从代码里把环境变量名抠出来，逐个要求落在其中一个里 ——
     * 以后再加一个开关却忘了写进容器，这条会红。
     */
    const sources = ['src/server/node.ts', 'src/platform/node.ts', 'src/platform/wasm.node.ts']
    const names = new Set<string>()
    for (const file of sources) {
        for (const hit of read(file).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
            names.add(hit[1]!)
        }
    }

    it('代码里读到的每个环境变量都在 Dockerfile 或 DOCKER.md 里出现过', () => {
        expect(names.size).toBeGreaterThan(0)
        const haystack = `${dockerfile}\n${doc}`
        for (const name of names) {
            expect(haystack, `${name} 在容器里没法配置，DOCKER.md 里也查不到`).toContain(name)
        }
    })
})
