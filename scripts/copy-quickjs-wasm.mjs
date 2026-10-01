/**
 * 把 QuickJS 的 WASM 复制进 src/，供代码直接 import
 *
 * 为什么必须有这一步
 * ----------------
 * Cloudflare Workers 出于安全考虑**禁止从字节动态编译 WASM**（`WebAssembly.compile` 不可用），
 * 也不允许按包路径去 fetch 一个 `.wasm` 文件。唯一可行的路子是让打包器处理一个
 * **相对路径**的 `.wasm` import：wrangler 会把它编译成 `WebAssembly.Module`
 * 直接交给运行时，绕开上面两条限制。
 *
 * 代价是 WASM 得先落到源码目录。与其把这个二进制提交进仓库，不如在
 * dev / build / deploy / test 之前从 node_modules 复制一份（见 package.json 的 pre 钩子），
 * 这样升级 quickjs-emscripten 后不会忘记同步 WASM 版本。
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 与唯一的使用点 src/engine/js.ts 放在一起：这个二进制只为它存在，
// 分开放在 src/ 根目录反而要读者去猜它归谁用。
const destDir = path.join(root, 'src', 'engine')

/**
 * 变体名 → 包名后缀
 *
 * 显式列表而不是「把名字变小写再把下划线换成连字符」：那样会把 RELEASE_ASYNC
 * 拼成 release-async，而实际的包叫 quickjs-wasmfile-release-asyncify，
 * 名字对不上会在运行时报「找不到 wasm」，且报错信息不会告诉你映射错了。
 */
const VARIANT_PACKAGES = {
    RELEASE_SYNC: 'release-sync',
    RELEASE_ASYNC: 'release-asyncify',
    DEBUG_SYNC: 'debug-sync',
    DEBUG_ASYNC: 'debug-asyncify',
}

/**
 * 只复制实际会用到的变体
 *
 * 这里只装 asyncify 版，不装同步版，理由有两条：
 *   1. asyncify 版既能跑同步脚本也能跑异步脚本，一份就够 ——
 *      「同步走 A、异步走 B」两条路径会让同一段规则在两种模式下行为不同，
 *      这类分歧极难排查。
 *   2. 体积上更划算：asyncify 是 1003 KB，两份加起来是 1494 KB。
 * 代价是同步脚本也要承担 asyncify 的运行开销，对「几条字符串处理」这种
 * 量级的脚本可以忽略。
 */
const VARIANTS = ['RELEASE_ASYNC']

let copied = 0
for (const variant of VARIANTS) {
    const suffix = VARIANT_PACKAGES[variant]
    if (!suffix) {
        console.error(
            `[copy-quickjs-wasm] 未登记的变体：${variant}，请先在 VARIANT_PACKAGES 里登记包名`,
        )
        process.exit(1)
    }
    const pkg = `@jitl/quickjs-wasmfile-${suffix}`
    let wasmPath
    try {
        wasmPath = require.resolve(`${pkg}/wasm`)
    } catch {
        console.error(
            `[copy-quickjs-wasm] 找不到 ${pkg} 的 wasm 文件。` +
                `请确认 quickjs-emscripten 已安装，且该包的导出路径未被改动。`,
        )
        process.exit(1)
    }

    const dest = path.join(destDir, `${variant}.wasm`)
    const srcSize = fs.statSync(wasmPath).size
    const upToDate = fs.existsSync(dest) && fs.statSync(dest).size === srcSize

    if (!upToDate) {
        fs.copyFileSync(wasmPath, dest)
        console.log(
            `[copy-quickjs-wasm] ${variant}.wasm 已更新（${(srcSize / 1024).toFixed(0)} KB）`,
        )
        copied++
    }
}

if (copied === 0) {
    console.log('[copy-quickjs-wasm] WASM 已是最新，无需复制')
}
