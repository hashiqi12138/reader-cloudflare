-- 书源的「健康度」：把有限的搜索额度花在还活着的源上
--
-- 背景见 EXPERIENCE.md「第二十六轮：搜索 503 —— 免费计划的 10 毫秒 CPU 上限」：
-- 免费计划每个 Worker 请求只有 10 ms CPU（硬上限，`limits.cpu_ms` 会被部署拒绝），
-- 而一次搜索要在同一个请求里跑完书源的规则求值 —— 线上实测会被掐断。
-- 既然额度有限，就该先花在**能搜到东西**的源上；而一个源还能不能用，
-- 只有真跑过才知道。594 个源里相当一部分是国内连不上或规则早已失效的，
-- 每次搜索都为它们花掉额度，最后把额度耗光的恰恰是这些永远搜不到东西的源。
--
-- last_ok_at   ：最近一次搜索**返回过书**的时刻（0 = 从来没有）
-- fail_streak  ：连续失败次数（成功即清零）
--
-- 排序用 `(fail_streak >= 5)` 而不是直接跳过：连续失败多次的排到最后，
-- 但**不会被永久放弃** —— 网络抖一下不该让一个源永远出局。
ALTER TABLE sources ADD COLUMN last_ok_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0;
