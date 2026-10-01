-- 首页推荐位的缓存
--
-- 推荐位的内容来自第三方站点（书源的发现页），一次要打十几个外部请求。
-- 每次打开首页都现拉，既慢又容易被站点当成爬虫，所以落一份缓存、给个过期时间。
--
-- 只存一份（scope 固定为 'home'）：这是**所有登录用户共享的内容源**，
-- 与个人书架无关；个人化的那部分（继续阅读）每次实时读，不缓存。
CREATE TABLE IF NOT EXISTS home_cache (
    scope    TEXT    PRIMARY KEY,
    payload  TEXT    NOT NULL,
    built_at INTEGER NOT NULL
);
