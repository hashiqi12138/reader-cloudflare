-- 登录态（原项目的 `BookSource.loginHeader` / `loginInfo`）
--
-- 书源登录成功之后用 `source.putLoginHeader(...)` / `source.putLoginInfo(...)` 存下来的两样东西：
--   `login_header` —— 一段 JSON（`{"Cookie":"…"}`、`{"Authorization":"…"}`），请求时按头带上
--   `login_info`   —— 一段自由文本（源自己 `JSON.parse` 后按键取：账号、token、uid…）
--
-- 为什么必须落库：在我们这里「搜索 / 详情 / 目录 / 正文」是**四次互不相干的请求**，
-- 而登录是**一次**动作 —— 不落库的话，登录状态只活在那一趟里，用户看到的是
-- 「登录成功了，但翻一页又要重新登录」。
--
-- 为什么单列两列而不是塞进 payload：与 `variable` 同理 —— 它们是**运行期会被书源自己改**
-- 的状态，而 payload 是「导入时的规则快照」（改它要整份重写几 KB 的 JSON）；
-- 而且读的地方每次都只想要这一小段。
--
-- 也**不进** `importSources` 的 ON CONFLICT 更新列：重新导入一份同名书源会覆盖规则快照，
-- 但保留登录态 —— 那是站点给的会话凭据，不是导入文件的一部分，被一次重导冲掉会让用户
-- 莫名地「退出登录」。
ALTER TABLE sources ADD COLUMN login_header TEXT NOT NULL DEFAULT '';
ALTER TABLE sources ADD COLUMN login_info TEXT NOT NULL DEFAULT '';
