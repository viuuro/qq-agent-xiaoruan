// ============================================================================
//  probe-kb-search.mjs —— 验证知识库能否检索到指定内容
//
//  用途：往 knowledge/ 加了文档、同步进知识库后，确认"机器人真的能搜到"。
//        比看 .index.json 可靠 —— 那个文件只存元数据（rel/title/bytes/sections），
//        不含正文，所以搜不到人名不代表没索引成功（本项目踩过这个判断错误）。
//
//  原理：直接调用知识库插件导出的 buildIndex() / search()，走真实检索路径。
//
//  用法（在服务器上，容器内执行）：
//      docker cp tools/probe-kb-search.mjs qq-agent:/tmp/
//      timeout 40 docker exec qq-agent node /tmp/probe-kb-search.mjs "会长是谁" "李轩"
//      docker exec qq-agent rm -f /tmp/probe-kb-search.mjs
//
//  不带参数时跑一组默认查询（软协名单相关）。
//
//  ⚠️ 必须 process.exit()：插件模块会注册 watcher/定时器，不退出进程会挂住
//     （本项目就因此挂过一次 docker exec，得手工 kill）。
// ============================================================================

const KB = '/app/plugins/knowledge-base/index.js';
const queries = process.argv.slice(2);
const DEFAULT_QUERIES = ['会长是谁', '软件部部长是谁', '团支书', '学长'];

for (const q of (queries.length ? queries : DEFAULT_QUERIES)) {
  // 留个占位，下面填充
  void q;
}

try {
  const m = await import(KB);

  try {
    m.buildIndex({ reason: 'probe' });
  } catch (e) {
    console.log('buildIndex 失败:', e && e.message);
  }
  await new Promise((r) => setTimeout(r, 300));

  const st = m.status?.() || {};
  console.log('索引: %s 个文档 / %s 段',
    st.docs ?? st.fileCount ?? '?', st.sections ?? st.sectionCount ?? '?');
  console.log();

  const list = queries.length ? queries : DEFAULT_QUERIES;
  let totalHits = 0;

  for (const q of list) {
    const r = m.search(q, { limit: 3 });
    const hits = r.hits || [];
    totalHits += hits.length;
    console.log('查询「%s」→ 命中 %d 条（共 %s 段）', q, hits.length, r.total);
    for (const h of hits) {
      // 插件返回的字段：ref / doc / docTitle / heading / source / score / excerpt
      const doc = h.doc || h.docTitle || h.rel || '?';
      const heading = h.heading || '';
      const score = typeof h.score === 'number' ? h.score.toFixed(3) : h.score;
      console.log('  · %s   score=%s', doc, score);
      if (heading) console.log('    %s', heading);
      if (h.excerpt) console.log('    %s', String(h.excerpt).replace(/\s+/g, ' ').slice(0, 120));
    }
    console.log();
  }

  console.log('总计命中 %d 条。为 0 说明内容没进索引，检查：\n' +
    '  1) 文件是否在 /opt/qq/qq-agent-data/knowledge-base/（不能在 learned/ 里混放）\n' +
    '  2) 扩展名是否 .md/.txt/.markdown\n' +
    '  3) 是否 ≥8 个字符（MIN_SECTION_CHARS）', totalHits);
} catch (e) {
  console.log('探测失败:', e && (e.stack || e.message));
}

process.exit(0);
