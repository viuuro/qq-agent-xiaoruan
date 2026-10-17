#!/usr/bin/env node
// 本地图库核心逻辑测试（不依赖 QQ / 网络 / 外部依赖）。
//
// 覆盖本次改动的关键承诺：
//   · 分类 = 文件夹：新建/重命名/删除（非空必须先移走）
//   · 存入常规格式（PNG/JPG/GIF/WebP/BMP）、魔数校验、重复内容不重复占盘
//   · 文件夹是唯一真相：手动放进分类目录的图片能自动出现
//   · 移动图片会真的搬文件；删除只删指定文件
//   · index.json 损坏时能从磁盘重建，不丢图片
//
// 用法：node tools/test-image-gallery.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GalleryStore, GalleryError, DEFAULT_CATEGORY, normalizeCategoryName } from '../app/src/gallery.js';
import { detectImageType } from '../app/src/image-type.js';

let passed = 0;
function ok(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('ok() 不支持异步，请用 aok()');
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}\n     ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}
async function aok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}\n     ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}
function expectThrows(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GalleryError, `应抛 GalleryError，实际：${error}`);
    if (code) assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}`);
    return error;
  }
  throw new Error('预期抛错但没有');
}

// ── 构造最小但魔数合法的图片字节 ──────────────────────────────────────
function pngBytes(width = 16, height = 12) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 2;
  return b;
}
function gifBytes(width = 32, height = 24) {
  const b = Buffer.alloc(32);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}
function jpegBytes(width = 40, height = 30) {
  const b = Buffer.alloc(32);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(17, 4);
  b[6] = 8;
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}
function webpBytes(width = 50, height = 40) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}
function bmpBytes(width = 64, height = 48) {
  const b = Buffer.alloc(64);
  b[0] = 0x42; b[1] = 0x4d;
  b.writeInt32LE(54, 10);
  b.writeInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  return b;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-gallery-test-'));
console.log(`图库测试目录：${root}\n`);
const gallery = new GalleryStore({ root });

console.log('1) 图片类型嗅探');
ok('PNG 识别', () => assert.equal(detectImageType(pngBytes())?.mime, 'image/png'));
ok('JPEG 识别', () => assert.equal(detectImageType(jpegBytes())?.mime, 'image/jpeg'));
ok('GIF 识别', () => assert.equal(detectImageType(gifBytes())?.mime, 'image/gif'));
ok('WebP 识别', () => assert.equal(detectImageType(webpBytes())?.mime, 'image/webp'));
ok('BMP 识别（本次新增）', () => assert.equal(detectImageType(bmpBytes())?.mime, 'image/bmp'));

console.log('\n2) 分类 = 文件夹');
ok('默认分类首次访问时创建', () => {
  gallery.list({ refresh: true });
  assert.ok(fs.statSync(path.join(root, DEFAULT_CATEGORY)).isDirectory());
});
ok('新建分类会创建同名文件夹', () => {
  const r = gallery.createCategory('风景');
  assert.equal(r.created, true);
  assert.ok(fs.statSync(path.join(root, '风景')).isDirectory());
});
ok('重复新建同一分类是幂等的', () => {
  const r = gallery.createCategory('风景');
  assert.equal(r.created, false);
  assert.equal(r.name, '风景');
});
ok('大小写不同视为同一分类', () => {
  gallery.createCategory('Scenery');
  const r = gallery.createCategory('scenery');
  assert.equal(r.created, false);
  assert.equal(r.name, 'Scenery');
});
ok('非法分类名被拒绝', () => {
  assert.equal(normalizeCategoryName('a/b').ok, false);
  assert.equal(normalizeCategoryName('..').ok, false);
  assert.equal(normalizeCategoryName('CON').ok, false);
  expectThrows(() => gallery.createCategory('a/b'), 'bad-category');
});

console.log('\n3) 入库闸门（管理端唯一写入口）');
ok('智能体 actor 一律拒绝入库', () => {
  const error = expectThrows(
    () => gallery.saveBuffer(pngBytes(4, 4), { category: '风景', actor: 'model' }),
    'chat-write-forbidden'
  );
  assert.equal(error.status, 403);
});
ok('缺省 actor（fail-closed）同样被拒绝', () => {
  expectThrows(() => gallery.saveBuffer(pngBytes(4, 3), { category: '风景' }), 'chat-write-forbidden');
});
ok('管理端上传（actor=admin）可以入库', () => {
  const r = gallery.saveBuffer(pngBytes(5, 5), { category: '风景', actor: 'admin' });
  assert.equal(r.duplicate, false);
  gallery.remove(r.entry.id);
});

console.log('\n4) 存入图片（常规格式）');
let pngEntry;
ok('存入 PNG 到「风景」，文件落在分类文件夹里', () => {
  const r = gallery.saveBuffer(pngBytes(16, 12), {
    category: '风景', title: '山', tags: ['山', '风景'], source: 'upload', originalName: 'mountain.png', actor: 'admin'
  });
  assert.equal(r.duplicate, false);
  pngEntry = r.entry;
  assert.equal(pngEntry.category, '风景');
  assert.equal(pngEntry.width, 16);
  assert.equal(pngEntry.height, 12);
  assert.equal(pngEntry.mime, 'image/png');
  assert.ok(fs.existsSync(path.join(root, '风景', `${pngEntry.id}.png`)));
});
ok('完全相同的内容不重复占盘', () => {
  const r = gallery.saveBuffer(pngBytes(16, 12), { category: '风景', title: '重复', actor: 'admin' });
  assert.equal(r.duplicate, true);
  assert.equal(r.entry.id, pngEntry.id);
  const files = fs.readdirSync(path.join(root, '风景')).filter((f) => f.endsWith('.png'));
  assert.equal(files.length, 1);
});
ok('未指定分类存入「未分类」', () => {
  const r = gallery.saveBuffer(jpegBytes(40, 30), { title: 'JPG', actor: 'admin' });
  assert.equal(r.entry.category, DEFAULT_CATEGORY);
  assert.equal(r.entry.width, 40);
  assert.equal(r.entry.height, 30);
});
ok('GIF / WebP / BMP 都能存', () => {
  const gif = gallery.saveBuffer(gifBytes(32, 24), { title: 'GIF', actor: 'admin' }).entry;
  const webp = gallery.saveBuffer(webpBytes(50, 40), { title: 'WebP', actor: 'admin' }).entry;
  const bmp = gallery.saveBuffer(bmpBytes(64, 48), { title: 'BMP', actor: 'admin' }).entry;
  assert.equal(gif.mime, 'image/gif');
  assert.equal(webp.mime, 'image/webp');
  assert.equal(bmp.mime, 'image/bmp');
  assert.equal(webp.width, 50);
  assert.equal(webp.height, 40);
  assert.equal(bmp.width, 64);
});
ok('非图片字节被拒绝（415）', () => {
  const error = expectThrows(() => gallery.saveBuffer(Buffer.from('<html>not an image</html>'), { actor: 'admin' }), 'unsupported-image');
  assert.equal(error.status, 415);
});
ok('分类不存在时拒绝存入（并回传现有分类）', () => {
  const error = expectThrows(
    () => gallery.saveBuffer(pngBytes(8, 8), { category: '不存在的分类', actor: 'admin' }),
    'category-not-found'
  );
  assert.ok(Array.isArray(error.details.categories));
  assert.ok(error.details.categories.includes('风景'));
});
ok('明确要求时可新建分类并存入', () => {
  const r = gallery.saveBuffer(pngBytes(9, 9), { category: '新建的', createCategory: true, title: '自动建', actor: 'admin' });
  assert.equal(r.entry.category, '新建的');
  assert.ok(fs.statSync(path.join(root, '新建的')).isDirectory());
});

console.log('\n5) 查询 / 搜索');
ok('列表返回分类计数与全库张数', () => {
  const data = gallery.list({ limit: 100, refresh: true });
  assert.equal(data.totalAll, 6);
  assert.equal(data.stats.total, 6);
  const landscape = data.categories.find((c) => c.name === '风景');
  assert.equal(landscape.count, 1);
  assert.ok(data.images.every((i) => i.id && i.category));
});
ok('按分类过滤', () => {
  const data = gallery.list({ category: '风景', refresh: true });
  assert.equal(data.total, 1);
  assert.equal(data.images[0].title, '山');
});
ok('按标题/标签搜索', () => {
  assert.equal(gallery.list({ query: '山', refresh: true }).total, 1);
  assert.equal(gallery.list({ query: '风景', refresh: true }).total, 1);
});
ok('分类不存在的过滤返回空而不是报错', () => {
  assert.equal(gallery.list({ category: '没有这个', refresh: true }).total, 0);
});

console.log('\n6) 编辑 / 移动（会真的搬文件）');
ok('修改标题、标签、描述', () => {
  const updated = gallery.update(pngEntry.id, { title: '新的山', tags: 'a,b', description: '备注' });
  assert.equal(updated.title, '新的山');
  assert.deepEqual(updated.tags, ['a', 'b']);
  assert.equal(updated.description, '备注');
});
ok('移动到其他分类：文件跟着搬家', () => {
  const oldPath = path.join(root, '风景', `${pngEntry.id}.png`);
  const updated = gallery.update(pngEntry.id, { category: DEFAULT_CATEGORY });
  assert.equal(updated.category, DEFAULT_CATEGORY);
  assert.equal(fs.existsSync(oldPath), false);
  assert.ok(fs.existsSync(path.join(root, DEFAULT_CATEGORY, `${pngEntry.id}.png`)));
});
await aok('resolveFile 返回受控路径', async () => {
  const r = await gallery.resolveFile(pngEntry.id);
  assert.ok(fs.existsSync(r.path));
  assert.ok(path.resolve(r.path).startsWith(path.resolve(root) + path.sep));
});

console.log('\n7) 重命名 / 删除分类');
ok('重命名分类会重命名文件夹并更新索引', () => {
  const r = gallery.renameCategory('风景', '山景');
  assert.equal(r.to, '山景');
  assert.equal(fs.existsSync(path.join(root, '风景')), false);
  assert.ok(fs.statSync(path.join(root, '山景')).isDirectory());
  assert.equal(gallery.list({ refresh: true }).categories.some((c) => c.name === '山景'), true);
});
ok('非空分类直接删除会被拒绝（409）', () => {
  gallery.saveBuffer(jpegBytes(10, 10), { category: '山景', title: '待删', actor: 'admin' });
  const error = expectThrows(() => gallery.removeCategory('山景'), 'category-not-empty');
  assert.equal(error.status, 409);
  assert.ok(error.details.count >= 1);
});
ok('给出 moveTo 时先移图再删空目录', () => {
  const r = gallery.removeCategory('山景', { moveTo: DEFAULT_CATEGORY });
  assert.ok(r.moved >= 1);
  assert.equal(fs.existsSync(path.join(root, '山景')), false);
  assert.equal(gallery.list({ refresh: true }).categories.some((c) => c.name === '山景'), false);
});
ok('默认分类不能被删除/重命名', () => {
  expectThrows(() => gallery.removeCategory(DEFAULT_CATEGORY), 'default-category');
  expectThrows(() => gallery.renameCategory(DEFAULT_CATEGORY, '别的'), 'default-category');
});

console.log('\n8) 文件夹是唯一真相（手动放图）');
ok('手动放进分类目录的图片刷新后自动出现', () => {
  gallery.createCategory('手放');
  fs.writeFileSync(path.join(root, '手放', 'manual-note.png'), pngBytes(20, 10));
  const data = gallery.list({ refresh: true, limit: 100 });
  const manual = data.images.find((i) => i.filename === 'manual-note.png');
  assert.ok(manual, '手动放入的图片应被索引');
  assert.equal(manual.category, '手放');
  assert.ok(manual.id.startsWith('m_'));
  assert.equal(manual.width, 20);
});
ok('伪装成 .png 的非图片不会被索引', () => {
  fs.writeFileSync(path.join(root, '手放', 'fake.png'), '<html>no</html>');
  const data = gallery.list({ refresh: true, limit: 100 });
  assert.equal(data.images.some((i) => i.filename === 'fake.png'), false);
});
ok('删除单张图片只删指定文件', () => {
  const data = gallery.list({ refresh: true, limit: 100 });
  const manual = data.images.find((i) => i.filename === 'manual-note.png');
  gallery.remove(manual.id);
  assert.equal(fs.existsSync(path.join(root, '手放', 'manual-note.png')), false);
  assert.equal(gallery.get(manual.id), null);
});

console.log('\n9) 索引损坏可重建');
ok('index.json 损坏时备份并从磁盘重建，不丢图片', () => {
  const before = gallery.list({ refresh: true, limit: 100 }).totalAll;
  fs.writeFileSync(path.join(root, 'index.json'), '{ this is not json', 'utf8');
  const rebuilt = new GalleryStore({ root });
  const data = rebuilt.list({ refresh: true, limit: 100 });
  assert.equal(data.totalAll, before);
  const backups = fs.readdirSync(root).filter((n) => n.startsWith('index.json.corrupt-'));
  assert.ok(backups.length >= 1, '应生成损坏索引备份');
});

console.log(`\n${process.exitCode ? '❌ 有测试失败' : `✅ 全部通过（${passed} 项）`}`);
console.log(`测试目录保留在 ${root}（没有递归删除测试数据）`);
