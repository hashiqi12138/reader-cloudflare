/**
 * 从规则取回的文本里挑出图片地址
 *
 * 单独成模块的原因有两个：
 *   1. 这是纯函数，不碰网络也不碰沙箱，可以完整地做单元测试；
 *   2. 它旁边的 media.ts 会连带引入沙箱（也就连带引入 WASM），
 *      而单元测试跑在 Node 里、没有 workerd 的 WASM 加载能力。
 *
 * 真实书源里图片地址有两大类写法，两类都要认：
 *   - `<img>` 标签：包子漫画、天脉漫画、禁漫大王都是这种，用 @js 拼出标签再交给阅读器
 *   - 裸地址：老司机那类先取 `@data-src` 得到一串地址，再（可选地）包成标签
 */

import type { MediaLink } from '../engine/types'

/**
 * 占位图判定
 *
 * 懒加载站点在 `src` 上放一张 1x1 透明 gif，真地址写在 `data-src` 上。
 * 不排除这些的话，一章几十张图会全部变成同一张空白图，而且**看起来是「加载成功」**——
 * 比报错更难发现。
 */
export function isPlaceholder(url: string): boolean {
    const v = url.trim().toLowerCase()
    if (v === '') return true
    if (v.startsWith('data:')) return true
    if (v.startsWith('javascript:')) return true
    if (v.startsWith('blob:')) return true
    if (v.startsWith('about:')) return true
    return /(?:^|\/)(?:blank|loading|placeholder|spacer|pixel|grey|gray|none)\.(?:gif|png|jpe?g|svg|webp)$/.test(
        v,
    )
}

const IMG_ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

/** 取图片真实地址的优先级。`src` 放最后，因为它最可能是占位图 */
const SRC_ATTRS = [
    'data-src',
    'data-original',
    'data-lazy-src',
    'data-echo',
    'data-url',
    'data-actualsrc',
    'data-original-src',
    'src',
]

/** 从一个 `<img>` 标签里挑出真实图片地址 */
export function pickImageUrl(tag: string): string {
    const attrs = new Map<string, string>()
    IMG_ATTR.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = IMG_ATTR.exec(tag)) !== null) {
        const name = (m[1] ?? '').toLowerCase()
        // 同名属性取第一个：标签里重复出现同名属性时，别被后面的空值覆盖掉
        if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? '')
    }

    for (const name of SRC_ATTRS) {
        const value = attrs.get(name)
        if (value && !isPlaceholder(value)) return value
    }

    // srcset 兜底：取第一个候选地址
    const srcset = attrs.get('srcset') ?? attrs.get('data-srcset')
    if (srcset) {
        const first = srcset.split(',')[0]?.trim().split(/\s+/)[0] ?? ''
        if (!isPlaceholder(first)) return first
    }
    return ''
}

/**
 * 一次扫出所有图片地址，**保持原有顺序**
 *
 * 用一个正则同时匹配 `<img>` 标签和裸 URL，而不是「先找标签、再找裸 URL」分两趟 ——
 * 分两趟会把顺序打乱（先全部标签、后全部裸 URL），而漫画的页序就是阅读顺序，
 * 顺序错了等于把书撕了重排。
 *
 * 正则的标签分支排在前面，因此在 `<` 处会优先吃掉整个标签，
 * 标签内部的 `src="http://..."` 不会被第二个分支重复匹配。
 */
const IMAGE_SCAN = /<img\b[^>]*>|(?:https?:)?\/\/[^\s"'<>()\\]+/gi

/**
 * @param resolve 把候选地址补全成绝对地址。**必须按这一页自己的地址补**，
 *                不能统一按第一章的地址 —— 翻页后图片常挂在更深一层的目录下。
 */
export function extractImageLinks(
    raw: string,
    resolve: (candidate: string) => string,
): MediaLink[] {
    const out: MediaLink[] = []
    const seen = new Set<string>()

    IMAGE_SCAN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = IMAGE_SCAN.exec(raw)) !== null) {
        const hit = m[0]
        const candidate = hit.startsWith('<') ? pickImageUrl(hit) : hit
        if (!candidate || isPlaceholder(candidate)) continue

        const url = resolve(candidate)
        if (!/^https?:\/\//i.test(url)) continue
        if (seen.has(url)) continue
        seen.add(url)
        out.push({ url })
    }
    return out
}
