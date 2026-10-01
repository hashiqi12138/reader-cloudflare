/**
 * 图片地址提取的单元测试
 *
 * 这里是「图片源读不出来」的修复核心，所以边界逐条钉住：
 * 地址怎么挑、顺序会不会乱、伪地址会不会被当成真地址。
 *
 * 各种 `<img>` 的写法全部取自真实书源（包子漫画、天脉漫画、禁漫大王、老司机），
 * 不是凭空想的例子。
 *
 * 只测纯解析：它旁边的 media.ts 会连带引入沙箱（也就连带引入 WASM），
 * 而单元测试跑在 Node 里、没有 workerd 的 WASM 加载能力。
 * 网络那部分（翻页、媒体代取）交给冒烟测试，那里是真实 HTTP。
 */

import { describe, expect, it } from 'vitest'

import { extractImageLinks, isPlaceholder, pickImageUrl } from '../src/legado/mediaLinks'

const BASE = 'https://comic.example.com/chapter/100/1'

/** 按给定基准地址补全，和引擎里的 resolveUrl 同语义 */
const resolveWith =
    (base: string) =>
    (candidate: string): string => {
        try {
            return new URL(candidate.trim(), base).href
        } catch {
            return candidate.trim()
        }
    }

const images = (raw: string, base = BASE): string[] =>
    extractImageLinks(raw, resolveWith(base)).map((link) => link.url)

describe('图片地址提取', () => {
    it('取 <img> 的 src', () => {
        expect(images('<img src="/a/1.jpg"><img src="/a/2.jpg">')).toEqual([
            'https://comic.example.com/a/1.jpg',
            'https://comic.example.com/a/2.jpg',
        ])
    })

    it('懒加载站点的真地址在 data-src 上，优先于 src', () => {
        // src 放 1x1 透明 gif 是漫画站的标准写法（省流量）
        const raw =
            '<img src="/static/blank.gif" data-src="/media/real-1.jpg">' +
            '<img src="data:image/gif;base64,R0lGODlh" data-src="/media/real-2.jpg">'
        expect(images(raw)).toEqual([
            'https://comic.example.com/media/real-1.jpg',
            'https://comic.example.com/media/real-2.jpg',
        ])
    })

    it('占位图不会被当成真图片', () => {
        // 只有占位图的页面应当返回空，而不是「一堆能加载出来的空白图」
        expect(images('<img src="/img/loading.gif"><img src="/img/placeholder.png">')).toEqual([])
        expect(
            images('<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAA">'),
        ).toEqual([])
    })

    it('裸地址（没有 <img> 包裹）也能认出来', () => {
        // 真实书源里 `#m_r_imgbox_0 img@data-src` 取出来就是一串裸地址
        expect(images('https://cdn.x.com/p1.jpg\nhttps://cdn.x.com/p2.jpg')).toEqual([
            'https://cdn.x.com/p1.jpg',
            'https://cdn.x.com/p2.jpg',
        ])
    })

    it('**保持原有顺序**：混合标签与裸地址时不重排', () => {
        // 漫画的页序就是阅读顺序，顺序错了等于把书撕了重排
        const raw = [
            '<img data-src="https://cdn.x.com/1.jpg">',
            'https://cdn.x.com/2.jpg',
            '<img data-src="https://cdn.x.com/3.jpg">',
        ].join('\n')
        expect(images(raw)).toEqual([
            'https://cdn.x.com/1.jpg',
            'https://cdn.x.com/2.jpg',
            'https://cdn.x.com/3.jpg',
        ])
    })

    it('协议相对地址按当前页的协议补全', () => {
        expect(images('<img data-src="//cdn.x.com/a.jpg">')).toEqual(['https://cdn.x.com/a.jpg'])
    })

    it('相对地址按**自己那一页**补全', () => {
        // 翻页后图片常挂在更深一层的目录下，用第一页的地址去补会得到错误路径
        expect(images('<img src="p2.jpg">', 'https://comic.example.com/chapter/100/2')).toEqual([
            'https://comic.example.com/chapter/100/p2.jpg',
        ])
    })

    it('重复地址只保留第一次出现的位置', () => {
        expect(
            images(
                '<img src="/a.jpg">\n<img src="/a.jpg">\n<img src="/b.jpg">\n<img src="/a.jpg">',
            ),
        ).toEqual(['https://comic.example.com/a.jpg', 'https://comic.example.com/b.jpg'])
    })

    it('标签属性乱序、单引号、无引号都能解析', () => {
        const raw = [
            `<img class="x" data-src='/q/1.jpg' alt="a">`,
            '<img alt=b data-src=/q/2.jpg>',
        ].join('')
        expect(images(raw)).toEqual([
            'https://comic.example.com/q/1.jpg',
            'https://comic.example.com/q/2.jpg',
        ])
    })

    it('srcset 兜底取第一个候选', () => {
        expect(images('<img srcset="/s/1.jpg 1x, /s/1@2x.jpg 2x">')).toEqual([
            'https://comic.example.com/s/1.jpg',
        ])
    })

    it('非网络地址（javascript: / blob: / about:）一律丢弃', () => {
        expect(
            images('<img src="javascript:void(0)"><img src="blob:x"><img src="about:blank">'),
        ).toEqual([])
    })

    it('标签内部含多个属性时不把属性名当地址', () => {
        expect(images('<img width=100 height=200 src="/ok.jpg">')).toEqual([
            'https://comic.example.com/ok.jpg',
        ])
    })

    it('图片标签里的相对地址不会被重复匹配一次', () => {
        // 标签分支先匹配就吃掉整个标签，里面的 src 不该再被裸地址分支抓一遍
        expect(images('<img src="/only.jpg">')).toHaveLength(1)
    })

    it('空输入与纯文字返回空', () => {
        expect(images('')).toEqual([])
        expect(images('本章还没有图片，请稍后再来')).toEqual([])
    })
})

describe('占位图与属性取值', () => {
    it('isPlaceholder 认得常见的占位文件名与内联地址', () => {
        for (const bad of [
            '',
            '  ',
            'data:image/gif;base64,R0lGODlh',
            'javascript:;',
            'blob:https://x/y',
            'about:blank',
            '/img/blank.gif',
            'https://cdn.x.com/img/loading.png',
            '/static/placeholder.jpg',
            '/s/spacer.gif',
            'https://x/1x1/pixel.png',
            '/img/grey.gif',
        ]) {
            expect(isPlaceholder(bad), bad).toBe(true)
        }
    })

    it('isPlaceholder 不误伤真图片', () => {
        for (const good of [
            'https://cdn.x.com/media/1.jpg',
            '/media/pixel-art.png',
            '/media/loading-dock.jpg',
            '/media/nonexistent.webp',
        ]) {
            expect(isPlaceholder(good), good).toBe(false)
        }
    })

    it('同名属性重复出现时取第一个', () => {
        expect(pickImageUrl('<img src="/first.jpg" src="/second.jpg">')).toBe('/first.jpg')
    })

    it('没有可用属性时返回空串', () => {
        expect(pickImageUrl('<img width="10">')).toBe('')
        expect(pickImageUrl('<img src="/loading.gif">')).toBe('')
    })
})
