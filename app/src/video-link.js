// 视频链接解析：把「群友发来一个视频链接」变成模型能看懂的内容。
//
// ── 为什么需要这一层 ────────────────────────────────────────────────────
// 直接抓 https://www.bilibili.com/video/BV... 会吃 HTTP 412。412 是 bilibili 的
// 风控页（云服务器出口 IP + 无 Cookie + 无完整浏览器指纹），正文是一段对模型
// 毫无价值的 HTML；实测换 UA、加 Referer、带 buvid3 Cookie 都不改变结果 ——
// 这是 IP 维度的判定，不是请求头能绕的。
//
// 但同一台机器访问 bilibili 的**开放接口**大部分是通的：
//   x/web-interface/search/type   按 BV 号反查标题/作者/时长/播放/点赞/简介/标签
//   x/player/pagelist             分P 列表 + cid + 分辨率
//   x/player/videoshot            关键帧雪碧图（100 张缩略图拼成一张）
// 所以这里改走「接口组合」而不是硬啃页面 HTML。
//
// ── 安全边界 ────────────────────────────────────────────────────────────
// 全部请求只发往固定常量域名（api.bilibili.com / b23.tv / i0.hdslb.com），
// 用户可控的只有 BV 号、av 号、P 序号，且都经过严格格式校验后才拼进查询串，
// 不构成 SSRF 面。浏览锁定（browseLock）仍然按**用户给的那个链接**判定，
// 锁定开启且不放行时直接拒绝，发不发接口请求都不做。

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const BILI_REFERER = 'https://www.bilibili.com/';
const API_ORIGIN = 'https://api.bilibili.com';
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_SHORT_HOPS = 3;

// 短链域名：内容只有一跳 302，必须先把真实地址解出来才知道是哪个视频
const SHORT_HOSTS = new Set(['b23.tv', 'bili2233.cn']);

function hostOf(raw) {
  try {
    return new URL(String(raw)).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function isBiliHost(host) {
  return host === 'bilibili.com' || host.endsWith('.bilibili.com');
}

/**
 * 识别视频链接。**纯函数**，不发请求，方便测试与在 UI 里预览。
 * 短链（b23.tv）只标记 short:true —— 真实地址要展开后才知道。
 *
 * @returns {null | {platform:'bilibili', short?:true, href:string,
 *                   bvid?:string, aid?:string, page?:number}}
 */
export function parseVideoUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return null;

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (SHORT_HOSTS.has(host)) return { platform: 'bilibili', short: true, href: u.toString() };
  if (!isBiliHost(host)) return null;

  const path = u.pathname;
  const bv = /\/(?:video|list)\/(BV[0-9A-Za-z]{10})/i.exec(path)?.[1];
  const av = /\/video\/av(\d{1,20})/i.exec(path)?.[1];
  const pageRaw = u.searchParams.get('p');
  const page = pageRaw && /^\d{1,4}$/.test(pageRaw) ? Math.max(1, Number(pageRaw)) : 1;

  if (bv) return { platform: 'bilibili', href: u.toString(), bvid: bv, page };
  if (av) return { platform: 'bilibili', href: u.toString(), aid: av, page };
  return null;
}

/** 媒体地址补协议：bilibili 接口返回的是 `//i0.hdslb.com/...` 这种协议相对地址。 */
export function absoluteMediaUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  return s;
}

/** "3:33" / "1:02:03" → 秒；解析不了返回 0。 */
export function parseClock(text) {
  const s = String(text ?? '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map((x) => Number(x));
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** 大数字口语化：107496384 → "1.07 亿"。给模型看，不需要精确到个位。 */
export function humanCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1e8) return `${(v / 1e8).toFixed(2).replace(/\.?0+$/, '')} 亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')} 万`;
  return String(Math.round(v));
}

