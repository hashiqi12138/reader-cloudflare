/*
 * 阅读界面
 *
 * 两种模式：
 *   - 翻页（默认）：正文用 CSS 多列排版，一列就是一页；翻页靠 translateX 位移，
 *     配合边缘投影做出「一页推过去」的观感（不是仿真书页翻卷，那个在
 *     各种字体/行高下都会露馅，而且拖慢渲染）。
 *   - 滚动：整章一屏顺下来，长按阅读的人更习惯。
 *
 * 内容形式决定能不能翻页：文本可以分页，图片/音频/下载列表不能 ——
 * 后三种一律用滚动，并在界面上说明原因，而不是给一个翻不动的假翻页器。
 *
 * 显示设置对齐开源阅读（Legado）的「阅读设置」：背景色、字号、行距、翻页动画、
 * 主题，外加「替换净化」。净化规则在这一层（浏览器端）执行 ——
 * 它是读者的私人格式偏好，改一条就该立刻看到效果，不必来回存库。
 */

import {
    ACCENTS,
    ACCENT_LABELS,
    alertBox,
    api,
    append,
    currentUser,
    el,
    go,
    PAPERS,
    PAPER_LABELS,
    paramsOf,
    prefs,
    relativeTime,
    skeletonBlock,
    toast,
} from './core.js'
import { applyRules, loadRules, PRESET_RULES, saveRules, makeRule } from './replace.js'
import {
    describeRules,
    fetchRemoteRules,
    loadSyncBase,
    pushRemoteRules,
    saveSyncBase,
    syncState,
} from './replaceSync.js'
import { excerptAround, normalizeQuery, splitByQuery } from './search.js'
import { addBook, inShelf, loadShelf } from './views.js'
import {
    DEFAULT_FONT_SIZE,
    clampFontSize,
    fontSizeFromPinch,
    fontSizeFromWheel,
    stepFontSize,
    touchDistance,
} from './zoom.js'

/** 一章的目录缓存：翻页时不该重新拉目录 */
let bookCache = null

