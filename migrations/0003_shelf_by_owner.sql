-- 书架与阅读进度改成「按用户隔离」
--
-- SQLite 不能修改主键，而隔离维度必须进主键（同一个人可以有多本同名书，
-- 不同人更要能各自持有同一本书），所以只能重建表。
--
-- 升级前那批数据没有归属信息 —— 当时确实只有一个使用者，但也无法确定新身份该是谁。
-- 直接丢掉不合适，于是归到 'legacy' 名下保留着；前端看不到它，
-- 需要认领时把 shelf_by_owner.owner 从 'legacy' 改成你自己的 owner 即可（见 src/lib/identity.ts 的 LEGACY_OWNER）。宁可让它暂时「挂着」，
-- 也不要因为一次迁移就静默删掉用户数据。

CREATE TABLE shelf_by_owner (
    owner      TEXT NOT NULL,
    book_key   TEXT NOT NULL,
    source_id  TEXT NOT NULL,
    book_url   TEXT NOT NULL,
    name       TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    cover_url  TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, book_key)
);

INSERT INTO shelf_by_owner (owner, book_key, source_id, book_url, name, author, cover_url, created_at, updated_at)
SELECT 'legacy', book_key, source_id, book_url, name, author, cover_url, created_at, updated_at
  FROM shelf;

DROP TABLE shelf;
ALTER TABLE shelf_by_owner RENAME TO shelf;

-- 书架按「本人最近读过」倒序展示，走这个索引
CREATE INDEX IF NOT EXISTS idx_shelf_owner_updated ON shelf (owner, updated_at DESC);

CREATE TABLE progress_by_owner (
    owner         TEXT NOT NULL,
    book_key      TEXT NOT NULL,
    chapter_url   TEXT NOT NULL,
    chapter_name  TEXT NOT NULL DEFAULT '',
    chapter_index INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (owner, book_key)
);

INSERT INTO progress_by_owner (owner, book_key, chapter_url, chapter_name, chapter_index, updated_at)
SELECT 'legacy', book_key, chapter_url, chapter_name, chapter_index, updated_at
  FROM reading_progress;

DROP TABLE reading_progress;
ALTER TABLE progress_by_owner RENAME TO reading_progress;
