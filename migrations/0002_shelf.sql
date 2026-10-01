-- 书架与阅读进度
--
-- 两张表共用同一个主键形态（book_key = 书源 id + 换行 + 书籍地址），
-- 分开存是因为它们的生命周期不同：移出书架时进度通常也该清掉，
-- 但「清进度」与「移出书架」是两个独立的动作，混在一张表里会让
-- 删除书架条目顺带把进度一起删掉，这是隐式行为，改起来容易踩空。
CREATE TABLE IF NOT EXISTS shelf (
    book_key   TEXT PRIMARY KEY,
    source_id  TEXT NOT NULL,
    book_url   TEXT NOT NULL,
    name       TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    cover_url  TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 书架按最近加入/最近阅读倒序展示，这里让它走索引
CREATE INDEX IF NOT EXISTS idx_shelf_updated ON shelf (updated_at DESC);

CREATE TABLE IF NOT EXISTS reading_progress (
    book_key      TEXT PRIMARY KEY,
    chapter_url   TEXT NOT NULL,
    chapter_name  TEXT NOT NULL DEFAULT '',
    -- 章节在目录里的序号。存下来是为了「上次读到第 N 章」这类展示，
    -- 以及在目录页直接定位，不必靠地址去反查
    chapter_index INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
);
