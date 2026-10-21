// ============================================================================
//  video-link 单测
//
//  运行：node tools/test-video-link.mjs
//
//  覆盖两类东西：
//    1. 纯函数（链接识别、时长/数量格式化、状态码人话）—— 不碰网络；
//    2. 解析流程 —— 用假的 fetchImpl 喂真实形状的 bilibili 响应，
//       验证"412 环境下改走接口组合"这条链路真的能拼出可用信息。
//
//  为什么要测这个：bilibili 的网页对云服务器出口 IP 一律返 412，
//  抓页面这条路已经废了。这里保证接口组合在**响应形状变化**时能立刻暴露，
//  而不是等线上群友问"这个视频讲了啥"时模型答不出来。
// ============================================================================

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = ['../app/src/video-link.js', './app/src/video-link.js', '../resources/app/src/video-link.js'];
const rel = CANDIDATES.find((p) => existsSync(path.resolve(__dirname, p)));
if (!rel) {
  console.error('找不到 video-link.js。已尝试：\n  ' + CANDIDATES.join('\n  '));
  process.exit(2);
}
const {
  parseVideoUrl, expandShortUrl, resolveVideoLink, describeVideo, videoCandidates,
  parseClock, humanCount, humanDuration, absoluteMediaUrl
} = await import(rel);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  [OK]   ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}\n         期望: ${e}\n         实际: ${a}`); }
}
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [OK]   ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}

// ── 1. 链接识别 ─────────────────────────────────────────────────────────
console.log('\n[1] parseVideoUrl');
check('标准视频页', parseVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7'),
  { platform: 'bilibili', href: 'https://www.bilibili.com/video/BV1GJ411x7h7', bvid: 'BV1GJ411x7h7', page: 1 });
check('带 ?p= 分P', parseVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=3').page, 3);
check('av 号', parseVideoUrl('https://www.bilibili.com/video/av80433022').aid, '80433022');
check('移动端域名', parseVideoUrl('https://m.bilibili.com/video/BV1GJ411x7h7').bvid, 'BV1GJ411x7h7');
check('b23 短链', parseVideoUrl('https://b23.tv/abc123'),
  { platform: 'bilibili', short: true, href: 'https://b23.tv/abc123' });
check('没写协议也能认', parseVideoUrl('www.bilibili.com/video/BV1GJ411x7h7').bvid, 'BV1GJ411x7h7');
check('普通网页返回 null', parseVideoUrl('https://example.com/a/BV1GJ411x7h7'), null);
check('空串返回 null', parseVideoUrl(''), null);
check('非视频的 B 站页面返回 null', parseVideoUrl('https://space.bilibili.com/2'), null);
// 关键：BV 号必须严格 12 位，不能把任意路径当视频
check('BV 号长度不对不认', parseVideoUrl('https://www.bilibili.com/video/BV123'), null);

// ── 2. 格式化 ───────────────────────────────────────────────────────────
console.log('\n[2] 格式化工具');
check('mm:ss', parseClock('3:33'), 213);
check('h:mm:ss', parseClock('1:02:03'), 3723);
check('纯秒数', parseClock('45'), 45);
check('垃圾输入', parseClock('abc'), 0);
check('亿', humanCount(107496384), '1.07 亿');
check('万', humanCount(1556486), '155.6 万');
check('小数字', humanCount(42), '42');
check('0', humanCount(0), '0');
check('分秒', humanDuration(213), '3 分 33 秒');
check('小时', humanDuration(3723), '1 小时 2 分 3 秒');
check('不足一分钟', humanDuration(45), '45 秒');
check('协议相对地址补 https', absoluteMediaUrl('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
check('已是 http 不重复加', absoluteMediaUrl('http://x/a.jpg'), 'http://x/a.jpg');

// ── 3. 假 fetch：还原线上响应形状 ───────────────────────────────────────
console.log('\n[3] resolveVideoLink（注入假 fetch）');

// 线上实测过的真实响应（2026-10-21 抓自 api.bilibili.com）
const SEARCH_JSON = {
  code: 0, message: 'OK', ttl: 1,
  data: {
    result: [{
      type: 'video', aid: 80433022, bvid: 'BV1GJ411x7h7',
      author: '索尼音乐中国', mid: 486906719, typename: 'MV',
      title: '<em class="keyword">Never</em> Gonna Give You Up',
      description: '官方 MV 简介',
      pic: '//i1.hdslb.com/bfs/archive/cover.jpg',
      play: 107496384, danmaku: 151042, like: 2958711, favorites: 1556486, review: 238226,
      tag: 'Rick Astley,欧美MV,流行音乐', pubdate: 1577835803, duration: '3:33'
    }]
  }
};
const PAGELIST_JSON = {
  code: 0, message: 'OK', ttl: 1,
  data: [{
    cid: 137649199, page: 1, part: 'Never Gonna Give You Up - Rick Astley', duration: 213,
    dimension: { width: 1920, height: 1080, rotate: 0 }
  }]
};
const VIDEOSHOT_JSON = {
  code: 0, message: 'OK', ttl: 1,
  data: {
    img_x_len: 10, img_y_len: 10, img_x_size: 160, img_y_size: 90,
    image: ['//i0.hdslb.com/bfs/videoshot/137649199.jpg'], index: [0, 0, 5, 11]
  }
};

function makeFetch({ search = SEARCH_JSON, pagelist = PAGELIST_JSON, shot = VIDEOSHOT_JSON, fail = {} } = {}) {
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } });
    if (url.includes('search/type')) { if (fail.search) throw new Error('boom'); return json(search); }
    if (url.includes('pagelist')) { if (fail.pagelist) throw new Error('boom'); return json(pagelist); }
    if (url.includes('videoshot')) { if (fail.shot) throw new Error('boom'); return json(shot); }
    return { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
  };
  impl.seen = seen;
  return impl;
}

const full = await resolveVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7', { fetchImpl: makeFetch() });
check('解析成功', full.ok, true);
check('标题去掉高亮标签', full.title, 'Never Gonna Give You Up');
check('作者', full.author, '索尼音乐中国');
check('时长（来自 search）', full.durationSec, 213);
check('分区', full.category, 'MV');
check('标签拆分', full.tags, ['Rick Astley', '欧美MV', '流行音乐']);
check('播放量', full.stats.play, 107496384);
check('点赞量', full.stats.like, 2958711);
check('封面补协议', full.coverUrl, 'https://i1.hdslb.com/bfs/archive/cover.jpg');
check('关键帧补协议', full.framesUrl, 'https://i0.hdslb.com/bfs/videoshot/137649199.jpg');
check('雪碧图行列', full.framesGrid, { cols: 10, rows: 10, width: 160, height: 90 });
check('分辨率来自 pagelist', full.resolution, '1920×1080');
check('cid 传给了 videoshot', full.parts[0].cid, 137649199);

// 元信息主接口被限流（HTTP 412 + code=-412）时，要自动切到 search/all/v2
console.log('\n[3b] 搜索主接口被限流 → 备用接口兜底');
{
  // search/all/v2 的真实结构：data.result 是分组数组
  const ALL_V2 = {
    code: 0, message: 'OK', ttl: 1,
    data: {
      result: [
        { result_type: 'tips', data: [] },
        {
          result_type: 'video',
          data: [{
            type: 'video', aid: 80433022, bvid: 'BV1GJ411x7h7',
            author: '索尼音乐中国', mid: 486906719, typename: 'MV',
            title: '【官方 MV】Never Gonna Give You Up - Rick Astley',
            description: '备用接口来的简介',
            pic: '//i1.hdslb.com/bfs/archive/cover.jpg',
            play: 107496739, danmaku: 151046, like: 2958722, favorites: 1556491, review: 238230,
            tag: 'Rick Astley,欧美MV', pubdate: 1577835803, duration: '3:33'
          }]
        }
      ]
    }
  };
  const impl = async (url) => {
    const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } });
    if (url.includes('search/type')) return { ok: false, status: 412, text: async () => JSON.stringify({ code: -412, message: '请求被拦截' }), headers: { get: () => null } };
    if (url.includes('search/all/v2')) return json(ALL_V2);
    if (url.includes('pagelist')) return json(PAGELIST_JSON);
    if (url.includes('videoshot')) return json(VIDEOSHOT_JSON);
    return { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
  };
  const r = await resolveVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7', { fetchImpl: impl });
  check('仍能解析成功', r.ok, true);
  check('标题来自备用接口', r.title, '【官方 MV】Never Gonna Give You Up - Rick Astley');
  check('简介来自备用接口', r.description, '备用接口来的简介');
  ok('notes 里说明走了备用接口', (r.notes || []).some((n) => /备用接口/.test(n)), JSON.stringify(r.notes));
  ok('notes 里记录了主接口的 -412', (r.notes || []).some((n) => /-412/.test(n)), JSON.stringify(r.notes));
}

// ── 3c. av 号链接：拿不到 bvid，必须靠 aid 通道 ────────────────────────
console.log('\n[3c] av 号链接（aid 通道）');
{
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    const json = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b), headers: { get: () => null } });
    // 两条搜索接口都被限流（412 环境的真实形态）
    if (url.includes('search/')) return { ok: false, status: 412, text: async () => JSON.stringify({ code: -412 }), headers: { get: () => null } };
    if (url.includes('pagelist')) return json(PAGELIST_JSON);
    if (url.includes('videoshot')) return json(VIDEOSHOT_JSON);
    return { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
  };
  const r = await resolveVideoLink('https://www.bilibili.com/video/av80433022', { fetchImpl: impl });
  check('搜索全 412 时 av 链接仍能解析', r.ok, true);
  check('分P 通过 aid 拿到', r.parts?.[0]?.cid, 137649199);
  check('时长来自分P', r.durationSec, 213);
  ok('pagelist 用的是 aid 参数', seen.some((u) => u.includes('pagelist') && u.includes('aid=80433022')), seen.join(' | '));
  ok('关键帧也走 aid', seen.some((u) => u.includes('videoshot') && u.includes('aid=')), seen.join(' | '));
}

// ── 3d. ?p= 越界要说清楚取的是哪一 P ───────────────────────────────────
console.log('\n[3d] ?p= 越界');
{
  const r = await resolveVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7?p=99', { fetchImpl: makeFetch() });
  check('pageIndex 被拉回真实值', r.pageIndex, 1);
  ok('给出越界提示', /第 99 P 不存在/.test(r.pageNote || ''), JSON.stringify(r.pageNote));
  ok('提示会渲染进给模型的文本', /第 99 P 不存在/.test(describeVideo(r)), describeVideo(r));
}

// ── 3e. notes 不能把技术细节泄漏给模型 ─────────────────────────────────
console.log('\n[3e] notes 不泄漏');
{
  const r = await resolveVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7', { fetchImpl: makeFetch({ fail: { search: true } }) });
  const text = describeVideo(r);
  ok('原始 notes 里确实有技术细节', JSON.stringify(r.notes).length > 10, JSON.stringify(r.notes));
  ok('但渲染文本里没有接口名', !/search\/type|search\/all/.test(text), text);
  ok('也没有 code=', !/code=/.test(text), text);
}

// ── 3f. search/type 返回 code:0 但结果为空 → 必须回落 all/v2 ──────────────
console.log('\n[3f] 主接口"成功但空结果"也要回落');
{
  const impl = async (url) => {
    const json = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b), headers: { get: () => null } });
    if (url.includes('search/type')) return json({ code: 0, data: { result: [] } });
    if (url.includes('search/all/v2')) return json({ code: 0, data: { result: [{ result_type: 'video', data: [{ bvid: 'BV1GJ411x7h7', title: '来自 all/v2', aid: 80433022 }] }] } });
    if (url.includes('pagelist')) return json(PAGELIST_JSON);
    if (url.includes('videoshot')) return json(VIDEOSHOT_JSON);
    return { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
  };
  const r = await resolveVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7', { fetchImpl: impl });
  check('空结果时回落成功', r.title, '来自 all/v2');
}

// videoCandidates 要能同时吃两种结构
{
  const typeShape = { data: { result: [{ bvid: 'BV1aa', title: 'a' }] } };
  const allShape = { data: { result: [{ result_type: 'video', data: [{ bvid: 'BV1bb' }] }, { result_type: 'tips', data: [] }] } };
  check('search/type 结构', videoCandidates(typeShape).map((v) => v.bvid), ['BV1aa']);
  check('search/all/v2 结构', videoCandidates(allShape).map((v) => v.bvid), ['BV1bb']);
  check('空数据不炸', videoCandidates({}), []);
}

// 元信息接口挂了也要能用分P 兜底（分P 有 title/duration）
const noSearch = await resolveVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7', { fetchImpl: makeFetch({ fail: { search: true } }) });
check('搜索接口失败仍算成功', noSearch.ok, true);
check('分P 仍在', noSearch.parts.length, 1);
ok('两条搜索通道的失败都记进 notes', noSearch.notes.filter((n) => /失败/.test(n)).length >= 2, JSON.stringify(noSearch.notes));

// 全部接口失败 → 必须明确失败，不能返回空对象让模型瞎猜
const allFail = await resolveVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7',
  { fetchImpl: makeFetch({ fail: { search: true, pagelist: true, shot: true } }) });
check('全挂了就 ok:false', allFail.ok, false);
ok('失败带原因', String(allFail.reason || '').length > 0, JSON.stringify(allFail));

// 非视频链接 → unsupported，调用方回落到普通网页抓取
const notVideo = await resolveVideoLink('https://example.com/x', { fetchImpl: makeFetch() });
check('非视频链接标记 unsupported', notVideo.unsupported, true);

// 浏览锁定：按用户给的原链接判定，锁定拒绝时一次接口都不该发
const lockedFetch = makeFetch();
const locked = await resolveVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7', {
  fetchImpl: lockedFetch, browseLocked: true,
  checkLock: () => ({ enabled: true, host: 'www.bilibili.com', allowed: false })
});
check('锁定拒绝', locked.blocked, true);
check('锁定拒绝时不发请求', lockedFetch.seen.length, 0);

// 锁定放行时**必须**真的发请求（只测拒绝证明不了放行没被误判成拒绝）
const allowedFetch = makeFetch();
const allowed = await resolveVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7', {
  fetchImpl: allowedFetch, browseLocked: true,
  checkLock: () => ({ enabled: true, host: 'www.bilibili.com', allowed: true })
});
check('锁定放行后解析成功', allowed.ok, true);
ok('锁定放行后确实发了请求', allowedFetch.seen.length > 0, String(allowedFetch.seen.length));

// 短链展开：只跟 Location，落到真实视频页
console.log('\n[4] 短链展开');
const shortFetch = async (url) => {
  if (String(url).includes('b23.tv')) {
    return { ok: true, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://www.bilibili.com/video/BV1GJ411x7h7' : null) } };
  }
  return { ok: false, status: 404, headers: { get: () => null } };
};
check('短链展开结果', await expandShortUrl('https://b23.tv/abc', { fetchImpl: shortFetch }),
  'https://www.bilibili.com/video/BV1GJ411x7h7');
const shortResolved = await resolveVideoLink('https://b23.tv/abc', {
  fetchImpl: async (url) => (String(url).includes('b23.tv') ? shortFetch(url) : makeFetch()(url))
});
check('短链可以直接解析成视频信息', shortResolved.ok, true);
check('短链解析出的标题', shortResolved.title, 'Never Gonna Give You Up');

// 短链展开到站外：白名单只写了 b23.tv 也不该放行（逐跳复检）
{
  const offsite = async (url) => {
    if (String(url).includes('b23.tv')) {
      return { ok: true, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://evil.example.com/video/BV1GJ411x7h7' : null) } };
    }
    return { ok: false, status: 404, headers: { get: () => null } };
  };
  const r = await resolveVideoLink('https://b23.tv/abc', {
    fetchImpl: offsite,
    browseLocked: true,
    // 白名单只放行 b23.tv，展开后的 evil.example.com 不在里面
    checkLock: (u) => ({ enabled: true, host: (() => { try { return new URL(u).hostname; } catch { return ''; } })(), allowed: String(u).includes('b23.tv') })
  });
  ok('短链跳到站外时被拦住', r.blocked === true, JSON.stringify(r));
  ok('拦截原因提到展开后的域名', /evil\.example\.com/.test(r.reason || ''), r.reason);
}

// 短链自指循环：不能无限跟下去
{
  let hops = 0;
  const loop = async () => {
    hops++;
    return { ok: true, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://b23.tv/loop' : null) } };
  };
  const out = await expandShortUrl('https://b23.tv/loop', { fetchImpl: loop });
  ok('自指循环会被跳数上限截断', hops <= 3, `hops=${hops}`);
  check('最终仍停在短链上', out, 'https://b23.tv/loop');
}

// ── 5. 给模型的说明文字 ─────────────────────────────────────────────────
console.log('\n[5] describeVideo');
const text = describeVideo(full);
ok('含标题', text.includes('Never Gonna Give You Up'), text);
ok('含 UP 主', text.includes('索尼音乐中国'), text);
ok('含时长', text.includes('3 分 33 秒'), text);
ok('含播放量', text.includes('1.07 亿'), text);
ok('含关键帧提示', text.includes('关键帧'), text);
ok('含原始链接', text.includes('https://www.bilibili.com/video/BV1GJ411x7h7'), text);
ok('不出现 undefined', !text.includes('undefined'), text);

// ── 6. 状态码人话 ───────────────────────────────────────────────────────
console.log('\n[6] describeHttpStatus');
const safeRel = CANDIDATES.map((p) => path.resolve(__dirname, p.replace('video-link', 'safe-fetch')))
  .find((p) => existsSync(p));
const { describeHttpStatus } = await import(`file://${safeRel.replace(/\\/g, '/')}`);
ok('412 说明反爬', /反爬/.test(describeHttpStatus(412) || ''), describeHttpStatus(412));
ok('429 说明限流', /限流/.test(describeHttpStatus(429) || ''), describeHttpStatus(429));
ok('403 说明拒绝', /403/.test(describeHttpStatus(403) || ''), describeHttpStatus(403));
ok('502 说明网关故障', /故障/.test(describeHttpStatus(502) || ''), describeHttpStatus(502));
check('200 无特殊含义', describeHttpStatus(200), null);
check('404 无特殊含义', describeHttpStatus(404), null);

// ── 汇总 ───────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('❌ 有用例未通过'); process.exit(1); }
console.log('✅ 全部通过');
