-- 账号与会话
--
-- 这一版把「本机身份」升级成真正的账号：书架与阅读进度从「跟着浏览器」变成「跟着账号」。
-- 三张表各管一件事，不合并：
--   users           账号本身（含口令哈希参数，见下）
--   sessions        登录态。客户端只拿得到 token，拿不到 user_id
--   login_failures  登录失败计数，用来挡暴力猜密码
--
-- 口令哈希参数（salt / iterations）**存在每行上**，而不是写成全局常量：
-- 这样以后调高迭代次数时，老账号仍能用它当初的参数验证通过，
-- 不需要「不改密码就登不上」的强制重置。iterations 放在行上就是为了这一点。

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 一律以小写存储；唯一约束就落在这一列上，避免 Alice / alice 变成两个账号
    username      TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL DEFAULT '',
    password_hash TEXT    NOT NULL,
    salt          TEXT    NOT NULL,
    iterations    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
    -- 32 字节随机数的 base64url，客户端不可预测
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT    NOT NULL DEFAULT ''
);

-- 按用户查会话：登出全部设备、以及清理过期会话时要用
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- 清理过期会话时按时间扫
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_failures (
    username TEXT    PRIMARY KEY,
    count    INTEGER NOT NULL,
    first_at INTEGER NOT NULL
);
