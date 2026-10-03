import { describe, expect, it } from 'vitest'

import {
    BACKUP_KIND,
    BACKUP_VERSION,
    buildBackup,
    parseBackup,
    type BackupShelfRecord,
} from '../src/data/transfer'

/**
 * 备份文件的格式与校验
 *
 * 这里只测**纯函数**：`buildBackup` 组文件、`parseBackup` 认文件。
 * 合并那一步必须真库才验得准（`ON CONFLICT` 的行为、`meta.changes` 的计数），
 * 放在 `smoke` 第 7c 段。
 *
 * 校验刻意**不宽容**，所以下面的用例大半是"坏文件必须被拒"：
 * 放宽的结果是坏数据进库，而它在界面里和正常数据长得一模一样 ——
 * 那是静默错数据，比导入失败难查得多。
 */

const shelfRecord = (over: Partial<BackupShelfRecord> = {}): BackupShelfRecord => ({
    sourceId: 'builtin:fixture-css',
    bookUrl: 'http://127.0.0.1:8787/fixture/book/1',
    name: '测试小说·甲',
    author: '作者甲',
    coverUrl: '',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
})

const goodFile = () => ({
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: 1_700_000_000_000,
    counts: { shelf: 1, progress: 0, bookmarks: 0 },
    shelf: [shelfRecord()],
    progress: [],
    bookmarks: [],
})

describe('buildBackup', () => {
    it('写死 kind 与 version，计数按实际条数算', () => {
        const file = buildBackup(
            { shelf: [shelfRecord(), shelfRecord()], progress: [], bookmarks: [] },
            1234,
        )
        expect(file.kind).toBe(BACKUP_KIND)
        expect(file.version).toBe(BACKUP_VERSION)
        expect(file.exportedAt).toBe(1234)
        expect(file.counts).toEqual({ shelf: 2, progress: 0, bookmarks: 0 })
    })

    it('记录原样带出（不在导出这一步做裁剪）', () => {
        const file = buildBackup({
            shelf: [shelfRecord({ author: '' })],
            progress: [],
            bookmarks: [],
        })
        expect(file.shelf[0]?.author).toBe('')
    })
})

describe('parseBackup：导出的文件必须能导回来', () => {
    it('buildBackup → JSON → parseBackup 走一圈，记录一字不差', () => {
        const file = buildBackup(
            {
                shelf: [shelfRecord()],
                progress: [
                    {
                        sourceId: 'a',
                        bookUrl: '/b',
                        chapterUrl: '/c',
                        chapterName: '第一章',
                        chapterIndex: 3,
                        pageIndex: 2,
                        updatedAt: 999,
                    },
                ],
                bookmarks: [
                    {
                        id: 'bm-1',
                        sourceId: 'a',
                        bookUrl: '/b',
                        chapterUrl: '/c',
                        chapterName: '第一章',
                        chapterIndex: 3,
                        pageIndex: 2,
                        percent: 0.4,
                        excerpt: '摘录',
                        note: '备注',
                        createdAt: 1000,
                        updatedAt: 1001,
                    },
                ],
            },
            2_000,
        )

        const parsed = parseBackup(JSON.parse(JSON.stringify(file)))
        expect(parsed.exportedAt).toBe(2_000)
        expect(parsed.shelf).toEqual(file.shelf)
        expect(parsed.progress).toEqual(file.progress)
        expect(parsed.bookmarks).toEqual(file.bookmarks)
    })

    it('计数以文件里的数组为准，不信文件自己写的 counts', () => {
        const file = { ...goodFile(), counts: { shelf: 999, progress: 999, bookmarks: 999 } }
        const parsed = parseBackup(file)
        expect(parsed.counts).toEqual({ shelf: 1, progress: 0, bookmarks: 0 })
    })

    it('缺省的可选字段补成空串 / 0', () => {
        const parsed = parseBackup({
            ...goodFile(),
            shelf: [{ sourceId: 'a', bookUrl: '/b', name: '书' }],
        })
        expect(parsed.shelf[0]).toEqual({
            sourceId: 'a',
            bookUrl: '/b',
            name: '书',
            author: '',
            coverUrl: '',
            createdAt: 0,
            updatedAt: 0,
        })
    })
})

