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

/** 只复制实际会用到的变体：release 用于生产，debug 用于本地排查 */
const VARIANTS = ['RELEASE_SYNC']

function kebab(name) {
  return name.toLowerCase().replace(/_/g, '-')
}

let copied = 0
for (const variant of VARIANTS) {
  const pkg = `@jitl/quickjs-wasmfile-${kebab(variant)}`
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
    console.log(`[copy-quickjs-wasm] ${variant}.wasm 已更新（${(srcSize / 1024).toFixed(0)} KB）`)
    copied++
  }
}

if (copied === 0) {
  console.log('[copy-quickjs-wasm] WASM 已是最新，无需复制')
}
