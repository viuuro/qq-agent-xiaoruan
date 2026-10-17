#!/usr/bin/env node
// 图库 HTTP 路由集成测试：不启动 QQ、不连网，直接调用声明式路由 handler。
//
// 覆盖：
//   · GET /api/gallery（分类/图片/存储路径）
//   · POST /api/gallery/categories（新建文件夹）
//   · POST /api/gallery/images（原始二进制上传 + 分类/文件名）
//   · GET /api/gallery/file/:id（图片字节 / 下载头）
//   · PATCH /api/gallery/images/:id（改标题/标签/移动分类）
//   · DELETE /api/gallery/images/:id（只删指定图片）
//   · DELETE /api/gallery/categories（非空必须先移图）
//
// 依赖：先在 app/ 里 npm install（路由模块会 import ws / undici / js-yaml）。
// 用法：node tools/test-gallery-routes.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-gallery-routes-'));
process.env.QQ_AGENT_DATA_DIR = dataRoot;

const { createRoutes } = await import('../app/src/routes.js');
const { getGallery } = await import('../app/src/gallery.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../app/src/config.js');
// 从出厂默认值开始（图库写入口只有管理端上传，actor:'admin'）
setRuntimeConfig(structuredClone(DEFAULT_CONFIG));

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

// 只给图库路由需要的依赖；其它 handler 不会被调用，缺省即可。
const routes = createRoutes({
  readBody: async (req) => (req.bodyText ? JSON.parse(req.bodyText) : {}),
  log: () => {},
  emit: () => {}
});

function findRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== '*' && route.method !== method) continue;
    if (typeof route.pattern === 'string') {
      if (route.pattern === pathname) return { route, match: null };
    } else {
      const match = route.pattern.exec(pathname);
      if (match) return { route, match };
    }
  }
  return null;
}

function jsonWriter(res, code, data) {
  res.statusCode = code;
  res.jsonBody = data;
  return undefined;
}

async function call(method, pathname, { body = undefined, raw = undefined } = {}) {
  const url = new URL(`http://127.0.0.1${pathname}`);
  const found = findRoute(method, url.pathname);
  assert.ok(found, `找不到路由 ${method} ${url.pathname}`);
  const req = raw
    ? {
      [Symbol.asyncIterator]: async function* iterate() {
        yield raw;
      }
    }
    : { bodyText: body === undefined ? '' : JSON.stringify(body) };
  const res = {
    statusCode: 200,
    headers: null,
    jsonBody: undefined,
    body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(chunk) { this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? '')); }
  };
  await found.route.handler({ req, res, url, pathname: url.pathname, method, match: found.match, json: jsonWriter });
  return res;
}