describe('parseBackup：认不出来的文件要当场说清楚', () => {
    it('不是对象 / 不是 JSON 对象', () => {
        expect(() => parseBackup(null)).toThrow(/必须是一个 JSON 对象/)
        expect(() => parseBackup([1, 2])).toThrow(/必须是一个 JSON 对象/)
        expect(() => parseBackup('{}')).toThrow(/必须是一个 JSON 对象/)
    })

    it('没有 kind —— 比如把书源合集当备份导进来', () => {
        expect(() => parseBackup([{ bookSourceName: '某源' }])).toThrow(/必须是一个 JSON 对象/)
        expect(() => parseBackup({ sources: [] })).toThrow(/不是本应用的备份文件/)
    })

    it('版本比当前新：说清楚，而不是猜着导入', () => {
        expect(() => parseBackup({ ...goodFile(), version: BACKUP_VERSION + 1 })).toThrow(
            /更新的版本/,
        )
        expect(() => parseBackup({ ...goodFile(), version: 0 })).toThrow(/缺少版本号/)
        expect(() => parseBackup({ ...goodFile(), version: undefined })).toThrow(/缺少版本号/)
    })

    it('三份记录必须是数组', () => {
        expect(() => parseBackup({ ...goodFile(), shelf: {} })).toThrow(/shelf 必须是数组/)
        expect(() => parseBackup({ ...goodFile(), progress: 'x' })).toThrow(/progress 必须是数组/)
        expect(() => parseBackup({ ...goodFile(), bookmarks: 3 })).toThrow(/bookmarks 必须是数组/)
    })

    it('单条记录出错时指出是第几条、哪个字段', () => {
        expect(() =>
            parseBackup({
                ...goodFile(),
                shelf: [shelfRecord(), { sourceId: 'a', name: '缺地址' }],
            }),
        ).toThrow(/第 2 条记录的 bookUrl/)
    })

    it('必填字段为空串、或类型不对，都不放过', () => {
        expect(() =>
            parseBackup({ ...goodFile(), shelf: [shelfRecord({ bookUrl: '  ' })] }),
        ).toThrow(/bookUrl/)
        expect(() =>
            parseBackup({ ...goodFile(), shelf: [{ ...shelfRecord(), name: 42 }] }),
        ).toThrow(/name/)
    })

    it('时间戳为负、比例为负或超过 1，都拒', () => {
        expect(() =>
            parseBackup({ ...goodFile(), shelf: [shelfRecord({ createdAt: -1 })] }),
        ).toThrow(/createdAt/)
        const bookmark = {
            id: 'bm',
            sourceId: 'a',
            bookUrl: '/b',
            chapterUrl: '/c',
            percent: 1.5,
        }
        expect(() => parseBackup({ ...goodFile(), bookmarks: [bookmark] })).toThrow(/percent/)
        expect(() =>
            parseBackup({ ...goodFile(), bookmarks: [{ ...bookmark, percent: -0.1 }] }),
        ).toThrow(/percent/)
    })

    it('超长字段被拒（备份是外部输入，比写入路径更需要对长度设防）', () => {
        expect(() =>
            parseBackup({ ...goodFile(), shelf: [shelfRecord({ author: '甲'.repeat(201) })] }),
        ).toThrow(/author/)
        expect(() =>
            parseBackup({
                ...goodFile(),
                bookmarks: [
                    {
                        id: 'bm',
                        sourceId: 'a',
                        bookUrl: '/b',
                        chapterUrl: '/c',
                        note: '字'.repeat(501),
                    },
                ],
            }),
        ).toThrow(/note/)
    })
})
