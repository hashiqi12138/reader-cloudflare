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
 */

import { alertBox, api, append, el, go, paramsOf, prefs, skeletonBlock, toast } from './core.js'

/** 一章的目录缓存：翻页时不该重新拉目录 */
let bookCache = null

export async function viewRead(host) {
    const route = new URLSearchParams(location.hash.split('?')[1] ?? '')
    const sourceId = route.get('sourceId') ?? ''
    const bookUrl = route.get('url') ?? ''
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

    const shell = el('div', { class: 'reader-shell' }, [
        el('header', { class: 'reader-top' }, [
            el('button', {
                class: 'icon-btn',
                text: '‹',
                title: '返回',
                onclick: () => history.back(),
            }),
            titleNode,
            el('div', { class: 'spacer' }),
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
        ]),
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

    // ---- 恢复阅读位置 ----
    let restoredPage = 0
    let savedPage = null
    try {
        const data = await api(`/api/progress?${paramsOf({ sourceId, bookUrl })}`)
        if (data.progress && data.progress.chapterIndex === index)
            savedPage = data.progress.pageIndex ?? 0
    } catch {
        /* 取不到进度不影响阅读，按第一页开始 */
    }

    // ---- 渲染正文 ----
    const flow = el('div', { class: 'reader-flow' })
    let pageCount = 1
    let page = 0

    if (isText) {
        const text = String(content.content ?? '').trim()
        if (text === '') {
            flow.append(
                alertBox(
                    'warn',
                    '这一章取到的是空正文',
                    '通常是书源的 content 规则没匹配到内容，或站点改版了。',
                ),
            )
        }
        for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (trimmed !== '') flow.append(el('p', { text: trimmed }))
        }
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

    // ---- 手势与快捷键 ----

    let touchStart = null

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
            const touch = event.changedTouches[0]
            touchStart = { x: touch.clientX, y: touch.clientY, at: Date.now() }
        },
        { passive: true },
    )
    body.addEventListener(
        'touchend',
        (event) => {
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
        } else if (event.key === 'Escape') {
            closeSheets()
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

    function closeSheets() {
        sheetHost.hidden = true
        sheetHost.replaceChildren()
    }

    function openSheet(title, content) {
        sheetHost.replaceChildren(
            el('div', { class: 'sheet-backdrop', onclick: closeSheets }),
            el('section', { class: 'sheet' }, [
                el('header', {}, [
                    el('strong', { text: title }),
                    el('div', { class: 'spacer' }),
                    el('button', { class: 'icon-btn', text: '×', onclick: closeSheets }),
                ]),
                el('div', { class: 'sheet-body' }, [content]),
            ]),
        )
        sheetHost.hidden = false
    }

    function openToc() {
        const list = el(
            'ul',
            { class: 'chapter-list' },
            book.chapters.map((item, i) =>
                el('li', { dataset: { current: String(i === index) } }, [
                    el('button', {
                        class: 'chapter-link',
                        text: `${i + 1}. ${item.name}`,
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

        rows.push(
            el('div', { class: 'setting-row' }, [
                el('span', { text: '字号' }),
                el('div', { class: 'segmented' }, [
                    segmented('A-', false, () => {
                        prefs.set('fontSize', Number(prefs.get('fontSize')) - 1)
                        openSettings()
                        relayout()
                    }),
                    el('span', { class: 'muted', text: `${prefs.get('fontSize')}px` }),
                    segmented('A+', false, () => {
                        prefs.set('fontSize', Number(prefs.get('fontSize')) + 1)
                        openSettings()
                        relayout()
                    }),
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
                el('span', { text: '纸色' }),
                el(
                    'div',
                    { class: 'swatches' },
                    ['amber', 'green', 'blue', 'rose'].map((color) =>
                        el('button', {
                            class: `swatch ${color} ${prefs.get('themeColor') === color ? 'active' : ''}`,
                            title: color,
                            onclick: () => {
                                prefs.set('themeColor', color)
                                openSettings()
                            },
                        }),
                    ),
                ),
            ]),
        )

        openSheet('显示设置', el('div', { class: 'settings' }, rows))
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
            const last = route.get('page') === 'last'
            page = last ? pageCount - 1 : Math.min(savedPage ?? restoredPage, pageCount - 1)
            applyPage(false)
        } else {
            pageLabel.textContent = ''
            updateProgressBar(1)
            if (savedPage) {
                // 滚动模式没有页概念，按比例粗略回到上次的位置
                body.scrollTop = Math.round(body.scrollHeight * 0.0)
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
