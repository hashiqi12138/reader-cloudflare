/**
 * 书的变量的 D1 读写（`book.getVariable` / `book.putVariable`）
 *
 * 与书源变量（`sources.variable`，见 `sources.ts` 的 `persistSourceVariable`）
 * 是**两份不同的东西**，别合并：
 *   - 书源变量 = 一段自由字符串，作用域是「这个源」（备用域名、线路序号）
 *   - 书的变量 = 名字 → 值的一张表，作用域是「这本书」（规则探测出来的抓取形状）
 *
 * 与书架 / 进度 / 书签一样按 `book_key`（书源 id + 换行 + 书籍地址）索引，
 * 所以「同一本书」在几张表里指的是同一个东西。**刻意不带 owner**：取书接口
 * （`/api/book`、`/api/toc`、`/api/content`）是无状态的、不带身份，规则求值的时候
 * 没有「谁」这个概念。详细理由写在迁移 `0013` 的注释里。
 *
 * 两个刻意的选择：
 *
 * 1. **读是「一次取全表」**。一次取书（详情 → 目录 → 正文）会反复求值规则，
 *    每次都按名字查一遍库既慢又没必要 —— 这本书的变量一共也就几个键。
 *    路由层读一次、喂给 `RuleContext.bookVars`，后面全部走内存。
 * 2. **写是「按名字 upsert」**。规则自己只在探测出结果时才写（`book.putVariable("序", i)`），
 *    没写过的名字不该被动过 —— 所以这里不改其它行，也不删。
 */

/** 变量名的上限。书源写的是「序」「元」「custom」这类短名字 */
const MAX_VAR_NAME = 200
/** 单个值的上限。这些值是「选择器形状」「序号」这类小东西，8 KB 已经非常宽松 */
const MAX_VAR_VALUE = 8192

/**
 * 取一本书的全部变量
 *
 * 起点是空表（与 Legado 里「刚加进来的新书」一致）—— 书源自会走它自己的默认分支，
 * 所以取不到时返回 `{}` 而不是报错。
 */
export async function loadBookVariables(
    db: D1Database,
    bookKey: string,
): Promise<Record<string, string>> {
    const { results } = await db
        .prepare('SELECT name, value FROM book_variables WHERE book_key = ?')
        .bind(bookKey)
        .all<{ name: string; value: string }>()

    const out: Record<string, string> = {}
    for (const row of results ?? []) {
        out[String(row.name)] = String(row.value ?? '')
    }
    return out
}

/**
 * 写一个变量的值（不存在就插入）
 *
 * 值按字符串存：书源写进来的本来就是字符串（`String(v)`），而且这些值是
 * 「第几个选择器」这种序号 —— 存成数字再读回来还要统一类型，得不偿失。
 *
 * 上限校验在这里做（而不是让它一路写到库里）：书源是不可信代码，
 * 一个循环里 `book.putVariable(随机名字, 大字符串)` 能把这张表撑爆。
 * 超限时**静默丢弃** —— 与 `collectBookVars` 的取向一致：这是求值之后的收尾，
 * 抛异常只会把书源真正要表达的结果盖掉。
 */
export async function saveBookVariable(
    db: D1Database,
    bookKey: string,
    name: string,
    value: string,
): Promise<void> {
    if (name === '' || name.length > MAX_VAR_NAME) return
    if (value.length > MAX_VAR_VALUE) return
    await db
        .prepare(
            `INSERT INTO book_variables (book_key, name, value, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (book_key, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(bookKey, name, value, Date.now())
        .run()
}