export async function viewRead(host) {
    const route = new URLSearchParams(location.hash.split('?')[1] ?? '')
    const sourceId = route.get('sourceId') ?? ''
    // 也认 `bookUrl`：早先的「开始阅读」链接用的是这个名字，而阅读地址是可以
    // 分享/收藏的 —— 老链接不该因为改了个参数名就打不开
    const bookUrl = route.get('url') ?? route.get('bookUrl') ?? ''
    const nameHint = route.get('name') ?? ''
    const authorHint = route.get('author') ?? ''
    const wantedIndex = Number(route.get('index') ?? '0')

    if (sourceId === '' || bookUrl === '') {
        host.replaceChildren(alertBox('error', '缺少书源或书籍地址'))
        return
    }

    host.replaceChildren(skeletonBlock('正在读取目录…'))

    const cacheKey = `${sourceId}\n${bookUrl}`
    if (bookCache?.key !== cacheKey) {
        try {
            const info = await api(`/api/book?${paramsOf({ sourceId, url: bookUrl })}`)
            const tocUrl = info.tocUrl || bookUrl
            const toc = await api(`/api/toc?${paramsOf({ sourceId, url: tocUrl })}`)
            bookCache = {
                key: cacheKey,
                sourceId,
                bookUrl,
                name: info.name || nameHint || '未命名',
                author: info.author || authorHint,
                // 收藏时要带上封面：没有它书架里会是一个灰块
                coverUrl: info.coverUrl ?? '',
                chapters: toc.chapters ?? [],
                warning: toc.warning ?? null,
            }
        } catch (err) {
            host.replaceChildren(
                alertBox('error', '打不开这本书', err.message),
                el('div', { class: 'row' }, [
                    el('button', {
                        class: 'btn ghost',
                        text: '返回',
                        onclick: () => history.back(),
                    }),
                ]),
            )
            return
        }
    }

    const book = bookCache
    if (book.chapters.length === 0) {
        host.replaceChildren(
            el('h1', { class: 'page-title', text: book.name }),
            alertBox('warn', '这本书没有章节'),
        )
        return
    }

    const index = Math.min(
        Math.max(Number.isFinite(wantedIndex) ? wantedIndex : 0, 0),
        book.chapters.length - 1,
    )
    const chapter = book.chapters[index]

    // ---- 骨架 ----
    const titleNode = el('span', { class: 'reader-title', text: chapter.name })
    const progressBar = el('div', { class: 'reader-progress-fill' })
    const pageLabel = el('span', { class: 'reader-page-label', text: '' })
    const body = el('div', { class: 'reader-body' })

    /**
     * 收藏按钮
     *
     * 放在阅读界面里是必要的：「读完这一章觉得不错，想收起来」是最高频的收藏时机，
     * 而回详情页再加书架等于打断阅读。状态取自书架缓存，加入后立刻切换。
     */
    let shelfEntries = []
    try {
        shelfEntries = await loadShelf()
    } catch {
        /* 书架读不到不影响阅读，只是收藏按钮会走「加入」那条路 */
    }
    const collectBtn = el('button', {
        class: 'icon-btn',
        text: '☆',
        title: '加入书架',
        onclick: async () => {
            collectBtn.disabled = true
            try {
                await addBook(sourceId, {
                    bookUrl,
                    name: book.name,
                    author: book.author,
                    coverUrl: book.coverUrl,
                })
                collectBtn.textContent = '★'
                collectBtn.title = '已在书架'
            } catch (err) {
                toast(`加入失败：${err.message}`, 'error')
                collectBtn.disabled = false
            }
        },
    })
    if (inShelf(shelfEntries, sourceId, bookUrl)) {
        collectBtn.textContent = '★'
        collectBtn.title = '已在书架'
        collectBtn.disabled = true
    }

    /**
     * 书签按钮与章内搜索按钮
     *
     * 搜索只对文本正文有意义（图片/音频/下载章没有「一段字」可搜），
     * 而「这一章是不是文本」要等正文取回来才知道 —— 顶栏却必须在那之前画出来，
     * 否则取网期间连返回按钮都没有。所以这里先备好按钮，等 `isText` 定了再插进顶栏。
     *
     * 早先是「顶栏里直接判断 `isText`」，那是个**先读后声明**的死区错误：
     * 整个阅读界面会报 `Cannot access 'isText' before initialization` 并只剩一个空壳。
     */
    const bookmarkBtn = el('button', {
        class: 'icon-btn',
        text: '🔖',
        title: '书签',
        onclick: () => openBookmarks(),
    })
    const searchBtn = el('button', {
        class: 'icon-btn',
        text: '🔍',
        title: '本章内搜索',
        onclick: () => openSearch(),
    })

    const topBar = el('header', { class: 'reader-top' }, [
        el('button', {
            class: 'icon-btn',
            text: '‹',
            title: '返回',
            onclick: () => history.back(),
        }),
        titleNode,
        el('div', { class: 'spacer' }),
        collectBtn,
        bookmarkBtn,
        el('button', {
            class: 'icon-btn',
            text: '☰',
            title: '目录',
            onclick: () => openToc(),
        }),
        el('button', {
            class: 'icon-btn',
            text: 'Aa',
            title: '显示设置',
            onclick: () => openSettings(),
        }),
    ])

    /**
     * 字号提示
     *
     * 捏合与 Ctrl+滚轮都不经过设置面板，所以要有一个自己的反馈 ——
     * 否则用户只知道「字变了」，不知道变到了几号、也不知道到底到没到上下限。
     * 固定在上方居中，900ms 后自己消失（不挡住正在读的那一屏）。
     */
    const zoomHud = el('div', { class: 'reader-zoom-hud', hidden: true })

    const shell = el('div', { class: 'reader-shell' }, [
        topBar,
        body,
        el('footer', { class: 'reader-bottom' }, [
            el('button', {
                class: 'btn ghost sm',
                text: '上一章',
                disabled: index === 0,
                onclick: () => openChapter(index - 1, 'first'),
            }),
            el('div', { class: 'reader-progress' }, [progressBar]),
            pageLabel,
            el('button', {
                class: 'btn ghost sm',
                text: '下一章',
                disabled: index === book.chapters.length - 1,
                onclick: () => openChapter(index + 1, 'first'),
            }),
        ]),
        zoomHud,
    ])

    host.replaceChildren(shell)

    function openChapter(next, where = 'first') {
        if (next < 0 || next >= book.chapters.length) return
        go(
            `#/read?${paramsOf({
                sourceId,
                url: bookUrl,
                name: book.name,
                author: book.author,
                index: next,
                page: where === 'last' ? 'last' : '',
            })}`,
        )
    }

    // ---- 取正文 ----
    let content
    try {
        content = await api(`/api/content?${paramsOf({ sourceId, url: chapter.url })}`)
    } catch (err) {
        body.replaceChildren(
            alertBox('error', '正文取不到', err.message),
            el('div', { class: 'row center' }, [
                el('button', { class: 'btn', text: '重试', onclick: () => viewRead(host) }),
                el('button', { class: 'btn ghost', text: '换个源', onclick: () => go('#/search') }),
            ]),
        )
        updateProgressBar(0)
        return
    }

    const isText = content.kind === 'text'
    let mode = prefs.get('readerMode') === 'scroll' || !isText ? 'scroll' : 'page'

    // 到这里才知道这一章能不能搜，顶栏上的搜索按钮现在才插进去（见上面的说明）
    if (isText) topBar.insertBefore(searchBtn, bookmarkBtn)

    // ---- 恢复阅读位置 ----
    // 服务器上的进度只记「读到第几页」，而书签/目录跳转会直接在地址里带位置，
    // 后者更精确也更「刚好是用户要的」，所以下面优先用它。
    let savedPage = null
    try {
        const data = await api(`/api/progress?${paramsOf({ sourceId, bookUrl })}`)
        if (data.progress && data.progress.chapterIndex === index)
            savedPage = data.progress.pageIndex ?? 0
    } catch {
        /* 取不到进度不影响阅读，按第一页开始 */
    }
    const routePage = route.get('page')
    const routePos = Number(route.get('pos') ?? '')

    // ---- 渲染正文 ----
    const flow = el('div', { class: 'reader-flow' })
    let pageCount = 1
    let page = 0

    /**
     * 正文净化
     *
     * 在**渲染之前**做，而不是渲染之后改 DOM：分页是按文本长度算的，
     * 先净化再排版才能得到正确的页码；反过来会出现「明明删掉了广告，
     * 页码却还按原文算」的错位。
     *
     * 净化结果缓存在 `chapterText` 里，而不是每次重画都重算 ——
     * 章内搜索每敲一个字就要重画一次正文，重算净化在长章节上是白费的开销。
     */
    let chapterText = isText
        ? applyRules(String(content.content ?? '').trim(), loadRules()).trim()
        : ''
    /** 章内搜索：关键词 + 命中节点（按出现顺序）+ 当前是第几处 */
    const search = { query: '', active: -1 }
    let hitNodes = []

    /** 把正文铺进阅读区，顺带标出章内搜索的命中 */
    function paintFlow() {
        hitNodes = []
        flow.replaceChildren()
        if (chapterText === '') {
            flow.append(
                alertBox(
                    'warn',
                    '这一章取到的是空正文',
                    '通常是书源的 content 规则没匹配到内容，或站点改版了。',
                ),
            )
            return
        }

        for (const line of chapterText.split('\n')) {
            const trimmed = line.trim()
            if (trimmed === '') continue

            const parts = search.query === '' ? null : splitByQuery(trimmed, search.query)
            // 没有命中的段落走快路径：一个文本节点，不额外造元素
            if (parts === null || !parts.some((part) => part.hit)) {
                flow.append(el('p', { text: trimmed }))
                continue
            }

            const paragraph = el('p')
            for (const part of parts) {
                if (!part.hit) {
                    paragraph.append(part.text)
                    continue
                }
                const mark = el('mark', { class: 'search-hit', text: part.text })
                // 序号写进 dataset：从事件里拿到被点的那一处，就能定位它在 hitNodes 里的下标
                mark.dataset.hit = String(hitNodes.length)
                hitNodes.push(mark)
                paragraph.append(mark)
            }
            flow.append(paragraph)
        }
    }

    if (isText) {
        paintFlow()
    } else {
        flow.append(renderMedia(content))
        flow.classList.add('media-flow')
    }

    body.replaceChildren(flow)
    body.classList.toggle('paged', mode === 'page')

    if (book.warning) {
        body.prepend(alertBox('warn', '这份目录可能不完整', book.warning))
    }
    if (!isText) {
        body.prepend(
            el('p', {
                class: 'muted tiny center',
                text: '这一章不是文本（图片/音频/下载），因此按滚动展示，不参与翻页。',
            }),
        )
    }

    // ---- 分页与翻页 ----

    /**
     * 每页之间的横向间隔
     *
     * 分页用的是 CSS 多列：一列就是一页。列与列之间留 gap 是为了给正文两侧留白 ——
     * 多列容器的 padding 只作用于整块、不作用于每一列，所以留白只能靠 gap：
     * 列宽 = 可视宽 - gap，翻一页的位移 = 列宽 + gap = 可视宽，正好一屏。
     */
    const PAGE_GAP = 44

    function measure() {
        if (mode !== 'page') {
            pageCount = 1
            return
        }
        const width = body.clientWidth
        if (width <= 0) return
        const columnWidth = Math.max(200, width - PAGE_GAP)
        flow.style.columnGap = `${PAGE_GAP}px`
        flow.style.columnWidth = `${columnWidth}px`
        // 多列容器的 scrollWidth = n*列宽 + (n-1)*gap
        pageCount = Math.max(1, Math.round((flow.scrollWidth + PAGE_GAP) / width))
        page = Math.min(page, pageCount - 1)
    }

    function applyPage(animate, direction) {
        if (mode !== 'page') {
            updateProgressBar(1)
            return
        }
        flow.style.transform = `translateX(${-page * body.clientWidth}px)`
        if (animate) {
            body.classList.remove('turn-next', 'turn-prev')
            void body.offsetWidth
            body.classList.add(direction === 'prev' ? 'turn-prev' : 'turn-next')
            setTimeout(() => body.classList.remove('turn-next', 'turn-prev'), 340)
        }
        pageLabel.textContent = `${page + 1} / ${pageCount}`
        updateProgressBar((page + 1) / pageCount)
        scheduleSave()
    }

    function updateProgressBar(ratio) {
        progressBar.style.width = `${Math.max(2, Math.min(100, ratio * 100))}%`
    }

    /** 翻过头就换章：读到页尾继续翻，是所有人的直觉 */
    function turn(step) {
        if (mode !== 'page') {
            body.scrollBy({ top: step * body.clientHeight * 0.9, behavior: 'smooth' })
            return
        }
        const next = page + step
        if (next < 0) {
            if (index > 0) openChapter(index - 1, 'last')
            return
        }
        if (next >= pageCount) {
            if (index < book.chapters.length - 1) openChapter(index + 1, 'first')
            else toast('已经是最后一章')
            return
        }
        page = next
        applyPage(true, step < 0 ? 'prev' : 'next')
    }

    // ---- 字号缩放 ----

    /** 设置面板里那个「19px」。面板没开时为 null，改字号时顺手让它跟上 */
    let fontLabel = null
    let zoomHudTimer = 0

    function showZoomHud(size) {
        zoomHud.textContent = `${size}px`
        zoomHud.hidden = false
        clearTimeout(zoomHudTimer)
        zoomHudTimer = setTimeout(() => {
            zoomHud.hidden = true
        }, 900)
    }

    /**
     * 改字号 —— 四个入口共用这里
     *
     * 设置面板的 A- / A+、双指捏合、Ctrl/⌘ + 滚轮、键盘 `+` / `-` / `0`。
     * 「写偏好 + 重新分页 + 面板上的数字跟上 + 弹一下提示」只写一遍，
     * 否则四条路各漏一样，表现还各不相同。
     *
     * 尺寸没变（捏到上下限）时**也给提示**：不给的话用户会以为手势没生效，
     * 反复捏几次然后来提 bug。
     */
    function setFontSize(next, options = {}) {
        const size = clampFontSize(next)
        if (size !== clampFontSize(prefs.get('fontSize'))) {
            prefs.set('fontSize', size)
            relayout()
            if (fontLabel) fontLabel.textContent = `${size}px`
        }
        if (options.notify) showZoomHud(size)
    }

    // ---- 手势与快捷键 ----

    let touchStart = null

    /** 双指捏合的状态：手势开始时的字号与两指距离（见 zoom.js 的说明） */
    let pinch = null
    let pinchFrame = 0
    let pinchPending = 0

    /** Ctrl/⌘+滚轮里「还没用掉的累积量」，触控板的小增量靠它攒（见 zoom.js） */
    let wheelCarry = 0

    body.addEventListener(
        'click',
        (event) => {
            if (mode !== 'page') return
            if (event.target.closest('a, button, audio, details')) return
            const rect = body.getBoundingClientRect()
            const ratio = (event.clientX - rect.left) / rect.width
            if (ratio < 0.32) turn(-1)
            else if (ratio > 0.68) turn(1)
            else shell.classList.toggle('chrome-hidden')
        },
        { passive: true },
    )

    body.addEventListener(
        'touchstart',
        (event) => {
            // 两根手指 = 捏合缩放。单指才是滑动翻页，所以捏合期间要把 touchStart 清掉，
            // 否则「捏一下」会顺带翻一页
            if (event.touches.length === 2) {
                pinch = {
                    startSize: clampFontSize(prefs.get('fontSize')),
                    startDistance: touchDistance(event.touches),
                }
                touchStart = null
                return
            }
            const touch = event.changedTouches[0]
            touchStart = { x: touch.clientX, y: touch.clientY, at: Date.now() }
        },
        { passive: true },
    )

    /**
     * 捏合过程中的重排按帧节流
     *
     * `touchmove` 一帧能来十几个，每次都 `measure()` + 重新分页会明显卡顿；
     * 而字号已经取整，多数帧算出来的值是一样的，本来也不必重排。
     */
    body.addEventListener(
        'touchmove',
        (event) => {
            if (!pinch || event.touches.length !== 2) return
            pinchPending = fontSizeFromPinch(
                pinch.startSize,
                pinch.startDistance,
                touchDistance(event.touches),
            )
            if (pinchFrame) return
            pinchFrame = requestAnimationFrame(() => {
                pinchFrame = 0
                setFontSize(pinchPending, { notify: true })
            })
        },
        { passive: true },
    )

    const endPinch = () => {
        pinch = null
        wheelCarry = 0
    }
    body.addEventListener(
        'touchend',
        (event) => {
            if (event.touches.length === 0) endPinch()
            if (!touchStart) return
            const touch = event.changedTouches[0]
            const dx = touch.clientX - touchStart.x
            const dy = touch.clientY - touchStart.y
            // 竖向滑动交给滚动，只有明显的横向滑动才算翻页
            if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.4) {
                turn(dx < 0 ? 1 : -1)
            }
            touchStart = null
        },
        { passive: true },
    )
    body.addEventListener('touchcancel', endPinch, { passive: true })

    /**
     * Ctrl/⌘ + 滚轮缩放字号
     *
     * 必须 `preventDefault`，否则浏览器的整页缩放会同时生效（字大了、界面也糊了）。
     * 桌面端触控板的「捏合」在浏览器里就是这条路径 —— 带着 `ctrlKey` 的 wheel 事件 ——
     * 所以两种手势在这一段汇合。
     *
     * 监听挂在 `shell` 上而不是 `window`：只接管阅读界面里的滚轮，出了这一屏不该拦。
     */
    shell.addEventListener(
        'wheel',
        (event) => {
            if (!event.ctrlKey && !event.metaKey) return
            event.preventDefault()
            const result = fontSizeFromWheel(
                clampFontSize(prefs.get('fontSize')),
                event.deltaY,
                wheelCarry,
                event.deltaMode,
            )
            wheelCarry = result.carry
            setFontSize(result.size, { notify: true })
        },
        { passive: false },
    )

    const onKey = (event) => {
        if (event.target instanceof HTMLElement && /INPUT|TEXTAREA/.test(event.target.tagName))
            return
        if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
            event.preventDefault()
            turn(1)
        } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
            event.preventDefault()
            turn(-1)
        } else if (event.key === 'ArrowDown' && mode === 'page') {
            event.preventDefault()
            turn(1)
        } else if (event.key === 'ArrowUp' && mode === 'page') {
            event.preventDefault()
            turn(-1)
        } else if (event.key === '=' || event.key === '+') {
            // `+` 在多数键盘上是 Shift+`=`，所以两种情况都要认
            event.preventDefault()
            setFontSize(stepFontSize(prefs.get('fontSize'), 1), { notify: true })
        } else if (event.key === '-' || event.key === '_') {
            event.preventDefault()
            setFontSize(stepFontSize(prefs.get('fontSize'), -1), { notify: true })
        } else if (event.key === '0') {
            // 恢复默认字号。不占用带修饰键的组合：读书时手上没有别的事
            event.preventDefault()
            setFontSize(DEFAULT_FONT_SIZE, { notify: true })
        } else if (event.key === 'Escape') {
            // 面板开着就关面板，没开就什么也不做（不要顺手退出阅读）
            activeSheetClose?.()
        }
    }
    window.addEventListener('keydown', onKey)

    const onResize = () => {
        measure()
        applyPage(false)
    }
    window.addEventListener('resize', onResize)

    // ---- 进度上报（去抖：连续翻页只报最后一次）----

    let saveTimer = null
    function scheduleSave() {
        clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
            void saveProgress()
        }, 900)
    }

    async function saveProgress() {
        try {
            await api('/api/progress', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sourceId,
                    bookUrl,
                    chapterUrl: chapter.url,
                    chapterName: chapter.name,
                    chapterIndex: index,
                    pageIndex: mode === 'page' ? page : 0,
                }),
            })
        } catch (err) {
            // 记不上进度不影响这一章，但要让用户知道，否则下次打开位置不对
            toast(`阅读进度没记上：${err.message}`, 'error')
        }
    }

    // ---- 目录与设置面板 ----

    const sheetHost = el('div', { class: 'sheet-host', hidden: true })

    /**
     * 当前这个面板的「关闭」动作
     *
     * 遮罩与 × 都走它，`Escape` 也走它 —— 否则按 Esc 关掉面板时会绕过收尾逻辑，
     * 搜索面板那个 200ms 的输入去抖定时器还会在关掉之后触发一次重排。
     */
    let activeSheetClose = null

    function closeSheets() {
        activeSheetClose = null
        sheetHost.hidden = true
        sheetHost.replaceChildren()
    }

    function openSheet(title, content, onClose) {
        // onClose 用来收尾：搜索面板与书签面板都持有「面板里的节点」的引用，
        // 面板关掉之后不该再往里面写东西（写进游离节点不会报错，但会留下悬着的引用）
        const close = () => {
            onClose?.()
            closeSheets()
        }
        activeSheetClose = close
        sheetHost.replaceChildren(
            el('div', { class: 'sheet-backdrop', onclick: close }),
            el('section', { class: 'sheet' }, [
                el('header', {}, [
                    el('strong', { text: title }),
                    el('div', { class: 'spacer' }),
                    el('button', { class: 'icon-btn', text: '×', onclick: close }),
                ]),
                el('div', { class: 'sheet-body' }, [content]),
            ]),
        )
        sheetHost.hidden = false
    }

    function openToc() {
        // 目录名动辄几十个字，超长的会把列表挤成两三行；按偏好截一段，
        // 完整标题留在 title 上，鼠标悬停仍能看到
        const limit = Number(prefs.get('chapterTitleLimit')) || 24
        const clip = (value) => (value.length > limit ? `${value.slice(0, limit)}…` : value)
        const list = el(
            'ul',
            { class: 'chapter-list' },
            book.chapters.map((item, i) =>
                el('li', { dataset: { current: String(i === index) } }, [
                    el('button', {
                        class: 'chapter-link',
                        title: item.name,
                        text: `${i + 1}. ${clip(item.name)}`,
                        onclick: () => {
                            closeSheets()
                            openChapter(i, 'first')
                        },
                    }),
                ]),
            ),
        )
        openSheet(`目录 · 共 ${book.chapters.length} 章`, list)
        requestAnimationFrame(() => {
            list.querySelector('li[data-current="true"]')?.scrollIntoView({ block: 'center' })
        })
    }

    // ---- 章内搜索 ----

    /** 搜索面板里的状态行与结果列表。面板没开时是 null，此时只需要维护命中节点 */
    let searchStatusNode = null
    let searchResultHost = null

    /**
     * 量出一个节点落在第几列（翻页模式下就是第几页）
     *
     * 用**折叠 Range** 而不是 `getBoundingClientRect()`：一个段落如果跨列断开，
     * 元素矩形是几段碎片的并集，左边缘会落在上一列 —— 量出来是错的。
     * 折叠 Range 量的是「这个字符站在哪一列」，正是要问的问题。
     */
    function columnOf(node) {
        const width = body.clientWidth
        if (width <= 0) return page
        const anchor = node.nodeType === 3 || node.firstChild === null ? node : node.firstChild
        let left
        try {
            const range = document.createRange()
            range.setStart(anchor, 0)
            range.collapse(true)
            left = range.getBoundingClientRect().left
        } catch {
            left = node.getBoundingClientRect().left
        }
        const offset = left - body.getBoundingClientRect().left + page * width
        return Math.floor((offset + 1) / width)
    }

    /** 面板里的状态与高亮跟着当前命中走 */
    function syncSearchUi() {
        if (searchStatusNode) {
            searchStatusNode.textContent =
                search.query === ''
                    ? ''
                    : hitNodes.length === 0
                      ? `本章没有「${search.query}」`
                      : search.active >= 0
                        ? `第 ${search.active + 1} / ${hitNodes.length} 处`
                        : `共 ${hitNodes.length} 处`
        }
        if (searchResultHost) {
            for (const row of searchResultHost.children) {
                row.classList.toggle('active', Number(row.dataset.hit) === search.active)
            }
        }
    }

    /** 跳到第 k 处命中（k 会按命中总数取模，因此 -1 就是最后一处） */
    function goToHit(k) {
        const total = hitNodes.length
        if (total === 0) return
        search.active = ((k % total) + total) % total
        hitNodes.forEach((node, i) => node.classList.toggle('active', i === search.active))
        const node = hitNodes[search.active]

        if (mode === 'page') {
            // 翻页模式不能靠 scrollIntoView 定位：正文是横向多列，纵向滚动根本不动
            const previous = page
            page = Math.max(0, Math.min(pageCount - 1, columnOf(node)))
            applyPage(previous !== page, page < previous ? 'prev' : 'next')
        } else {
            node.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
        syncSearchUi()
    }

    /** 相对当前命中前后移动。还没有当前命中时，「下一处」从第一处开始 */
    function stepHit(delta) {
        if (hitNodes.length === 0) return
        if (search.active < 0) goToHit(delta >= 0 ? 0 : hitNodes.length - 1)
        else goToHit(search.active + delta)
    }

    /**
     * 章内搜索面板
     *
     * 只搜当前这一章，与「搜书」是两回事：搜书是拿关键词去各书源找书，
     * 这个回答的是「刚才那句在哪儿」。因此它不碰网络、不重新取正文 ——
     * 搜的是**已经净化、已经排版好的这一章**，所见即所搜。
     */
    function openSearch() {
        if (!isText) return

        const input = el('input', {
            type: 'search',
            class: 'search-input',
            placeholder: '在本章里找…',
            value: search.query,
        })
        searchStatusNode = el('p', { class: 'muted tiny search-status' })
        searchResultHost = el('div', { class: 'search-results' })

        function renderResults() {
            searchResultHost.replaceChildren()
            if (search.query === '') {
                searchResultHost.append(
                    el('p', { class: 'muted tiny', text: '输入关键词，正文里所有出现都会高亮。' }),
                )
                return
            }
            if (hitNodes.length === 0) return

            const rows = []
            for (const paragraph of flow.children) {
                const first = paragraph.querySelector('mark.search-hit')
                if (!first) continue
                const hits = paragraph.querySelectorAll('mark.search-hit').length
                rows.push(
                    el(
                        'button',
                        {
                            class: 'search-result',
                            dataset: { hit: first.dataset.hit },
                            onclick: () => goToHit(Number(first.dataset.hit)),
                        },
                        [
                            el('span', {
                                class: 'search-result-text',
                                text: excerptAround(paragraph.textContent ?? '', search.query),
                            }),
                            hits > 1
                                ? el('span', { class: 'search-result-count', text: `×${hits}` })
                                : null,
                        ],
                    ),
                )
                // 几十万字的长章节可能有上千处命中，全铺出来只会让面板自己卡住
                if (rows.length >= 200) break
            }
            searchResultHost.append(...rows)
        }

        /** 重新高亮并重排 */
        function refresh({ jumpToFirst }) {
            search.query = normalizeQuery(input.value)
            search.active = -1
            paintFlow()
            measure()
            page = Math.min(page, Math.max(0, pageCount - 1))
            applyPage(false)
            renderResults()
            if (jumpToFirst && hitNodes.length > 0) goToHit(0)
            else syncSearchUi()
        }

        // 输入去抖：每敲一个字都重排一次长章节会明显发涩，200ms 足够让人感觉不到延迟
        let inputTimer = null
        input.addEventListener('input', () => {
            clearTimeout(inputTimer)
            inputTimer = setTimeout(() => refresh({ jumpToFirst: true }), 200)
        })
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            stepHit(event.shiftKey ? -1 : 1)
        })

        openSheet(
            '本章内搜索',
            el('div', { class: 'settings' }, [
                el('div', { class: 'row' }, [
                    input,
                    el('button', {
                        class: 'btn ghost sm',
                        text: '清除',
                        onclick: () => {
                            clearTimeout(inputTimer)
                            input.value = ''
                            refresh({ jumpToFirst: false })
                            input.focus()
                        },
                    }),
                ]),
                el('div', { class: 'row' }, [
                    el('button', {
                        class: 'btn ghost sm',
                        text: '上一处',
                        onclick: () => stepHit(-1),
                    }),
                    el('button', {
                        class: 'btn ghost sm',
                        text: '下一处',
                        onclick: () => stepHit(1),
                    }),
                    el('div', { class: 'spacer' }),
                    searchStatusNode,
                ]),
                searchResultHost,
            ]),
            () => {
                clearTimeout(inputTimer)
                searchStatusNode = null
                searchResultHost = null
            },
        )

        renderResults()
        syncSearchUi()
        input.focus()
    }

    // ---- 书签 ----

    let bookmarks = []
    let bookmarksLoaded = false

    async function loadBookmarks(force = false) {
        if (bookmarksLoaded && !force) return bookmarks
        const data = await api(`/api/bookmarks?${paramsOf({ sourceId, bookUrl })}`)
        bookmarks = data.bookmarks ?? []
        bookmarksLoaded = true
        return bookmarks
    }

    /** 滚动位置占整章的比例。滚动模式没有页的概念，书签只能按比例记 */
    function scrollRatio() {
        const max = body.scrollHeight - body.clientHeight
        return max > 0 ? Math.min(1, Math.max(0, body.scrollTop / max)) : 0
    }

    /** 当前位置的正文片段，加书签时写进列表 —— 只写「第 37 章」看不出记住了什么 */
    function currentExcerpt() {
        const paragraphs = [...flow.children]
        if (paragraphs.length === 0) return ''
        const clip = (node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)

        if (mode === 'page') {
            const found = paragraphs.find((node) => columnOf(node) === page)
            return clip(found ?? paragraphs[0])
        }
        // 滚动模式没有列号可用，按滚动比例在段落里估个位置
        const ratio = scrollRatio()
        const at = Math.min(paragraphs.length - 1, Math.floor(ratio * paragraphs.length))
        return clip(paragraphs[at])
    }

    /**
     * 跳到这本书的某一处
     *
     * 书签记的是「第几章 + 位置」，所以两样都要带进路由：翻页模式带页码，
     * 滚动模式没有页，带百分比。页面重新加载后由开头的「恢复阅读位置」接手。
     */
    function jumpTo(chapterIndex, { pageIndex = 0, percent = 0 } = {}) {
        if (chapterIndex < 0 || chapterIndex >= book.chapters.length) return
        go(
            `#/read?${paramsOf({
                sourceId,
                url: bookUrl,
                name: book.name,
                author: book.author,
                index: chapterIndex,
                page: pageIndex,
                pos: percent > 0 ? percent.toFixed(4) : '',
            })}`,
        )
    }

    async function openBookmarks() {
        const addBtn = el('button', { class: 'btn primary sm' })
        const summary = el('p', { class: 'muted tiny' })
        const listHost = el('div', { class: 'bm-list' })
        let editingId = null

        function renderHead() {
            const here = bookmarks.find((item) => isSameSpot(item))
            addBtn.textContent = here ? '这一处已经有书签了' : '在当前位置加书签'
            addBtn.disabled = Boolean(here)
            summary.textContent =
                bookmarks.length === 0 ? '这本书还没有书签。' : `共 ${bookmarks.length} 处书签。`
        }

        /** 位置相同就是同一处，重复加只会让列表里出现两条一模一样的 */
        function isSameSpot(item) {
            if (item.chapterUrl !== chapter.url) return false
            if (mode === 'page') return item.pageIndex === page
            return Math.abs(item.percent - scrollRatio()) < 0.02
        }

        async function reload() {
            try {
                await loadBookmarks(true)
            } catch (err) {
                toast(`书签读不到：${err.message}`, 'error')
                bookmarks = []
            }
            renderHead()
            renderList()
        }

        function renderList() {
            if (bookmarks.length === 0) {
                listHost.replaceChildren()
                return
            }
            listHost.replaceChildren(
                ...bookmarks.map((item) => (editingId === item.id ? noteRow(item) : viewRow(item))),
            )
        }

        function viewRow(item) {
            return el('div', { class: 'bm-row' }, [
                el(
                    'button',
                    {
                        class: 'bm-main',
                        title: '跳到这一处',
                        onclick: () => {
                            closeSheets()
                            jumpTo(item.chapterIndex, {
                                pageIndex: item.pageIndex,
                                percent: item.percent,
                            })
                        },
                    },
                    [
                        el('div', { class: 'bm-head' }, [
                            el('span', {
                                class: 'bm-chapter',
                                text: item.chapterName || `第 ${item.chapterIndex + 1} 章`,
                            }),
                            el('span', { class: 'bm-time', text: relativeTime(item.createdAt) }),
                        ]),
                        item.excerpt
                            ? el('div', { class: 'bm-excerpt', text: item.excerpt })
                            : null,
                        item.note ? el('div', { class: 'bm-note', text: item.note }) : null,
                    ],
                ),
                el('button', {
                    class: 'icon-btn',
                    text: '✎',
                    title: '改备注',
                    onclick: () => {
                        editingId = item.id
                        renderList()
                    },
                }),
                el('button', {
                    class: 'icon-btn',
                    text: '×',
                    title: '删除',
                    onclick: () => remove(item),
                }),
            ])
        }

        function noteRow(item) {
            const input = el('input', {
                type: 'text',
                value: item.note,
                placeholder: '写点备注（可留空）',
            })
            const save = async () => {
                try {
                    await api('/api/bookmarks', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: item.id, note: input.value }),
                    })
                    editingId = null
                    await reload()
                } catch (err) {
                    toast(`备注没存上：${err.message}`, 'error')
                }
            }
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') void save()
                if (event.key === 'Escape') {
                    editingId = null
                    renderList()
                }
            })
            return el('div', { class: 'bm-row editing' }, [
                el('div', { class: 'bm-main' }, [input]),
                el('button', { class: 'btn primary sm', text: '保存', onclick: () => void save() }),
                el('button', {
                    class: 'btn ghost sm',
                    text: '取消',
                    onclick: () => {
                        editingId = null
                        renderList()
                    },
                }),
            ])
        }

        async function remove(item) {
            try {
                await api(`/api/bookmarks?${paramsOf({ id: item.id })}`, { method: 'DELETE' })
                toast('书签已删除')
                await reload()
            } catch (err) {
                toast(`删不掉：${err.message}`, 'error')
            }
        }

        addBtn.addEventListener('click', async () => {
            addBtn.disabled = true
            try {
                await api('/api/bookmarks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sourceId,
                        bookUrl,
                        chapterUrl: chapter.url,
                        chapterName: chapter.name,
                        chapterIndex: index,
                        pageIndex: mode === 'page' ? page : 0,
                        percent: mode === 'page' ? 0 : scrollRatio(),
                        excerpt: currentExcerpt(),
                    }),
                })
                toast('已加书签')
                await reload()
            } catch (err) {
                toast(`加书签失败：${err.message}`, 'error')
                addBtn.disabled = false
            }
        })

        /**
         * 导出这本书的书签清单
         *
         * 与账号页的「导出备份」不是一回事：那个是整份数据的 JSON（为了能导回来），
         * 这里要的是一份**能读**的清单（摘录 + 备注，按章节排），拿去贴进笔记软件。
         * 两种格式都给：Markdown 给人看，CSV 给表格（带 BOM，Excel 双击不乱码）。
         *
         * 用普通链接就够 —— 会话是 HttpOnly cookie，同源链接天然带得上，
         * 不必先 fetch 再拼 Blob（`Content-Disposition` 会让它走下载而不是跳走）。
         */
        const exportHref = (format) =>
            `/api/export/bookmarks?${paramsOf({ sourceId, bookUrl, format })}`

        openSheet(
            '书签',
            el('div', { class: 'settings' }, [
                summary,
                el('div', { class: 'row' }, [addBtn]),
                el('div', { class: 'row' }, [
                    el('a', {
                        class: 'btn ghost sm',
                        href: exportHref('md'),
                        text: '导出 .md',
                        title: '下载这本书的书签 Markdown 清单',
                    }),
                    el('a', {
                        class: 'btn ghost sm',
                        href: exportHref('csv'),
                        text: '导出 .csv',
                        title: '下载 CSV（带 BOM，Excel 双击可读）',
                    }),
                ]),
                listHost,
            ]),
            () => {
                editingId = null
            },
        )

        renderHead()
        listHost.replaceChildren(el('p', { class: 'muted tiny', text: '正在读取…' }))
        await reload()
    }

    function openSettings() {
        const rows = []

        rows.push(
            el('div', { class: 'setting-row' }, [
                el('span', { text: '阅读模式' }),
                el('div', { class: 'segmented' }, [
                    segmented('翻页', mode === 'page', () => {
                        if (!isText) {
                            toast('这一章不是文本，只能滚动阅读')
                            return
                        }
                        mode = 'page'
                        prefs.set('readerMode', 'page')
                        body.classList.add('paged')
                        closeSheets()
                        measure()
                        page = Math.min(page, pageCount - 1)
                        applyPage(false)
                    }),
                    segmented('滚动', mode === 'scroll', () => {
                        mode = 'scroll'
                        prefs.set('readerMode', 'scroll')
                        body.classList.remove('paged')
                        flow.style.transform = ''
                        pageLabel.textContent = ''
                        closeSheets()
                        measure()
                        void saveProgress()
                    }),
                ]),
            ]),
        )

        /**
         * 字号
         *
         * 这里的按钮不再自己写偏好、也不再重开面板：走 `setFontSize` 那条共用的路，
         * 它会顺手把这个数字刷新掉（`fontLabel`）。早先是「改偏好 → openSettings() 重建面板」，
         * 那个写法在捏合那类高频改动下会一直重建 DOM。
         */
        fontLabel = el('span', { class: 'muted', text: `${prefs.get('fontSize')}px` })
        rows.push(
            el('div', { class: 'setting-row' }, [
                el('span', { text: '字号' }),
                el('div', { class: 'segmented' }, [
                    segmented('A-', false, () =>
                        setFontSize(stepFontSize(prefs.get('fontSize'), -1), { notify: true }),
                    ),
                    fontLabel,
                    segmented('A+', false, () =>
                        setFontSize(stepFontSize(prefs.get('fontSize'), 1), { notify: true }),
                    ),
                ]),
            ]),
        )

        rows.push(
            el('div', { class: 'setting-row' }, [
                el('span', { text: '行距' }),
                el('div', { class: 'segmented' }, [
                    segmented('紧', false, () => setLineHeight(-1)),
                    segmented('中', false, () => setLineHeight(0)),
                    segmented('松', false, () => setLineHeight(1)),
                ]),
            ]),
        )

        rows.push(
            el('div', { class: 'setting-row' }, [
                el('span', { text: '主题' }),
                el('div', { class: 'segmented' }, [
                    segmented('浅色', prefs.get('theme') === 'light', () => {
                        prefs.set('theme', 'light')
                        openSettings()
                    }),
                    segmented('深色', prefs.get('theme') === 'dark', () => {
                        prefs.set('theme', 'dark')
                        openSettings()
                    }),
                ]),
            ]),
        )

        rows.push(
            el('div', { class: 'setting-row' }, [
                el('span', { text: '翻页动画' }),
                el('div', { class: 'segmented' }, [
                    segmented('覆盖', prefs.get('turnMode') === 'cover', () => {
                        prefs.set('turnMode', 'cover')
                        openSettings()
                    }),
                    segmented('滑动', prefs.get('turnMode') === 'slide', () => {
                        prefs.set('turnMode', 'slide')
                        openSettings()
                    }),
                    segmented('无', prefs.get('turnMode') === 'none', () => {
                        prefs.set('turnMode', 'none')
                        openSettings()
                    }),
                ]),
            ]),
        )

        // 背景色：九种纸色，只作用于阅读界面（`--paper` 只在阅读界面被消费）
        rows.push(
            el('div', { class: 'setting-block' }, [
                el('span', { class: 'setting-label', text: '背景色' }),
                el(
                    'div',
                    { class: 'papers' },
                    PAPERS.map((paper) => {
                        const active = (prefs.get('readerPaper') || 'auto') === paper
                        return el(
                            'button',
                            {
                                class: `paper-chip ${active ? 'active' : ''}`,
                                title: PAPER_LABELS[paper] ?? paper,
                                dataset: { paper },
                                onclick: () => {
                                    prefs.set('readerPaper', paper)
                                    openSettings()
                                },
                            },
                            [
                                el('span', { class: 'paper-dot' }),
                                el('span', { text: PAPER_LABELS[paper] ?? paper }),
                            ],
                        )
                    }),
                ),
            ]),
        )

        // 强调色：影响按钮、进度条这些点缀，与上面的背景色是两件事
        rows.push(
            el('div', { class: 'setting-block' }, [
                el('span', { class: 'setting-label', text: '强调色' }),
                el(
                    'div',
                    { class: 'papers' },
                    ACCENTS.map((accent) =>
                        el(
                            'button',
                            {
                                class: `paper-chip ${prefs.get('themeColor') === accent ? 'active' : ''}`,
                                onclick: () => {
                                    prefs.set('themeColor', accent)
                                    openSettings()
                                },
                            },
                            [
                                el('span', { class: `paper-dot accent-${accent}` }),
                                el('span', { text: ACCENT_LABELS[accent] ?? accent }),
                            ],
                        ),
                    ),
                ),
            ]),
        )

        const ruleCount = loadRules().filter((rule) => rule.enabled).length

        rows.push(
            el('div', { class: 'setting-row' }, [
                el('span', { text: '替换净化' }),
                el('div', { class: 'segmented' }, [
                    segmented(
                        ruleCount > 0 ? `已启用 ${ruleCount} 条` : '未设置',
                        ruleCount > 0,
                        () => openReplaceRules(),
                    ),
                ]),
            ]),
        )

        openSheet('显示设置', el('div', { class: 'settings' }, rows))
    }

    /**
     * 替换净化规则的编辑界面
     *
     * 对齐开源阅读的「替换净化」：列表 + 逐条启停 + 手写正则 + 预设一键添加 + 试跑。
     * 改动立刻写回 localStorage 并**重排当前章节** —— 用户改完马上能看到效果，
     * 而不是要退出阅读再进来。
     */
    function openReplaceRules() {
        const rules = loadRules()
        const listHost = el('div', { class: 'rule-list' })
        const form = el('div', { class: 'rule-form' })
        const previewHost = el('div', { class: 'rule-preview' })
        let editing = -1

        function commit(message) {
            saveRules(rules)
            render()
            void relayoutAfterPurify()
            if (message) toast(message)
        }

        function render() {
            if (rules.length === 0) {
                listHost.replaceChildren(
                    el('p', {
                        class: 'muted tiny center',
                        text: '还没有规则。可以从预设里加一条，或自己写。',
                    }),
                )
            } else {
                listHost.replaceChildren(
                    ...rules.map((rule, i) =>
                        el('div', { class: 'rule-row' }, [
                            el('label', { class: 'switch', title: '启用/停用' }, [
                                el('input', {
                                    type: 'checkbox',
                                    checked: rule.enabled,
                                    onchange: (event) => {
                                        rules[i] = makeRule({
                                            ...rule,
                                            enabled: event.target.checked,
                                        })
                                        commit()
                                    },
                                }),
                                el('span', { class: 'switch-track' }),
                            ]),
                            el('div', { class: 'rule-text' }, [
                                el('div', { class: 'rule-name', text: rule.name || '（未命名）' }),
                                el('code', { class: 'rule-pattern', text: rule.pattern }),
                                rule.replacement
                                    ? el('code', {
                                          class: 'rule-replacement',
                                          text: `→ ${rule.replacement}`,
                                      })
                                    : null,
                            ]),
                            el('button', {
                                class: 'icon-btn',
                                text: '✎',
                                title: '编辑',
                                onclick: () => {
                                    editing = i
                                    renderForm()
                                },
                            }),
                            el('button', {
                                class: 'icon-btn',
                                text: '×',
                                title: '删除',
                                onclick: () => {
                                    rules.splice(i, 1)
                                    editing = -1
                                    commit(`已删除规则`)
                                },
                            }),
                        ]),
                    ),
                )
            }
            renderPreview()
        }

        function renderPreview() {
            // 拿**原始正文**算，不是当前已经净化过的正文 —— 否则预览会显示
            // 「52 字 → 52 字」，看起来像规则没生效，实际是它已经被应用过了
            const text = String(content.content ?? '').trim()
            if (text.trim() === '') {
                previewHost.replaceChildren()
                return
            }
            const cleaned = applyRules(
                text,
                rules.filter((rule) => rule.enabled),
            )
            const before = text.length
            const after = cleaned.length
            previewHost.replaceChildren(
                el('p', {
                    class: 'muted tiny',
                    text: `本章原文 ${before} 字 → 净化后 ${after} 字（少 ${Math.max(0, before - after)} 字）`,
                }),
                el('p', {
                    class: 'muted tiny',
                    text: cleaned.slice(0, 90) + (cleaned.length > 90 ? '…' : ''),
                }),
            )
        }

        function renderForm() {
            const draft = editing >= 0 ? rules[editing] : makeRule()
            const nameInput = el('input', {
                type: 'text',
                placeholder: '规则名（随便写）',
                value: draft.name,
            })
            const patternInput = el('input', {
                type: 'text',
                placeholder: '正则或纯文本，例如 本章未完',
                value: draft.pattern,
            })
            const replacementInput = el('input', {
                type: 'text',
                placeholder: '替换成什么（留空即删除）',
                value: draft.replacement,
            })

            form.replaceChildren(
                el('div', { class: 'row' }, [nameInput]),
                el('div', { class: 'row' }, [patternInput]),
                el('div', { class: 'row' }, [replacementInput]),
                el('div', { class: 'row' }, [
                    el('button', {
                        class: 'btn primary sm',
                        text: editing >= 0 ? '保存修改' : '添加规则',
                        onclick: () => {
                            const rule = makeRule({
                                name: nameInput.value,
                                pattern: patternInput.value,
                                replacement: replacementInput.value,
                                enabled: true,
                            })
                            if (rule.pattern === '') {
                                toast('规则内容不能为空', 'error')
                                return
                            }
                            if (editing >= 0) rules[editing] = rule
                            else rules.push(rule)
                            editing = -1
                            commit()
                        },
                    }),
                    editing >= 0
                        ? el('button', {
                              class: 'btn ghost sm',
                              text: '取消编辑',
                              onclick: () => {
                                  editing = -1
                                  renderForm()
                              },
                          })
                        : null,
                    el('div', { class: 'spacer' }),
                    el('button', {
                        class: 'btn ghost sm',
                        text: '从预设添加',
                        onclick: () => openPresets(),
                    }),
                ]),
            )
        }

        function openPresets() {
            openSheet(
                '预设规则',
                el('div', { class: 'settings' }, [
                    el('p', {
                        class: 'muted tiny',
                        text: '点一条加进来，之后可以再改。都是常见站点广告与排版噪声。',
                    }),
                    ...PRESET_RULES.map((preset) =>
                        el(
                            'button',
                            {
                                class: 'rule-preset',
                                onclick: () => {
                                    rules.push(makeRule(preset))
                                    editing = -1
                                    commit(`已添加：${preset.name}`)
                                },
                            },
                            [
                                el('span', { class: 'rule-name', text: preset.name }),
                                el('code', { class: 'rule-pattern', text: preset.pattern }),
                            ],
                        ),
                    ),
                    el('button', {
                        class: 'btn ghost sm',
                        text: '返回',
                        onclick: () => openReplaceRules(),
                    }),
                ]),
            )
        }

        render()
        renderForm()

        openSheet(
            '替换净化',
            el('div', { class: 'settings' }, [
                el('p', {
                    class: 'muted tiny',
                    text: '规则按顺序作用于正文，只影响你这一端的显示，不改书源、不改服务器内容。',
                }),
                previewHost,
                listHost,
                el('div', {
                    class: 'rule-add-title',
                    text: editing >= 0 ? '编辑规则' : '新增规则',
                }),
                form,
                buildSyncBlock(),
                el('button', {
                    class: 'btn ghost sm',
                    text: '返回显示设置',
                    onclick: () => openSettings(),
                }),
            ]),
        )
    }

    /**
     * 「账号同步」这一块
     *
     * 两个动作，都要用户按下才动：上传 / 取回。**不自动同步**，也不「最后写入者胜」——
     * 自动同步意味着某个时刻要决定谁覆盖谁，而那个时刻用户看不见；
     * 规则是几十条手写正则，安静地丢掉另一次编辑是最贵的错（理由见 `src/data/replaceRules.ts`）。
     *
     * 所以撞版本时（服务端 409 会把现在那份附在响应体里）这里停下来，
     * 把两边各有多少条摊开，让用户选「取回」还是「我就是要覆盖」。
     *
     * 未登录时不发请求：`/api/replace` 的 401 会被全局当成「会话失效」，
     * 一路把用户推到登录页。这条分支现在**走不到** —— 整个应用（阅读界面在内）
     * 只在登录之后才渲染（见 `app.js` 的路由），走查时确认过。
     * 留着是因为它只花几行，而一旦以后放开匿名阅读，缺了它的表现是
     * 「一打开显示设置就被踢走」，与「读得好好的」差得很远。
     */
    function buildSyncBlock() {
        const statusHost = el('div', { class: 'rule-sync-status' })
        const actions = el('div', { class: 'row' })

        if (!currentUser()) {
            statusHost.replaceChildren(
                el('p', {
                    class: 'muted tiny',
                    text: '规则现在只存在这台设备上。登录之后可以上传到账号，别的设备就能取回。',
                }),
            )
            actions.replaceChildren(
                el('button', {
                    class: 'btn ghost sm',
                    text: '去登录',
                    onclick: () => go('#/login'),
                }),
            )
            return el('div', { class: 'rule-sync' }, [
                el('div', { class: 'rule-add-title', text: '账号同步' }),
                statusHost,
                actions,
            ])
        }

        const pushBtn = el('button', {
            class: 'btn ghost sm',
            text: '上传到账号',
            onclick: () => void push(loadSyncBase()),
        })
        const pullBtn = el('button', {
            class: 'btn ghost sm',
            text: '从账号取回',
            onclick: () => void pull(),
        })
        actions.replaceChildren(pushBtn, pullBtn)
        statusHost.replaceChildren(el('p', { class: 'muted tiny', text: '正在读取账号上的规则…' }))

        /** 账号上那一份。null = 还没读到 */
        let remote = null

        function busy(on, label) {
            pushBtn.disabled = on
            pullBtn.disabled = on
            pushBtn.textContent = label === 'push' && on ? '上传中…' : '上传到账号'
            pullBtn.textContent = label === 'pull' && on ? '取回中…' : '从账号取回'
        }

        function render() {
            if (remote === null) return
            const local = loadRules()
            const state = syncState(remote, loadSyncBase())
            if (state === 'remote-empty') {
                statusHost.replaceChildren(
                    el('p', {
                        class: 'muted tiny',
                        text: `账号上还没有这份规则。本机 ${describeRules(local)}，点「上传到账号」存过去。`,
                    }),
                )
                return
            }
            const when = relativeTime(remote.updatedAt)
            if (local.length === 0) {
                // 新设备上最常见的一步：本机是空的，账号上有，取回就完事
                statusHost.replaceChildren(
                    el('p', {
                        class: 'muted tiny',
                        text: `本机还没有规则，账号上有 ${describeRules(remote.rules)}（更新于${when}）。点「从账号取回」。`,
                    }),
                )
                return
            }
            statusHost.replaceChildren(
                el('p', {
                    class: 'muted tiny',
                    text:
                        `本机 ${describeRules(local)}，账号 ${describeRules(remote.rules)}（更新于${when}）。` +
                        (state === 'moved'
                            ? '账号上那份之后又变过，上传前会先让你确认。'
                            : '两边是同一个版本，可以放心上传。'),
                }),
            )
        }

        async function refresh() {
            try {
                remote = await fetchRemoteRules()
                render()
            } catch (err) {
                statusHost.replaceChildren(alertBox('error', '没能读取账号上的规则', err.message))
            }
        }

        /** 用账号那一份替换本机。调用方必须先确认过 */
        function takeRemote(server) {
            saveRules(server.rules)
            saveSyncBase(server.updatedAt)
            relayoutAfterPurify()
            // 本机那份换了，这个面板整个重建（列表、预览、按钮状态都跟着变）
            openReplaceRules()
            toast(`已取回 ${server.rules.length} 条规则`)
        }

        async function push(baseUpdatedAt) {
            busy(true, 'push')
            statusHost.replaceChildren()
            try {
                const result = await pushRemoteRules(loadRules(), baseUpdatedAt)
                saveSyncBase(result.updatedAt)
                remote = { rules: loadRules(), updatedAt: Number(result.updatedAt ?? 0) }
                toast(`已上传 ${remote.rules.length} 条规则到账号`)
                render()
            } catch (err) {
                if (err.code === 'replace_rules_conflict' && err.body?.server) {
                    showConflict(err.body.server)
                } else {
                    statusHost.replaceChildren(alertBox('error', '没能上传', err.message))
                }
            } finally {
                busy(false)
            }
        }

        async function pull() {
            busy(true, 'pull')
            statusHost.replaceChildren()
            try {
                const server = await fetchRemoteRules()
                remote = server
                if (server.updatedAt === 0) {
                    render()
                    return
                }
                const local = loadRules()
                if (
                    local.length > 0 &&
                    !confirm(
                        `用账号上那份（${describeRules(server.rules)}）替换本机这份（${describeRules(local)}）？` +
                            '本机的规则会被覆盖。',
                    )
                ) {
                    render()
                    return
                }
                takeRemote(server)
            } catch (err) {
                statusHost.replaceChildren(alertBox('error', '没能取回', err.message))
            } finally {
                busy(false)
            }
        }

        /** 撞版本：不替用户决定，把两边摆出来 */
        function showConflict(server) {
            const when = relativeTime(server.updatedAt)
            statusHost.replaceChildren(
                alertBox(
                    'error',
                    '账号上那份更新过',
                    `账号上现在有 ${describeRules(server.rules)}（更新于${when}）。直接上传会把它覆盖掉，所以先停下问你一句。`,
                ),
                el('div', { class: 'row' }, [
                    el('button', {
                        class: 'btn primary sm',
                        text: '改用账号那份',
                        title: '本机规则换成账号上那一份',
                        onclick: () => {
                            if (!confirm(`本机这${describeRules(loadRules())}会被替换掉，继续？`))
                                return
                            takeRemote(server)
                        },
                    }),
                    el('button', {
                        class: 'btn ghost sm',
                        text: '仍用本机这份覆盖',
                        title: '账号上那一份会被本机规则替换',
                        onclick: () => {
                            if (
                                !confirm(
                                    `账号上那${describeRules(server.rules)}会被本机规则覆盖，确定？`,
                                )
                            )
                                return
                            // 带着刚看到的版本当基准，这一次服务端会认（不是「强制」标志，是真的看过）
                            void push(server.updatedAt)
                        },
                    }),
                ]),
            )
        }

        void refresh()

        return el('div', { class: 'rule-sync' }, [
            el('div', { class: 'rule-add-title', text: '账号同步' }),
            statusHost,
            actions,
        ])
    }

    /** 净化规则改完之后重排当前章节，让效果立刻可见 */
    function relayoutAfterPurify() {
        // 净化结果变了，章内搜索的命中也要跟着重算 —— 旧的高亮节点已经随 DOM 一起没了
        chapterText = applyRules(String(content.content ?? '').trim(), loadRules()).trim()
        if (search.query !== '') search.active = -1
        paintFlow()
        requestAnimationFrame(() => {
            measure()
            page = Math.min(page, Math.max(0, pageCount - 1))
            applyPage(false)
            syncSearchUi()
        })
    }

    function setLineHeight(delta) {
        const current = Number(prefs.get('lineHeight'))
        const next = delta < 0 ? 1.5 : delta === 0 ? 1.85 : 2.1
        prefs.set('lineHeight', current === next ? next : next)
        openSettings()
        relayout()
    }

    /** 改了字号/行距之后重新分页，并尽量停在原来的位置 */
    function relayout() {
        const ratio = pageCount > 0 ? page / pageCount : 0
        measure()
        page = Math.min(pageCount - 1, Math.round(ratio * pageCount))
        applyPage(false)
    }

    shell.append(sheetHost)

    // ---- 起手 ----
    // 布局完成后再量：此刻 body 才拿到真实高度
    requestAnimationFrame(() => {
        measure()
        if (mode === 'page') {
            if (routePage === 'last') {
                page = pageCount - 1
            } else if (routePage !== null && routePage !== '') {
                // 地址里带了具体页码（从书签跳过来）—— 它比服务器上的进度更明确
                page = Math.min(Math.max(0, Number(routePage) || 0), pageCount - 1)
            } else {
                page = Math.min(savedPage ?? 0, pageCount - 1)
            }
            applyPage(false)
        } else {
            pageLabel.textContent = ''
            updateProgressBar(1)
            // 滚动模式没有页的概念，服务器上也只记了「第几章」，
            // 因此只有书签带过来的百分比能恢复位置，否则就是从这一章开头开始
            if (Number.isFinite(routePos) && routePos > 0) {
                body.scrollTop = Math.round((body.scrollHeight - body.clientHeight) * routePos)
            }
        }
        void saveProgress()
    })

    void append
}

