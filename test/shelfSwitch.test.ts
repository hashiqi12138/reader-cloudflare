/*
 * 换源的数据层（`src/data/library.ts` 的 `switchShelfSource`）
 *
 * 这一条没法只靠纯函数测：换源动的是**主键** —— 书架行与进度行的键都是
 * `bookKey = 书源 id + 换行 + 书籍地址`（见 `data/types.ts`）—— 所以它不是「改一个字段」，
 * 而是「新的那行插进去、旧的那行连同进度删掉」，还得保住 `created_at`、
 * 把进度挪到新键上、目标源已有这本书时并进去。全是 SQL 行为。
 *
 * 所以用**真的 SQLite**：`node:sqlite`（见 `platform/node.ts`）加**真的迁移文件**，
 * 与自建那份启动时做的事一模一样。手抄一份 schema 就等于白测 ——
 * 迁移里改了一列，测试还会照着手抄的老样子过。
 *
 * 界面那一侧（面板、候选、章名映射）在 `test/switchSource.test.mjs`；
 * 端到端那一趟在 `scripts/smoke.mjs`。
 */

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
    addToShelf,
    getProgress,
    listShelf,
    saveProgress,
    switchShelfSource,
} from '../src/data/library'
import { bookKey } from '../src/data/types'
import { nodeEnv, type NodeAppEnv } from '../src/platform/node'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const OWNER = 'user@example.com'

const opened: NodeAppEnv[] = []

/** 一个跑完真实迁移的临时库 */
function fresh(): NodeAppEnv {
    const dir = mkdtempSync(join(tmpdir(), 'rc-switch-'))
    const env = nodeEnv({ dbPath: join(dir, 'test.sqlite'), publicRoot: dir })
    const files = readdirSync(MIGRATIONS)
        .filter((one) => one.endsWith('.sql'))
        .sort()
    for (const file of files) env.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
    opened.push(env)
    return env
}

afterEach(() => {
    for (const env of opened.splice(0)) env.close()
})

/** 一条书架行 + 一条进度，返回旧键（大多数用例的起点） */
async function seed(env: NodeAppEnv, over: { sourceId?: string; bookUrl?: string } = {}) {
    const sourceId = over.sourceId ?? 'user:https://old.example.com'
    const bookUrl = over.bookUrl ?? 'https://old.example.com/book/1'
    await addToShelf(env.DB, OWNER, {
        sourceId,
        bookUrl,
        name: '斗破苍穹',
        author: '天蚕土豆',
        coverUrl: 'https://old.example.com/cover.jpg',
    })
    return bookKey(sourceId, bookUrl)
}

const target = {
    toSourceId: 'user:https://new.example.com',
    toBookUrl: 'https://new.example.com/book/9',
    name: '斗破苍穹',
    author: '天蚕土豆',
    coverUrl: 'https://new.example.com/cover.jpg',
}

