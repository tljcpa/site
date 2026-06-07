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
