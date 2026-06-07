-- 访客建议表。一条建议 = 某访客(token)在某篇(slug)上、对某段引用(quote)写的一条意见(comment)。
CREATE TABLE IF NOT EXISTS suggestions (
  id         TEXT PRIMARY KEY,   -- 服务端生成的 uuid
  token      TEXT NOT NULL,      -- 访客匿名标识(浏览器 localStorage 里的随机串)
  slug       TEXT NOT NULL,      -- 文章/项目 slug
  quote      TEXT,               -- 选中的原文片段(可空:整篇留言)
  comment    TEXT NOT NULL,      -- 建议正文
  created_at INTEGER NOT NULL    -- 毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_slug_token ON suggestions(slug, token);
CREATE INDEX IF NOT EXISTS idx_slug       ON suggestions(slug);

-- 页面浏览。隐私友好:只存城市级地理(CF 自带),不存完整 IP。
CREATE TABLE IF NOT EXISTS pageviews (
  id        TEXT PRIMARY KEY,
  slug      TEXT NOT NULL,      -- 哪个页面
  ts        INTEGER NOT NULL,   -- 毫秒时间戳
  referrer  TEXT,               -- 从哪个站跳来
  source    TEXT,               -- ?from= 渠道参数(投简历/发链接时标记)
  country   TEXT,               -- CF 提供,国家
  city      TEXT                -- CF 提供,城市级(非个人 IP)
);
CREATE INDEX IF NOT EXISTS idx_pv_slug ON pageviews(slug);
CREATE INDEX IF NOT EXISTS idx_pv_ts   ON pageviews(ts);
CREATE INDEX IF NOT EXISTS idx_pv_src  ON pageviews(source);

-- 点赞。一个访客(token)对一篇最多一次。
CREATE TABLE IF NOT EXISTS likes (
  id    TEXT PRIMARY KEY,
  slug  TEXT NOT NULL,
  token TEXT NOT NULL,
  ts    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_like_uniq ON likes(slug, token);
CREATE INDEX IF NOT EXISTS idx_like_slug ON likes(slug);
