#!/usr/bin/env node
// 图库「智能体工具」集成测试（只读版）：
//   · 只注册 list_gallery / view_gallery_image
//   · 不存在 send_gallery_image / save_gallery_image（管理端是唯一写入口）
//   · list_gallery 能看分类与图片；view_gallery_image 能返回视觉模型可读的 parts
//   · 图库数据由管理端上传（actor:'admin'）准备
//
// 用法：node tools/test-gallery-tools.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-gallery-tools-'));
process.env.QQ_AGENT_DATA_DIR = dataRoot;

const { buildToolDefs } = await import('../app/src/tools.js');
const { getTool } = await import('../app/src/tool-registry.js');
const { getGallery } = await import('../app/src/gallery.js');

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}\n     ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}

function pngBytes(width = 16, height = 12, fill = 0) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 2;
  b[26] = fill;
  return b;
}

function parse(result) {
  assert.ok(result && typeof result.content === 'string', '工具应返回文本 content');
  return JSON.parse(result.content);
}

function makeCtx() {
  return {
    chatKey: 'group:123',
    kind: 'group',
    chatId: '123',
    selfId: '1',
    botName: '小软',
    session: { id: 's_test', triggerText: '看图库', trigger: [], sent: [] },
    store: { findByMid: () => null },
    onebot: { httpUrl: 'http://127.0.0.1:3000', call: async () => null },
    sender: { sendImage: async () => { throw new Error('聊天侧不应有发送图库图片的能力'); } },
    emit: () => {}
  };
}

const defs = buildToolDefs();
assert.ok(defs.length > 0);

console.log(`工具测试数据目录：${dataRoot}\n`);

await ok('图库工具只剩只读的 list_gallery / view_gallery_image', async () => {
  assert.ok(getTool('list_gallery'));
  assert.ok(getTool('view_gallery_image'));
  assert.equal(getTool('send_gallery_image'), null, '聊天侧不能发送图库图片');
  assert.equal(getTool('save_gallery_image'), null, '聊天侧不能存入图库');
});

await ok('list_gallery 能返回空图库与分类', async () => {
  const tool = getTool('list_gallery');
  assert.equal(tool.category, 'gallery');
  const out = parse(await tool.execute(makeCtx(), {}));
  assert.equal(out.libraryTotal, 0);
  assert.match(out.categories, /未分类/);
  assert.match(out.note, /管理员/);
});

await ok('管理端上传（actor=admin）准备一张图片', async () => {
  const r = getGallery().saveBuffer(pngBytes(24, 18, 9), {
    category: '未分类',
    title: '测试图',
    tags: ['测试'],
    originalName: 'test.png',
    source: 'upload',
    actor: 'admin'
  });
  assert.equal(r.duplicate, false);
  assert.ok(fs.existsSync(path.join(dataRoot, 'image-gallery', '未分类', `${r.entry.id}.png`)));
});

await ok('list_gallery 能看到管理端存入的图片', async () => {
  const out = parse(await getTool('list_gallery').execute(makeCtx(), { limit: 20 }));
  assert.equal(out.libraryTotal, 1);
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].title, '测试图');
  assert.match(out.note, /只读/);
});

await ok('view_gallery_image 返回 image_url 部件', async () => {
  const listed = parse(await getTool('list_gallery').execute(makeCtx(), { limit: 5 }));
  const imageId = listed.images[0].imageId;
  const result = await getTool('view_gallery_image').execute(makeCtx(), { imageId });
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[1].type, 'image_url');
  assert.ok(result.content[1].image_url.url.startsWith('data:image/png;base64,'));
});

await ok('view_gallery_image 找不到 id 时给出可操作提示', async () => {
  const result = await getTool('view_gallery_image').execute(makeCtx(), { imageId: 'g_nope_0000' });
  assert.equal(result.isError, true);
  assert.match(result.content, /list_gallery/);
});

await ok('list_gallery 支持按分类过滤', async () => {
  const out = parse(await getTool('list_gallery').execute(makeCtx(), { category: '未分类', limit: 20 }));
  assert.equal(out.matched, 1);
  const none = parse(await getTool('list_gallery').execute(makeCtx(), { category: '没有这个分类' }));
  assert.equal(none.matched, 0);
});

await ok('save_gallery_image 工具已移除（不会出现在模型工具列表）', async () => {
  const ids = defs.map((d) => d.id);
  assert.equal(ids.includes('save_gallery_image'), false);
  assert.equal(ids.includes('send_gallery_image'), false);
});

console.log(`\n${process.exitCode ? '❌ 有测试失败' : `✅ 全部通过（${passed} 项）`}`);
console.log(`测试目录保留在 ${dataRoot}（没有递归删除测试数据）`);
