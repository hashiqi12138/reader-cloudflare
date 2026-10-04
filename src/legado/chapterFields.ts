/**
 * 目录规则里那几条「逐条求值」的字段怎么读成值
 *
 * `ruleToc` 除了 `chapterList` / `chapterName` / `chapterUrl` / `nextTocUrl` 之外，
 * 还有四条**逐条求值**的字段：`isVip` / `isPay` / `isVolume` / `updateTime`。
 * 它们与 `chapterName` 同一层 —— 都是普通规则（选择器、`{{}}` 模板、`@js:` 都行），
 * 求值出来都是一段字符串。第五十六轮之前这四条**整片丢掉**，症状是
 * 「目录里看不出哪一章要钱、也看不到卷」。
 *
 * 怎么把那段字符串读成「是 / 不是」，语料里**两套写法都真实存在**：
 *
 *   标记文本型 —— 取到东西就是，取不到（空串）就不是
 *     🌍🔞UAA小说      @css:.ndc-acc@text##注册会员
 *     ⚡📂企鹅阅读      .list@.lock@html（锁图标的 HTML）
 *     🏷磨铁中文        ¥{{$.free}}##¥true（免费章替换成空串）
 *   脚本布尔型 —— 明明白白给 true / false
 *     🏷晋江文学        <js> vip = ("{{$.isvip}}"!="0"); … </js>
 *     🔞书耽           @js:!{{$.auth_access}}
 *     🏷微信读书         @js: Number(…) > 0 && Number(…) == 0
 *
 * 只按「非空即真」判的话，脚本回 `false` 的那些章会被当成要付费 ——
 * 前端于是去拦一个本来能读的章。所以 `false` / `0` 要当成「不是」。
 */

/** 逐条字段里的真假：非空、且不是 `false` / `0` */
export function tocFlag(value: string | undefined | null): boolean {
    const text = String(value ?? '')
        .trim()
        .toLowerCase()
    return text !== '' && text !== 'false' && text !== '0'
}

/** 逐条字段里的文本（`updateTime` 那一类）：空串统一成 undefined，别让前端渲染出空白 */
export function tocText(value: string | undefined | null): string | undefined {
    const text = String(value ?? '').trim()
    return text === '' ? undefined : text
}