function segmented(label, active, onclick) {
    return el('button', {
        class: `segment ${active ? 'active' : ''}`,
        text: label,
        onclick,
    })
}

/** 图片 / 音频 / 下载的渲染（与文本正文是三种不同的东西，不能一视同仁） */
function renderMedia(payload) {
    if (payload.kind === 'images') {
        const images = payload.images ?? []
        if (images.length === 0) {
            return alertBox(
                'warn',
                '这一话没有取到图片',
                '通常是书源的 content 规则没匹配到图片地址。',
            )
        }
        const box = el('div', { class: 'comic' })
        images.forEach((image, i) => {
            box.append(
                el('img', {
                    class: 'comic-page',
                    src: image.proxyUrl,
                    alt: `第 ${i + 1} 页`,
                    loading: 'lazy',
                    onerror: (event) =>
                        event.target.replaceWith(
                            el('div', { class: 'comic-failed', text: `第 ${i + 1} 张加载失败` }),
                        ),
                }),
            )
        })
        box.append(el('div', { class: 'comic-meta', text: `共 ${images.length} 张` }))
        return box
    }

    if (payload.kind === 'audio') {
        const box = el('div', { class: 'audio-box' })
        if (!payload.audio?.proxyUrl) {
            return alertBox('warn', '没有取到音频地址', '书源的正文规则没匹配到可播放的直链。')
        }
        box.append(
            el('audio', {
                class: 'audio-player',
                controls: true,
                preload: 'metadata',
                src: payload.audio.proxyUrl,
            }),
            el('p', {
                class: 'muted tiny',
                text: '播放由本站代取；拖进度条依赖上游支持 Range。',
            }),
        )
        return box
    }

    const downloads = payload.downloads ?? []
    if (downloads.length === 0) {
        return alertBox('warn', '没有取到下载地址', '书源的 downloadUrls 规则没匹配到地址。')
    }
    const box = el('div', { class: 'downloads' })
    downloads.forEach((item, i) => {
        box.append(
            el('a', {
                class: 'btn dl',
                href: item.proxyUrl,
                download: item.name || '',
                text: item.name || `下载 ${i + 1}`,
            }),
        )
    })
    box.append(el('p', { class: 'muted tiny', text: '下载由本站代取，因此不受上游防盗链影响。' }))
    return box
}