function pngBytes(width = 12, height = 8) {
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

console.log(`路由测试数据目录：${dataRoot}\n`);
let imageId = '';

await ok('GET /api/gallery 初始为空并返回存储路径', async () => {
  const res = await call('GET', '/api/gallery');
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.equal(res.jsonBody.totalAll, 0);
  assert.ok(res.jsonBody.root.includes('image-gallery'));
  assert.equal(res.jsonBody.categories[0].name, '未分类');
});

await ok('POST /api/gallery/categories 创建分类文件夹', async () => {
  const res = await call('POST', '/api/gallery/categories', { body: { name: '测试分类' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.equal(res.jsonBody.name, '测试分类');
  assert.ok(fs.statSync(path.join(dataRoot, 'image-gallery', '测试分类')).isDirectory());
});

await ok('POST /api/gallery/images 原始二进制上传', async () => {
  const res = await call('POST', '/api/gallery/images?category=%E6%B5%8B%E8%AF%95%E5%88%86%E7%B1%BB&filename=hello.png', {
    raw: pngBytes(24, 18)
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.equal(res.jsonBody.duplicate, false);
  imageId = res.jsonBody.image.id;
  assert.equal(res.jsonBody.image.category, '测试分类');
  assert.equal(res.jsonBody.image.width, 24);
  assert.equal(res.jsonBody.image.height, 18);
  assert.ok(fs.existsSync(path.join(dataRoot, 'image-gallery', '测试分类', `${imageId}.png`)));
});

await ok('重复上传相同内容返回 duplicate 且不重复占盘', async () => {
  const res = await call('POST', '/api/gallery/images?category=%E6%B5%8B%E8%AF%95%E5%88%86%E7%B1%BB', {
    raw: pngBytes(24, 18)
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.duplicate, true);
  assert.equal(res.jsonBody.image.id, imageId);
});

await ok('GET /api/gallery 能看到新图片', async () => {
  const res = await call('GET', '/api/gallery?refresh=1');
  assert.equal(res.jsonBody.totalAll, 1);
  assert.equal(res.jsonBody.images[0].id, imageId);
  assert.equal(res.jsonBody.images[0].title, 'hello');
});

await ok('GET /api/gallery/file/:id 返回图片字节', async () => {
  const res = await call('GET', `/api/gallery/file/${imageId}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.deepEqual(res.body, pngBytes(24, 18));
});

await ok('GET /api/gallery/file/:id?download=1 带下载头', async () => {
  const res = await call('GET', `/api/gallery/file/${imageId}?download=1`);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-disposition']), /^attachment;/);
});

await ok('PATCH /api/gallery/images/:id 改标题与标签', async () => {
  const res = await call('PATCH', `/api/gallery/images/${imageId}`, {
    body: { title: '新标题', tags: '猫，测试' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.image.title, '新标题');
  assert.deepEqual(res.jsonBody.image.tags, ['猫', '测试']);
});

await ok('PATCH 移动分类会搬文件', async () => {
  const res = await call('PATCH', `/api/gallery/images/${imageId}`, {
    body: { category: '未分类' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.image.category, '未分类');
  assert.equal(fs.existsSync(path.join(dataRoot, 'image-gallery', '测试分类', `${imageId}.png`)), false);
  assert.ok(fs.existsSync(path.join(dataRoot, 'image-gallery', '未分类', `${imageId}.png`)));
});

await ok('DELETE 非空分类返回 409 且不删图', async () => {
  const res = await call('DELETE', '/api/gallery/categories', { body: { name: '未分类' } });
  // 默认分类本身也禁止删除，优先命中 default-category
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonBody.code, 'default-category');

  const again = await call('POST', '/api/gallery/categories', { body: { name: '待删分类' } });
  assert.equal(again.jsonBody.ok, true);
  await call('POST', '/api/gallery/images?category=%E5%BE%85%E5%88%A0%E5%88%86%E7%B1%BB', { raw: pngBytes(7, 7) });
  const res2 = await call('DELETE', '/api/gallery/categories', { body: { name: '待删分类' } });
  assert.equal(res2.statusCode, 409);
  assert.equal(res2.jsonBody.code, 'category-not-empty');
  assert.ok(fs.statSync(path.join(dataRoot, 'image-gallery', '待删分类')).isDirectory());
});

await ok('DELETE 分类带 moveTo 成功后删空目录', async () => {
  const res = await call('DELETE', '/api/gallery/categories', {
    body: { name: '待删分类', moveTo: '未分类' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.ok(res.jsonBody.moved >= 1);
  assert.equal(fs.existsSync(path.join(dataRoot, 'image-gallery', '待删分类')), false);
});

await ok('DELETE 图片只删指定文件', async () => {
  const before = (await call('GET', '/api/gallery?refresh=1')).jsonBody.totalAll;
  const res = await call('DELETE', `/api/gallery/images/${imageId}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  const after = (await call('GET', '/api/gallery?refresh=1')).jsonBody.totalAll;
  assert.equal(after, before - 1);
});

await ok('不存在的图片返回 404 JSON', async () => {
  const res = await call('GET', '/api/gallery/file/g_nope_00000000');
  assert.equal(res.statusCode, 404);
  assert.equal(res.jsonBody.ok, false);
});

await ok('分类名非法时返回 400', async () => {
  const res = await call('POST', '/api/gallery/categories', { body: { name: 'a/b' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonBody.code, 'bad-category');
});

// 确认图库单例就是本次数据目录（路由与智能体工具共用同一个实例）
const g = getGallery();
assert.equal(path.resolve(g.rootDir), path.resolve(dataRoot, 'image-gallery'));

console.log(`\n${process.exitCode ? '❌ 有测试失败' : `✅ 全部通过（${passed} 项）`}`);
console.log(`测试目录保留在 ${dataRoot}（没有递归删除测试数据）`);
