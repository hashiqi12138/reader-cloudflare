-- 书签
--
-- 与书架、阅读进度共用同一个隔离维度（owner + book_key），差别在于**条数**：
-- 一本书可以有很多处书签，所以主键里除了 owner 还要有一个 id。
-- id 用随机串而不是自增：自增在 D1 上要额外一次「取回 last_row_id」，
-- 而书签的创建本身不需要知道顺序 —— 展示顺序按创建时间排就够了。
--
-- 位置用两个字段一起记，因为两种阅读模式量的东西不一样：
-- 翻页模式停在「第几页」，滚动模式没有页的概念、只有「这一章读到百分之几」。
-- 只存其中一个，另一种模式跳回来就会明显偏位。
--
-- excerpt 是加书签那一刻的正文片段：列表里光有「第 37 章」看不出这一处
-- 记住了什么，而回跳需要先打开章节才能看到内容 —— 摘一段出来列表才有意义。
CREATE TABLE IF NOT EXISTS bookmarks (
    id            TEXT    NOT NULL,
    owner         TEXT    NOT NULL,
    book_key      TEXT    NOT NULL,
    source_id     TEXT    NOT NULL,
    book_url      TEXT    NOT NULL,
    chapter_url   TEXT    NOT NULL,
    chapter_name  TEXT    NOT NULL DEFAULT '',
    chapter_index INTEGER NOT NULL DEFAULT 0,
    page_index    INTEGER NOT NULL DEFAULT 0,
    percent       REAL    NOT NULL DEFAULT 0,
    excerpt       TEXT    NOT NULL DEFAULT '',
    note          TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (owner, id)
);

-- 读列表永远带上 owner + book_key，顺带按章节顺序排
CREATE INDEX IF NOT EXISTS idx_bookmarks_owner_book
    ON bookmarks (owner, book_key, chapter_index, page_index);
