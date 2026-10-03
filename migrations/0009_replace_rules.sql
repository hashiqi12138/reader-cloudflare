-- 替换净化规则（跟着账号走）
--
-- 为什么是「一行存整份 JSON」而不是「一条规则一行」：
-- 这份规则**永远整份读写** —— 界面上是列表整体保存，正文净化时也是整份按顺序套用。
-- 一条一行就要加排序列、每次保存还要删旧插新（几十条 = 几十次写），
-- 换来的只是「能按条查」这个我们不需要的能力。书源表（sources.payload）就是这么存的。
--
-- updated_at 不只是展示用：它是**冲突检测**的依据（见 data/replaceRules.ts）——
-- 客户端带上「我这份是基于哪个时间改的」，与服务端对不上就拒绝并把它现在的这份回给客户端，
-- 而不是安静地把对方在那台设备上的改动覆盖掉。
CREATE TABLE IF NOT EXISTS replace_rules (
    owner      TEXT    NOT NULL PRIMARY KEY,
    rules      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
