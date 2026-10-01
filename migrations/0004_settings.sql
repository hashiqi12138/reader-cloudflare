-- 通用键值设置
--
-- 目前只用来存媒体代理的签名密钥。密钥在**首次使用时随机生成**，而不是要求部署者
-- 另外配一个 secret —— 后者的问题是：忘了配的时候功能不是失效，而是静默地变成
-- 一个对全网开放的反向代理，没人会发现。
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
