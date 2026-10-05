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
const compose = read('docker-compose.yml')
const dockerignore = read('.dockerignore')
const doc = read('DOCKER.md')

/** 容器里那个数据库路径（`ENV DB_PATH=…` 那一行） */
const dbPath = /^ENV DB_PATH=(\S+)$/m.exec(dockerfile)?.[1] ?? ''

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

describe('数据落点与 compose 对得上', () => {
    it('DB_PATH 在 /data 里，而这个目录正是 compose 挂卷的地方', () => {
        expect(dbPath.startsWith('/data/')).toBe(true)
        expect(compose).toMatch(/- reader-data:\/data/)
        expect(dockerfile).toMatch(/^VOLUME \["\/data"\]$/m)
    })

    it('compose 的容器端口与 EXPOSE 的是同一个', () => {
        const exposed = /^EXPOSE (\d+)$/m.exec(dockerfile)?.[1]
        expect(exposed).toBeTruthy()
        // 端口那行长这样：'${READER_PORT:-8787}:8787'
        expect(compose).toContain(`:${exposed}'`)
    })

    it('compose 的 ENABLE_FIXTURE 默认关，与 wrangler.jsonc 线上那份一致', () => {
        expect(compose).toMatch(/ENABLE_FIXTURE: '\$\{ENABLE_FIXTURE:-false\}'/)
    })
})

describe('.dockerignore', () => {
    it('构建产物与依赖一律不进上下文 —— 否则会跑上一次的旧产物', () => {
        for (const one of ['node_modules', 'dist-node', 'dist', '.wrangler', 'data']) {
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
