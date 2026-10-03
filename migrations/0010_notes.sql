-- 笔记
--
-- 与「书签」刻意分成两张表，虽然字段很像。两者的语义不同：
--   - 书签是「我在这里留了个标记」，**位置**是重点，备注可有可无
--   - 笔记是「我在这里写下了一段话」，**正文**是重点，位置只是它的出处
-- 合成一张表的结果是：每条查询都要带一个「算不算笔记」的条件（正文非空），
-- 而「有备注的书签」还会被当成笔记混进来。那正是「把备注改个名字」的代价。
--
-- book_key 与书架、书签同形（书源 id + 换行 + 书籍地址）。
-- 位置三件套（chapter_index + page_index + percent）与书签一致：
-- 翻页模式记「第几页」，滚动模式没有页的概念、记「这一章读到百分之几」，
-- 只存其中一个，另一种模式跳回来就会明显偏位。
--
-- text 不给默认值：**笔记必须有正文**。没有正文的笔记在列表里就是一行空白，
-- 还会占掉导出与备份里的位置 —— 让数据库这一层也拒绝它，比只在应用层校验稳。
CREATE TABLE IF NOT EXISTS notes (
    id            TEXT    NOT NULL,
    owner         TEXT    NOT NULL,
    book_key      TEXT    NOT NULL,
    source_id     TEXT    NOT NULL,
    book_url      TEXT    NOT NULL,
    chapter_name  TEXT    NOT NULL DEFAULT '',
    chapter_index INTEGER NOT NULL DEFAULT 0,
    page_index    INTEGER NOT NULL DEFAULT 0,
    percent       REAL    NOT NULL DEFAULT 0,
    excerpt       TEXT    NOT NULL DEFAULT '',
    text          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (owner, id)
);

-- 按书读（阅读界面里的「这一本的笔记」），顺带按章节顺序
CREATE INDEX IF NOT EXISTS idx_notes_owner_book
    ON notes (owner, book_key, chapter_index, page_index);

-- 跨书读（笔记本视角，按时间倒序）
CREATE INDEX IF NOT EXISTS idx_notes_owner_created
    ON notes (owner, created_at);