describe('switchShelfSource', () => {
    it('书架行挪到新键上，旧的没了，加入时间保持不变', async () => {
        const env = fresh()
        const from = await seed(env)
        const before = (await listShelf(env.DB, OWNER))[0]!
        // 让 created_at 落在过去，好确认它没被改成「现在」
        await env.DB.prepare('UPDATE shelf SET created_at = ? WHERE owner = ? AND book_key = ?')
            .bind(1000, OWNER, from)
            .run()

        const { entry, movedProgress } = await switchShelfSource(env.DB, OWNER, {
            fromSourceId: 'user:https://old.example.com',
            fromBookUrl: 'https://old.example.com/book/1',
            ...target,
        })

        expect(movedProgress).toBe(false)
        expect(entry.bookKey).toBe(bookKey(target.toSourceId, target.toBookUrl))
        expect(entry.sourceId).toBe(target.toSourceId)
        expect(entry.bookUrl).toBe(target.toBookUrl)
        expect(entry.coverUrl).toBe(target.coverUrl)
        // 加入时间是「什么时候加入书架」，换源不该改它
        expect(entry.createdAt).toBe(1000)
        expect(entry.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)

        // 旧行没了，且整个书架只剩一行（不能留下两行同一本书）
        const rows = await listShelf(env.DB, OWNER)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.bookKey).toBe(entry.bookKey)
    })

    it('给了章节就跟着走，旧键的进度一起清掉', async () => {
        const env = fresh()
        const from = await seed(env)
        await saveProgress(env.DB, OWNER, {
            sourceId: 'user:https://old.example.com',
            bookUrl: 'https://old.example.com/book/1',
            chapterUrl: 'https://old.example.com/book/1/c/42',
            chapterName: '第四十二章 大比开始',
            chapterIndex: 41,
            pageIndex: 3,
        })

        const chapter = {
            url: 'https://new.example.com/book/9/c/40',
            name: '第四十二章 大比开始',
            index: 40,
            pageIndex: 3,
        }
        const { movedProgress } = await switchShelfSource(env.DB, OWNER, {
            fromSourceId: 'user:https://old.example.com',
            fromBookUrl: 'https://old.example.com/book/1',
            ...target,
            chapter,
        })

        expect(movedProgress).toBe(true)
        const moved = await getProgress(env.DB, OWNER, bookKey(target.toSourceId, target.toBookUrl))
        expect(moved?.chapterUrl).toBe(chapter.url)
        expect(moved?.chapterIndex).toBe(40)
        expect(moved?.pageIndex).toBe(3)
        // 旧键上不能留下一条「读不到书」的进度
        expect(await getProgress(env.DB, OWNER, from)).toBeUndefined()

        // 书架列表里带出来的「读到哪一章」也应该是新的那一章
        const rows = await listShelf(env.DB, OWNER)
        expect(rows[0]!.chapterName).toBe(chapter.name)
    })

    it('对不上章节（不给 chapter）时不写进度，旧进度也不留', async () => {
        const env = fresh()
        const from = await seed(env)
        await saveProgress(env.DB, OWNER, {
            sourceId: 'user:https://old.example.com',
            bookUrl: 'https://old.example.com/book/1',
            chapterUrl: 'https://old.example.com/book/1/c/42',
            chapterName: '第四十二章',
            chapterIndex: 41,
        })

        const { movedProgress, entry } = await switchShelfSource(env.DB, OWNER, {
            fromSourceId: 'user:https://old.example.com',
            fromBookUrl: 'https://old.example.com/book/1',
            ...target,
        })

        expect(movedProgress).toBe(false)
        expect(await getProgress(env.DB, OWNER, entry.bookKey)).toBeUndefined()
        expect(await getProgress(env.DB, OWNER, from)).toBeUndefined()
    })

    it('目标源上本来就有这本书：并成一行，不是两行', async () => {
        const env = fresh()
        await seed(env)
        // 用户两个源都加过书架，而且在新源上已经读了一段
        await addToShelf(env.DB, OWNER, {
            sourceId: target.toSourceId,
            bookUrl: target.toBookUrl,
            name: '斗破苍穹',
            author: '天蚕土豆',
            coverUrl: '',
        })
        await saveProgress(env.DB, OWNER, {
            sourceId: target.toSourceId,
            bookUrl: target.toBookUrl,
            chapterUrl: 'https://new.example.com/book/9/c/1',
            chapterName: '第一章',
            chapterIndex: 0,
        })

        const { entry, movedProgress } = await switchShelfSource(env.DB, OWNER, {
            fromSourceId: 'user:https://old.example.com',
            fromBookUrl: 'https://old.example.com/book/1',
            ...target,
            chapter: {
                url: 'https://new.example.com/book/9/c/40',
                name: '第四十二章',
                index: 40,
            },
        })

        expect(movedProgress).toBe(true)
        const rows = await listShelf(env.DB, OWNER)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.bookKey).toBe(entry.bookKey)
        // 「换过去接着读」是这一步的意图：位置按搬过来的那一章，而不是目标原来那个
        const moved = await getProgress(env.DB, OWNER, entry.bookKey)
        expect(moved?.chapterIndex).toBe(40)
    })

    it('封面留空时不把旧封面带过去（那会是一张别的书源的图）', async () => {
        const env = fresh()
        await seed(env)
        const { entry } = await switchShelfSource(env.DB, OWNER, {
            fromSourceId: 'user:https://old.example.com',
            fromBookUrl: 'https://old.example.com/book/1',
            ...target,
            coverUrl: '',
        })
        expect(entry.coverUrl).toBe('')
    })

    it('不在书架里 → 404，且不会凭空写出一行', async () => {
        const env = fresh()
        await seed(env)
        await expect(
            switchShelfSource(env.DB, OWNER, {
                fromSourceId: 'user:https://old.example.com',
                fromBookUrl: 'https://old.example.com/book/别的',
                ...target,
            }),
        ).rejects.toMatchObject({ status: 404, code: 'shelf_entry_not_found' })
        expect(await listShelf(env.DB, OWNER)).toHaveLength(1)
    })

    it('换到同一个地址 → 400（这一步不该发生，宁可报错也不静默原地不动）', async () => {
        const env = fresh()
        await seed(env)
        await expect(
            switchShelfSource(env.DB, OWNER, {
                fromSourceId: 'user:https://old.example.com',
                fromBookUrl: 'https://old.example.com/book/1',
                toSourceId: 'user:https://old.example.com',
                toBookUrl: 'https://old.example.com/book/1',
                name: '斗破苍穹',
            }),
        ).rejects.toMatchObject({ status: 400, code: 'shelf_switch_same_target' })
    })

    it('两个用户的同名书互不影响（owner 那一条不能漏）', async () => {
        const env = fresh()
        const from = await seed(env)
        await addToShelf(env.DB, 'other@example.com', {
            sourceId: 'user:https://old.example.com',
            bookUrl: 'https://old.example.com/book/1',
            name: '斗破苍穹',
        })

        await switchShelfSource(env.DB, OWNER, {
            fromSourceId: 'user:https://old.example.com',
            fromBookUrl: 'https://old.example.com/book/1',
            ...target,
        })

        const mine = await listShelf(env.DB, OWNER)
        const theirs = await listShelf(env.DB, 'other@example.com')
        expect(mine[0]!.bookKey).toBe(bookKey(target.toSourceId, target.toBookUrl))
        expect(theirs).toHaveLength(1)
        expect(theirs[0]!.bookKey).toBe(from)
    })
})
