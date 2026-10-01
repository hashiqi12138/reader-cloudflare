-- 书源
--
-- payload 存导入时的 Legado 书源 JSON 原文，其余列是从中抽出来、用于查询和列表展示的字段。
-- 两边都留的原因：规则字段太多，逐列拆开会让「书源格式升级」变成一次数据库迁移；
-- 而列表页又不想每次都反序列化几百条 JSON 才能显示名字。
--
-- 名字/分组/启用状态以列为准：改这些只动列，不回写 payload，
-- 因此「导入一份新的同名书源」会覆盖 payload，但不会把用户改过的名字冲掉。
CREATE TABLE IF NOT EXISTS sources (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    builtin    INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 搜索时要按 enabled 过滤并按展示顺序取，这里让它走索引
CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources (enabled, sort_order);