/** 秒 → "3 分 33 秒"；不足 1 分钟按秒说。 */
export function humanDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h} 小时 ${m} 分 ${r} 秒`;
  if (m) return `${m} 分 ${r} 秒`;
  return `${r} 秒`;
}

/** 搜索结果里的标题会带 <em class="keyword"> 高亮标签，去掉它。 */
function stripTags(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * 展开短链（b23.tv）。只跟 Location，不读响应体 —— 短链返回的是 302，
 * 正文为空，没必要下载。
 */
export async function expandShortUrl(raw, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let current = String(raw ?? '').trim();
  for (let hop = 0; hop < MAX_SHORT_HOPS; hop++) {
    const host = hostOf(current);
    if (!SHORT_HOSTS.has(host)) return current;
    const res = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': CHROME_UA, referer: BILI_REFERER },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const location = res?.headers?.get?.('location');
    if (!location) return current;
    current = new URL(location, current).toString();
  }
  return current;
}

/** 调一个 bilibili 接口，统一带 UA/Referer/超时。返回解析后的 JSON。 */
async function biliApi(pathAndQuery, { fetchImpl, timeoutMs }) {
  const res = await fetchImpl(`${API_ORIGIN}${pathAndQuery}`, {
    method: 'GET',
    headers: {
      'user-agent': CHROME_UA,
      referer: BILI_REFERER,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 基本就是风控给的 HTML 页
    throw new Error(`接口返回 HTTP ${res?.status ?? 0}（非 JSON，可能被风控拦了）`);
  }
  // 注意：这里**不对 status 抛错**。bilibili 风控会用 HTTP 412 包着
  // {"code":-412}，状态码和业务码要一起看，交给调用方按 code 判断，
  // 否则"换个接口再试"的逻辑就永远走不到。
  return { ...json, _httpStatus: res?.status ?? 0 };
}

/** 从两种搜索响应里凑出视频条目（两种结构不同，统一成数组）。 */
export function videoCandidates(json) {
  const data = json?.data;
  if (!data || !Array.isArray(data.result)) return [];
  const out = [];
  for (const item of data.result) {
    if (!item) continue;
    // search/type：result 直接是视频数组
    if (item.bvid) { out.push(item); continue; }
    // search/all/v2：result 是分组数组，视频在 result_type='video' 的 data 里
    if (item.result_type === 'video' && Array.isArray(item.data)) out.push(...item.data);
  }
  return out.filter((v) => v && v.bvid);
}

/** 把搜到的条目写进结果对象。 */
function applyMeta(out, hit, info) {
  out.bvid = hit.bvid || info.bvid || out.bvid || '';
  out.aid = hit.aid || (info.aid ? Number(info.aid) : out.aid);
  out.title = stripTags(hit.title);
  out.author = stripTags(hit.author);
  out.authorMid = hit.mid;
  out.category = stripTags(hit.typename);
  out.description = stripTags(hit.description);
  out.tags = String(hit.tag || '').split(',').map((t) => t.trim()).filter(Boolean);
  out.durationText = String(hit.duration || '');
  out.durationSec = parseClock(hit.duration);
  out.pubdate = hit.pubdate ? new Date(Number(hit.pubdate) * 1000).toISOString().slice(0, 10) : '';
  out.stats = {
    play: Number(hit.play) || 0,
    danmaku: Number(hit.danmaku ?? hit.video_review) || 0,
    like: Number(hit.like) || 0,
    favorite: Number(hit.favorites) || 0,
    comment: Number(hit.review) || 0
  };
  out.coverUrl = absoluteMediaUrl(hit.pic);
}

/**
 * 依次试两个搜索接口取元信息。
 * 两条通道限流是独立的：同一时刻一条 412、另一条 200 是常态，
 * 所以不能"主接口挂了就放弃元信息"。
 */
async function fetchVideoMeta(keyword, { fetchImpl, timeoutMs, bvid = '', aid = '' }) {
  const attempts = [
    ['search/type', `/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}`],
    ['search/all/v2', `/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}`]
  ];
  const notes = [];
  for (const [label, path] of attempts) {
    try {
      const json = await biliApi(path, { fetchImpl, timeoutMs });
      if (json?.code !== 0) {
        notes.push(`${label} 返回 code=${json?.code ?? '?'}${json?.message ? `（${json.message}）` : ''}`);
        continue;
      }
      const list = videoCandidates(json);
      if (!list.length) { notes.push(`${label}：按 id 没搜到该视频（可能刚发布或已删除）`); continue; }
      const hit = list.find((r) => (bvid && r.bvid === bvid) || (aid && String(r.aid) === String(aid))) || list[0];
      return { hit, via: label, notes };
    } catch (error) {
      notes.push(`${label} 失败：${error?.message ?? error}`);
    }
  }
  return { hit: null, via: '', notes };
}

/**
 * 解析一个视频链接。
 *
 * @returns {Promise<{ok:true, ...}|{ok:false, reason:string, blocked?:boolean}>}
 *   ok:false 且 blocked:true 表示被浏览锁定拒绝；
 *   ok:false 且 unsupported:true 表示这不是认识的视频链接（调用方应走普通网页抓取）。
 */
export async function resolveVideoLink(raw, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  browseLocked = false,
  checkLock = null
} = {}) {
  const input = String(raw ?? '').trim();
  const parsed = parseVideoUrl(input);
  if (!parsed) return { ok: false, unsupported: true, reason: '不是已知的视频链接' };

  // 浏览锁定按**用户给的原链接**判定，不按我们内部要访问的接口域名判定
  if (browseLocked && typeof checkLock === 'function') {
    const lock = checkLock(input);
    if (!lock?.allowed) {
      return { ok: false, blocked: true, reason: `浏览锁定：${lock?.host || '该地址'} 不在允许的域名清单内` };
    }
  }

  let target = input;
  let info = parsed;
  const notes = [];

  if (parsed.short) {
    try {
      target = await expandShortUrl(input, { fetchImpl, timeoutMs });
    } catch (error) {
      return { ok: false, reason: `短链展开失败：${error?.message ?? error}` };
    }
    // ⚠️ 逐跳复检：白名单里写 b23.tv 只代表"允许点这个短链"，
    // 不代表允许它跳去的站。只在入口校验的话，一个短链就能把整个 B 站放进来
    // （与 safe-fetch 里"重定向每一跳都要重新校验"是同一套语义）。
    // 放在解析之前：地址不合规要按"被策略拒绝"报，而不是含糊地说"不是视频页"。
    if (browseLocked && typeof checkLock === 'function') {
      const nl = checkLock(target);
      if (!nl?.allowed) {
        return { ok: false, blocked: true, reason: `浏览锁定：短链指向的 ${nl?.host || '地址'} 不在允许的域名清单内` };
      }
    }
    info = parseVideoUrl(target);
    if (!info) return { ok: false, unsupported: true, reason: '短链展开后不是视频页' };
  }

  if (!info.bvid && !info.aid) {
    return { ok: false, unsupported: true, reason: '链接里没有识别到 BV 号 / av 号' };
  }

  const out = {
    ok: true,
    platform: 'bilibili',
    url: target,
    pageIndex: info.page || 1,
    notes
  };
  // 先把链接里自带的信息填上：搜索接口挂掉时，分P 这条通道还要靠 bvid 才能走。
  // 只有 av 号链接拿不到 bvid，那种情况才必须依赖搜索反查。
  if (info.bvid) out.bvid = info.bvid;
  if (info.aid) out.aid = Number(info.aid);

  // ── 1. 元信息：按 id 反查 ───────────────────────────────────────────
  // 用 BV 号（或 av 号）当关键词搜，命中数通常是 1，等于"按 id 取详情"。
  // 官方详情接口 x/web-interface/view 在当前出口 IP 上是 412，走不通；
  // 可用的是两个搜索接口，且**它们各自限流**：
  //   x/web-interface/search/type  更轻，但被限流时直接 HTTP 412 / code=-412
  //   x/web-interface/search/all/v2 结果分组更啰嗦，但限流阈值不同，能顶上来
  // 实测同一时刻前者 412、后者 200，所以两条都要试。
  const keyword = info.bvid || `av${info.aid}`;
  const meta = await fetchVideoMeta(keyword, { fetchImpl, timeoutMs, bvid: info.bvid, aid: info.aid });
  if (meta.hit) {
    applyMeta(out, meta.hit, info);
    // 主接口失败的原因也保留：元信息可能不完整，让模型知道别把数据当绝对准确
    if (meta.notes.length) notes.push(...meta.notes);
    if (meta.via !== 'search/type') notes.push(`元信息经备用接口（${meta.via}）获取`);
  } else if (meta.notes.length) {
    notes.push(...meta.notes);
  }

  // ── 2. 分P 列表 + cid：player/pagelist ──────────────────────────────
  // pagelist / videoshot 两个接口都同时接受 bvid 和 aid。
  // av 号链接拿不到 bvid（搜索被限流时更是如此），所以这里必须按 aid 兜住 ——
  // 否则 av 链接在 412 环境下会整条链路全空、直接判失败。
  const idQuery = out.bvid
    ? `bvid=${encodeURIComponent(out.bvid)}`
    : (out.aid ? `aid=${encodeURIComponent(out.aid)}` : '');
  if (idQuery) {
    try {
      const json = await biliApi(
        `/x/player/pagelist?${idQuery}`,
        { fetchImpl, timeoutMs }
      );
      if (json?.code === 0 && Array.isArray(json?.data)) {
        const parts = json.data.map((p) => ({
          index: Number(p.page) || 0,
          title: stripTags(p.part),
          durationSec: Number(p.duration) || 0,
          cid: p.cid,
          width: Number(p?.dimension?.width) || 0,
          height: Number(p?.dimension?.height) || 0
        }));
        out.parts = parts;
        out.partCount = parts.length;
        const wanted = info.page || 1;
        const current = parts.find((p) => p.index === wanted) || parts[0];
        if (current) {
          out.currentPart = current;
          // ?p=99 但视频只有 1 P 时：把 pageIndex 拉回真实值并说清楚，
          // 否则模型会把 P1 的画面当成第 99 P 来描述
          if (current.index !== wanted) {
            out.pageIndex = current.index;
            out.pageNote = `这个视频只有 ${parts.length} P，第 ${wanted} P 不存在，下面是第 ${current.index} P 的内容`;
          }
          // 分P 时长比整条视频的总时长更贴近"这一段要看多久"
          if (!out.durationSec && current.durationSec) out.durationSec = current.durationSec;
          if (current.width && current.height) out.resolution = `${current.width}×${current.height}`;
        }
        // 关键帧雪碧图：拿当前这一 P 的 cid
        if (current?.cid) {
          try {
            const shot = await biliApi(
              `/x/player/videoshot?${idQuery}&cid=${encodeURIComponent(current.cid)}&index=1`,
              { fetchImpl, timeoutMs }
            );
            if (shot?.code === 0 && shot?.data?.image?.length) {
              out.framesUrl = absoluteMediaUrl(shot.data.image[0]);
              out.framesGrid = {
                cols: Number(shot.data.img_x_len) || 0,
                rows: Number(shot.data.img_y_len) || 0,
                width: Number(shot.data.img_x_size) || 0,
                height: Number(shot.data.img_y_size) || 0
              };
            }
          } catch (error) {
            notes.push(`关键帧获取失败：${error?.message ?? error}`);
          }
        }
      } else {
        notes.push(`分P接口返回 code=${json?.code ?? '?'}：${json?.message ?? '未知错误'}`);
      }
    } catch (error) {
      notes.push(`分P获取失败：${error?.message ?? error}`);
    }
  }

  // 一条信息都没拿到 = 实际失败，不要假装成功让模型对着空对象瞎猜
  if (!out.title && !out.parts?.length) {
    return { ok: false, reason: notes.join('；') || '所有接口都没返回可用信息' };
  }
  return out;
}

/**
 * 把解析结果整理成一段给模型读的文字。
 * 刻意写成中文短句而不是 JSON —— 模型对结构化中文的复述更准，
 * 也不会把技术字段名当内容说给群友听。
 */
export function describeVideo(info) {
  const lines = [];
  if (info.title) lines.push(`标题：${info.title}`);
  if (info.author) lines.push(`UP 主：${info.author}`);
  if (info.partCount > 1) {
    lines.push(`分P：共 ${info.partCount} P，这是第 ${info.pageIndex} P${info.currentPart?.title ? `（${info.currentPart.title}）` : ''}`);
  }
  if (info.pageNote) lines.push(`注意：${info.pageNote}`);
  const bits = [];
  if (info.durationSec) bits.push(`时长 ${humanDuration(info.durationSec)}`);
  if (info.resolution) bits.push(`画面 ${info.resolution}`);
  if (info.pubdate) bits.push(`发布于 ${info.pubdate}`);
  if (info.category) bits.push(`分区 ${info.category}`);
  if (bits.length) lines.push(bits.join('，'));
  const st = info.stats;
  if (st) {
    const statBits = [];
    if (st.play) statBits.push(`播放 ${humanCount(st.play)}`);
    if (st.like) statBits.push(`点赞 ${humanCount(st.like)}`);
    if (st.danmaku) statBits.push(`弹幕 ${humanCount(st.danmaku)}`);
    if (st.favorite) statBits.push(`收藏 ${humanCount(st.favorite)}`);
    if (st.comment) statBits.push(`评论 ${humanCount(st.comment)}`);
    if (statBits.length) lines.push(statBits.join('，'));
  }
  if (info.description && info.description !== '-') {
    lines.push(`简介：${info.description.slice(0, 300)}`);
  }
  if (info.tags?.length) lines.push(`标签：${info.tags.slice(0, 12).join('、')}`);
  if (info.framesUrl) {
    const g = info.framesGrid || {};
    lines.push(`关键帧：已取到整段视频的缩略图拼图${g.cols && g.rows ? `（${g.cols}×${g.rows} 张）` : ''}，会作为图片一起发给你，可以据此描述画面内容。`);
  }
  lines.push(`链接：${info.url}`);
  // notes 里是接口名/code 这类技术细节，只留给排障用，**不要**渲染进给模型的文本：
  // 模型会原样把"search/type 返回 code=-412"复述到群里，群友看不懂也不需要看。
  if (info.notes?.length) lines.push('（备注：部分信息没取到，内容可能不完整）');
  return lines.join('\n');
}
