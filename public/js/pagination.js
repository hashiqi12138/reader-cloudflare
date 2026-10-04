/**
 * 翻页的几何：一页有多宽（步长）、一共几页
 *
 * 单拎出来是为了能测 —— 这两件事以前直接写在阅读器的闭包里，而它们正是
 * 「每翻一页偏一点」「末尾多出几页空白」的根。前端那套测试（`test/*.mjs`）
 * 只测纯函数，所以这里只碰「传进来的东西」，不碰模块级的 DOM 引用。
 *
 * 背景（第六十二轮）：翻页是 CSS 多列排版，一列就是一页，翻页靠 `translateX`。
 * 步长必须**正好等于一列的实际宽度 + 列间距**，差多少就每翻一页偏多少。
 */

/**
 * 翻一页要位移多少（= 列宽 + 列间距）
 *
 * 优先量**相邻两列左边缘之差**：那是布局自己说的数，留白/间距怎么改都对得上。
 * 正文里没有跨列的段落时（短章节）退回「正文盒的宽」—— 一列时它正好等于
 * 列宽 + 列间距（盒子的左右留白之和 = 列间距）。
 *
 * 为什么不能用 `clientWidth`：它是**取过整的**整数，而列是浏览器按小数宽排的
 *  —— 两者差 0.5px，翻二十页就是 10px，正好是「越翻越偏十几 px」那个量级。
 */
export function pagePitch(flow) {
    if (!flow) return 0
    for (const paragraph of flow.children ?? []) {
        if (typeof paragraph.getClientRects !== 'function') continue
        const rects = paragraph.getClientRects()
        if (rects.length >= 2) return rects[1].left - rects[0].left
    }
    return flow.getBoundingClientRect().width
}

/**
 * 一共有几页 = 布局里**现在**有几列
 *
 * `scrollWidth = n * 列距 - 左留白`，所以 `round(scrollWidth / 列距)` 就是 n。
 * 只在测量时算一次是不够的：工具条高度、字体度量、旋屏都会让列重新流动，
 * 而 `scrollWidth` 是**静悄悄**变的（不派发 `window.resize`），于是页数会落伍 ——
 * 末尾多出几页**空白**，计数器却还在往前走。
 */
export function pageCountOf(scrollWidth, pitch) {
    if (!(pitch > 0)) return 1
    return Math.max(1, Math.round(scrollWidth / pitch))
}
