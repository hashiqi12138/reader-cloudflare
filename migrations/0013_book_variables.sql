-- 书的变量（Legado 的 `Book.variableMap`）
--
-- 书源里写作 `book.getVariable("custom")` / `book.putVariable("序", i)` /
-- `chapter.putVariable(...)`：一个**带名字的 map**，作用域是「这本书」。
--
-- 与 `sources.variable` 是两份不同的东西，别合并：
--   书源变量 = 一段自由字符串，作用域是「这个源」
--   书的变量 = 名字 → 值，作用域是「这本书」
--
-- 线上 11 个源 38 处在用，两类用法：
--   1. **用户手填的**（`custom` 这个键）：⚡📂小小阅读 / ⚡📂键盘小说 当线路序号、
--      ⚡📂穿越小说 当章节截断数、🏷晋江文学 当开关。本引擎没有设置入口，
--      所以它们永远是空串 —— 与 Legado 里「刚加进来的新书」状态一致，书源自己会走默认分支
--   2. **规则自己写的**（`序` / `元` / `动` / `静`）：📂掌阅书城 / 📂就去看网 / 📂言情小说
--      的正文规则会探一次「哪一个抓取形状能解析出正文」，记下来给**下一章**用。
--      一章一次请求，所以要跨请求活着，否则每章都重探一遍
--
-- 键用与书架 / 阅读进度 / 书签同一个 `book_key`（书源 id + 换行 + 书籍地址），
-- 这样「同一本书」在不同表里指的是同一个东西。
--
-- 刻意**不带 owner**：取书接口（/api/book、/api/toc、/api/content）是无状态的、
-- 不带身份，规则求值的时候没有「谁」这个概念。带 owner 的话要么给这几个接口加登录要求
-- （会让分享出去的阅读链接失效），要么填一个假的 owner（那和现在没区别）。
-- 所以这张表里放的是**规则自己算出来的中间状态**，不是使用者的私人数据 ——
-- 使用者私人的那份（书架 / 进度 / 书签）仍然是 (owner, book_key)。
CREATE TABLE IF NOT EXISTS book_variables (
    book_key   TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    value      TEXT    NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (book_key, name)
);

-- 读一整本书的变量（一次取书中会读多次）走这个索引
CREATE INDEX IF NOT EXISTS idx_book_variables_key ON book_variables (book_key);
