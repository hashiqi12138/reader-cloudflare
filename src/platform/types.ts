/*
 * 平台接口：本项目与「跑在哪」之间的那条缝
 *
 * 要换平台，需要替掉的其实只有三样东西 ——
 *
 * 1. **数据库**（`PlatformDb`）：书源、书架、进度、书签、笔记、账号全落在这里。
 *    用到的 API 面窄得出乎意料：`prepare` / `bind` / `first` / `run` / `all` / `batch`
 *    加上 `meta.changes`，**没有** `.exec()` / `.raw()` / 会话。
 * 2. **静态资源**（`PlatformAssets`）：前端那堆文件谁来发（Workers 上是 `env.ASSETS`）。
 * 3. **WASM**：QuickJS 那一个模块怎么拿到。它**不在本文件里** —— 见 `platform/wasm.ts`，
 *    因为那是构建期的事：必须保持一句静态 `import`，换平台时换掉那一个文件。
 *
 * 形状刻意**照着 D1 定**（而不是自己造一套 DB 抽象）：形状一致，Cloudflare 那个绑定
 * 就能**直接满足**接口，不需要包装层、没有运行时开销，业务代码也不必改。
 * 代价是接口里留着几个 D1 的细节（`colName` 参数、泛型的默认值）。
 * 这笔账划算 —— 这几个参数本就是这类 SQL 绑定的通行形状，而包装层要付出的
 * 是每次查询多一次转发，以及一个「假 D1」要自己实现 `batch` 语义。
 *
 * 这一轮**只抽接口、不落第二个适配器**。目的不是现在就能跑在别处，而是把
 * 「跑在别处要改什么」变成一份看得见的清单：就是上面三样，加上一个入口 ——
 * `app.fetch(request, env)` 里那个 `env` 满足 `AppEnv` 就行。
 */

export interface PlatformResult<T = unknown> {
    /** 查询回来的行；写语句没有这一项 */
    results?: T[]
    success: boolean
    /**
     * 只用到这两项：`changes`（有没有真的改到行，见 `setSourceEnabled`）与
     * `last_row_id`（刚插入那行的自增 id，见 `createAccount`）。
     * 第二项是「插入并拿回 id」这个需求的最小表达 —— 换平台时给出等价的东西即可
     * （用 `INSERT ... RETURNING id` 也算）。
     */
    meta: { changes: number; last_row_id: number }
}

export interface PlatformStatement {
    bind(...values: unknown[]): PlatformStatement
    first<T = unknown>(colName?: string): Promise<T | null>
    run<T = unknown>(): Promise<PlatformResult<T>>
    all<T = unknown>(): Promise<PlatformResult<T>>
}

export interface PlatformDb {
    prepare(query: string): PlatformStatement
    /** 一批语句走一次往返；返回结果与传入顺序一一对应 */
    batch<T = unknown>(statements: PlatformStatement[]): Promise<PlatformResult<T>[]>
}

export interface PlatformAssets {
    fetch(request: Request): Promise<Response>
}

/**
 * 应用跑起来需要的那份环境
 *
 * `ENGINE_VERSION` / `ENABLE_FIXTURE` 是部署级配置（前者是界面「关于」页显示的版本号，
 * 后者是内置测试站点的开关），两个都**允许缺席** —— 少一个不该让整个应用起不来。
 */
export interface AppEnv {
    DB: PlatformDb
    ASSETS: PlatformAssets
    ENGINE_VERSION?: string
    ENABLE_FIXTURE?: string
}
