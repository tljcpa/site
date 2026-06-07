// 博客访客建议后端。Cloudflare Worker + D1。
// 隐私模型:访客凭浏览器里的随机 token 只能看到/删除自己的建议;
//           博主凭 ADMIN_KEY(wrangler secret 注入)能看到全部。其他访客拿不到任何人的建议。

// 允许跨域调用的前端来源。生产域名 + 本地预览端口。
const ALLOW_ORIGINS = [
  'https://zdwktlj.top',
  'https://www.zdwktlj.top',
  'http://localhost:4321',
  'http://localhost:3000',
];

function corsHeaders(origin) {
  let allow = ALLOW_ORIGINS[0];
  if (ALLOW_ORIGINS.includes(origin)) {
    allow = origin;
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

function isAdmin(request, env) {
  const key = request.headers.get('X-Admin-Key') || '';
  // 常量时间比较没必要在这量级,但至少要求 env 配了密钥才放行
  return Boolean(env.ADMIN_KEY) && key === env.ADMIN_KEY;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ''); // 去掉结尾斜杠

    // 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 健康检查
    if (request.method === 'GET' && (path === '' || path === '/')) {
      return json({ ok: true, service: 'blog-suggestions' }, 200, origin);
    }

    // 提交建议
    if (request.method === 'POST' && path === '/suggestions') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'bad json' }, 400, origin);
      }
      const token = String(body.token || '').trim();
      const slug = String(body.slug || '').trim();
      const quote = String(body.quote || '').trim();
      const comment = String(body.comment || '').trim();

      if (token.length < 16 || token.length > 100) {
        return json({ error: 'invalid token' }, 400, origin);
      }
      if (!slug || slug.length > 200) {
        return json({ error: 'invalid slug' }, 400, origin);
      }
      if (!comment) {
        return json({ error: 'comment required' }, 400, origin);
      }
      if (comment.length > 2000 || quote.length > 1000) {
        return json({ error: 'too long' }, 400, origin);
      }

      // 轻量限流:同一 token 一分钟内最多 10 条,挡住脚本刷库
      const oneMinAgo = Date.now() - 60 * 1000;
      const recent = await env.DB
        .prepare('SELECT COUNT(*) AS n FROM suggestions WHERE token=? AND created_at>?')
        .bind(token, oneMinAgo)
        .first();
      if (recent && recent.n >= 10) {
        return json({ error: 'rate limited' }, 429, origin);
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      await env.DB
        .prepare('INSERT INTO suggestions (id, token, slug, quote, comment, created_at) VALUES (?,?,?,?,?,?)')
        .bind(id, token, slug, quote, comment, now)
        .run();
      return json({ ok: true, id, created_at: now }, 201, origin);
    }

    // 读取建议:管理员看全部,访客只看自己的
    if (request.method === 'GET' && path === '/suggestions') {
      const slug = url.searchParams.get('slug') || '';

      if (isAdmin(request, env)) {
        let rows;
        if (slug) {
          rows = await env.DB
            .prepare('SELECT id,token,slug,quote,comment,created_at FROM suggestions WHERE slug=? ORDER BY created_at DESC')
            .bind(slug)
            .all();
        } else {
          rows = await env.DB
            .prepare('SELECT id,token,slug,quote,comment,created_at FROM suggestions ORDER BY created_at DESC LIMIT 1000')
            .all();
        }
        return json({ ok: true, admin: true, items: rows.results || [] }, 200, origin);
      }

      // 访客:必须带 token 且带 slug,只返回自己在这篇下的
      const token = url.searchParams.get('token') || '';
      if (token.length < 16) {
        return json({ ok: true, items: [] }, 200, origin);
      }
      if (!slug) {
        return json({ error: 'slug required' }, 400, origin);
      }
      const rows = await env.DB
        .prepare('SELECT id,slug,quote,comment,created_at FROM suggestions WHERE slug=? AND token=? ORDER BY created_at DESC')
        .bind(slug, token)
        .all();
      return json({ ok: true, items: rows.results || [] }, 200, origin);
    }

    // 删除建议:管理员删任意,访客凭 token 删自己的
    if (request.method === 'DELETE' && path.startsWith('/suggestions/')) {
      const id = path.split('/').pop();
      if (!id) {
        return json({ error: 'id required' }, 400, origin);
      }
      if (isAdmin(request, env)) {
        await env.DB.prepare('DELETE FROM suggestions WHERE id=?').bind(id).run();
        return json({ ok: true }, 200, origin);
      }
      const token = url.searchParams.get('token') || '';
      if (token.length < 16) {
        return json({ error: 'token required' }, 400, origin);
      }
      await env.DB.prepare('DELETE FROM suggestions WHERE id=? AND token=?').bind(id, token).run();
      return json({ ok: true }, 200, origin);
    }

    // ===== 浏览量 / 点赞 / 分析 =====

    // 记录一次页面浏览。隐私友好:城市级地理来自 CF(request.cf),不存完整 IP。
    if (request.method === 'POST' && path === '/pageview') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'bad json' }, 400, origin);
      }
      const slug = String(body.slug || '').trim();
      if (!slug || slug.length > 200) {
        return json({ error: 'invalid slug' }, 400, origin);
      }
      const referrer = String(body.referrer || '').slice(0, 300);
      const source = String(body.source || '').slice(0, 100);
      const cf = request.cf || {};
      await env.DB
        .prepare('INSERT INTO pageviews (id, slug, ts, referrer, source, country, city) VALUES (?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), slug, Date.now(), referrer, source, cf.country || '', cf.city || '')
        .run();
      return json({ ok: true }, 201, origin);
    }

    // 查某页浏览量(公开)
    if (request.method === 'GET' && path === '/pageview') {
      const slug = url.searchParams.get('slug') || '';
      if (!slug) {
        return json({ error: 'slug required' }, 400, origin);
      }
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM pageviews WHERE slug=?').bind(slug).first();
      return json({ ok: true, count: row ? row.n : 0 }, 200, origin);
    }

    // 点赞(幂等:同 token 同 slug 只算一次)
    if (request.method === 'POST' && path === '/like') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'bad json' }, 400, origin);
      }
      const slug = String(body.slug || '').trim();
      const token = String(body.token || '').trim();
      if (!slug || token.length < 16) {
        return json({ error: 'invalid' }, 400, origin);
      }
      try {
        await env.DB
          .prepare('INSERT INTO likes (id, slug, token, ts) VALUES (?,?,?,?)')
          .bind(crypto.randomUUID(), slug, token, Date.now())
          .run();
      } catch (e) {
        // UNIQUE 冲突 = 已赞过,忽略
      }
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM likes WHERE slug=?').bind(slug).first();
      return json({ ok: true, count: row ? row.n : 0, liked: true }, 200, origin);
    }

    // 取消赞
    if (request.method === 'DELETE' && path === '/like') {
      const slug = url.searchParams.get('slug') || '';
      const token = url.searchParams.get('token') || '';
      if (!slug || token.length < 16) {
        return json({ error: 'invalid' }, 400, origin);
      }
      await env.DB.prepare('DELETE FROM likes WHERE slug=? AND token=?').bind(slug, token).run();
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM likes WHERE slug=?').bind(slug).first();
      return json({ ok: true, count: row ? row.n : 0, liked: false }, 200, origin);
    }

    // 查点赞数 + 当前访客是否已赞
    if (request.method === 'GET' && path === '/like') {
      const slug = url.searchParams.get('slug') || '';
      const token = url.searchParams.get('token') || '';
      if (!slug) {
        return json({ error: 'slug required' }, 400, origin);
      }
      const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM likes WHERE slug=?').bind(slug).first();
      let liked = false;
      if (token.length >= 16) {
        const mine = await env.DB.prepare('SELECT 1 FROM likes WHERE slug=? AND token=? LIMIT 1').bind(slug, token).first();
        liked = Boolean(mine);
      }
      return json({ ok: true, count: cnt ? cnt.n : 0, liked }, 200, origin);
    }

    // 分析汇总(仅管理员):总 PV、各页、来源、渠道、地理、最近明细、点赞
    if (request.method === 'GET' && path === '/analytics') {
      if (!isAdmin(request, env)) {
        return json({ error: 'forbidden' }, 403, origin);
      }
      const totalPV = await env.DB.prepare('SELECT COUNT(*) AS n FROM pageviews').first();
      const byPage = await env.DB.prepare('SELECT slug, COUNT(*) AS n FROM pageviews GROUP BY slug ORDER BY n DESC LIMIT 60').all();
      const byReferrer = await env.DB.prepare("SELECT referrer, COUNT(*) AS n FROM pageviews WHERE referrer!='' GROUP BY referrer ORDER BY n DESC LIMIT 30").all();
      const bySource = await env.DB.prepare("SELECT source, COUNT(*) AS n FROM pageviews WHERE source!='' GROUP BY source ORDER BY n DESC LIMIT 30").all();
      const byCity = await env.DB.prepare("SELECT country, city, COUNT(*) AS n FROM pageviews GROUP BY country, city ORDER BY n DESC LIMIT 40").all();
      const recent = await env.DB.prepare('SELECT slug, ts, referrer, source, country, city FROM pageviews ORDER BY ts DESC LIMIT 100').all();
      const likes = await env.DB.prepare('SELECT slug, COUNT(*) AS n FROM likes GROUP BY slug ORDER BY n DESC LIMIT 60').all();
      return json({
        ok: true,
        admin: true,
        totalPV: totalPV ? totalPV.n : 0,
        byPage: byPage.results || [],
        byReferrer: byReferrer.results || [],
        bySource: bySource.results || [],
        byCity: byCity.results || [],
        recent: recent.results || [],
        likes: likes.results || [],
      }, 200, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  },
};
