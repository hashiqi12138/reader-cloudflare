/**
 * 键值设置的读写
 *
 * 放在 D1 而不是环境变量，是为了让「媒体代理能工作」这件事不需要任何额外配置。
 */

import type { PlatformDb } from '../platform/types'

const MEDIA_SECRET_KEY = 'media_secret'

/**
 * 模块级缓存
 *
 * 这是**部署级的常量**，不是请求态 —— 缓存它不会把 A 请求的数据带给 B 请求。
 * 图片一章可能几十张，每张都回库读一次密钥是白花的延迟。
 */
let cachedSecret: string | null = null
let inflight: Promise<string> | null = null

/** 仅供测试使用：清掉缓存，模拟冷启动 */
export function resetMediaSecretCache(): void {
    cachedSecret = null
    inflight = null
}

function randomSecret(): string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 取媒体签名密钥，没有就生成一个
 *
 * 首次生成时会用 `INSERT OR IGNORE` 再**回读**：两个请求同时冷启动是完全可能的，
 * 若各自用自己生成的那把密钥，就会出现「同一个部署签出的地址另一半验不过」，
 * 表现为图片时好时坏 —— 这种间歇性故障最难查。回读保证大家用的是同一条。
 */
export async function getOrCreateMediaSecret(db: PlatformDb): Promise<string> {
    if (cachedSecret) return cachedSecret
    if (inflight) return inflight

    inflight = (async () => {
        const row = await db
            .prepare('SELECT value FROM settings WHERE key = ?')
            .bind(MEDIA_SECRET_KEY)
            .first<{ value: string }>()
        if (row?.value) {
            cachedSecret = row.value
            return row.value
        }

        const created = randomSecret()
        await db
            .prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
            .bind(MEDIA_SECRET_KEY, created, Date.now())
            .run()

        const after = await db
            .prepare('SELECT value FROM settings WHERE key = ?')
            .bind(MEDIA_SECRET_KEY)
            .first<{ value: string }>()
        const value = after?.value ?? created
        cachedSecret = value
        return value
    })()

    try {
        return await inflight
    } finally {
        inflight = null
    }
}
