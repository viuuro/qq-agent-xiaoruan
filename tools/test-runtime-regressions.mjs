import assert from 'node:assert/strict';
import { watch as watchFs } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';
import { setRuntimeConfig, deepMerge, ROOT } from '../app/src/config.js';

const runtimeConfig = {
  api: { model: 'memory-test-model' },
  persona: { selfNickname: '小软', botName: '小软' },
  onebot: { selfId: '10001' },
  store: {
    contextSliderPos: 0,
    chatWindowMs: 120000,
    chatWindowProb: 100,
    chatWindowProbByGroup: {},
    historyCount: 8,
    keywords: []
  },
  chatActive: { enabled: false },
  skills: { runtime_regression: { enabled: true } }
};
setRuntimeConfig(runtimeConfig);

const [{ resolveContextTier, resolveWithChatWindow, isChatWindowSummon },
  { activateLoadedPlugins, loadPlugins, unloadSkill, watchPlugins }, { getTool, unregisterToolsBySkill },
  { validateZipStructure, unzipToModuleDir },
  { readLimitedResponseBody, installByCode, MAX_ZIP_BYTES, MAX_ERROR_RESPONSE_BYTES }] = await Promise.all([
  import('../app/src/prompt.js'),
  import('../app/src/plugin-loader.js'),
  import('../app/src/tool-registry.js'),
  import('../app/src/zip-install.js'),
  import('../app/src/market.js')
]);
const { skillManager } = await import('../app/src/skills/manager.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`[OK] ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`[FAIL] ${name}: ${error?.stack || error}`);
  }
}

function zipArchive(items) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8');
    const contents = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? '');
    const method = item.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(contents) : contents;
    const declaredSize = item.declaredSize ?? contents.length;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function streamResponse(chunks, contentLength = '') {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  return {
    body,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? contentLength : null }
  };
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-agent-runtime-regression-'));

try {
  await test('@ 权威标记统一控制档位和窗口，旧记录才回退文本', async () => {
    const context = { selfNickname: '小软', botName: '小软', selfId: '10001' };
    const cfg = { contextTier: 1, historyCount: 8, randomPercent: 0, keywords: [] };
    const evaluate = (entry) => {
      const resolved = resolveContextTier({ triggerEntries: [entry], ...context, cfg, roll: 100 });
      const summon = isChatWindowSummon([entry], context, resolved);
      return {
        resolved,
        summon,
        window: resolveWithChatWindow({
          atMe: summon, windowOpen: false, resolved, windowMs: 120000,
          equalCount: resolved.count, windowCount: 8
        })
      };
    };

    const sameNameOther = evaluate({ text: '@小软 你好', atMe: false, atNames: ['@小软'] });
    assert.equal(sameNameOther.resolved.shouldRespond, false, '权威 false 标记应压过同名文本');
    assert.equal(sameNameOther.summon, false, '同名他人 @ 不应被窗口 wrapper 识别为召唤');
    assert.equal(sameNameOther.window.windowOpen, false);

    const actualMention = evaluate({ text: '@群名片 你好', atMe: true, atNames: ['@群名片'] });
    assert.equal(actualMention.resolved.reason, '被艾特');
    assert.equal(actualMention.window.windowOpen, true, '真实 @ 即使群名片不同也应开窗');

    const legacyEntry = evaluate({ text: '@小软 旧格式消息' });
    assert.equal(legacyEntry.window.windowOpen, true, '旧记录缺少 atMe 时应回退文本匹配');
    const orchestratorSource = await fs.readFile(new URL('../app/src/orchestrator.js', import.meta.url), 'utf8');
    assert.match(orchestratorSource, /isChatWindowSummon\(triggerEntries, atCtx, base\)/,
      'orchestrator wrapper 必须复用被测的召唤 helper');
  });

  await test('插件 setup 失败不改旧工具/实例，也不重复 activate；成功后整体替换', async () => {
    const skillId = 'runtime_regression';
    const skillsRoot = path.join(tempRoot, 'plugin-skills');
    const pluginsRoot = path.join(tempRoot, 'plugin-plugins');
    const skillDir = path.join(skillsRoot, skillId);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(pluginsRoot, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'package.json'), JSON.stringify({ type: 'module' }));
    await fs.writeFile(path.join(skillDir, 'skill.json'), JSON.stringify({
      id: skillId, name: 'Runtime regression', version: '1.0.0', entry: 'index.js'
    }));
    const roots = { skills: skillsRoot, plugins: pluginsRoot };
    const writeEntry = async (source) => {
      await fs.writeFile(path.join(skillDir, 'index.js'), source, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const toolSource = (id) => `api.registerTool({id:${JSON.stringify(id)},name:${JSON.stringify(id)},execute:async()=>"ok"});`;
    const lifecyclePrelude = 'globalThis.__qqRuntimeRegression ||= { activate: 0, deactivate: 0, dispose: 0 };';

    try {
      await writeEntry(`${lifecyclePrelude}\nexport function setup(api){${toolSource('old_tool')}}\nexport function activate(){globalThis.__qqRuntimeRegression.activate++}\nexport function deactivate(){globalThis.__qqRuntimeRegression.deactivate++}\nexport function dispose(){globalThis.__qqRuntimeRegression.dispose++}`);
      const initial = await loadPlugins({ roots, log: () => {} });
      assert.equal(initial.loaded.some((item) => item.id === skillId), true);
      const oldSkill = skillManager.registry.get(skillId);
      assert.ok(getTool(`${skillId}__old_tool`));
      assert.deepEqual(activateLoadedPlugins(initial, { log: () => {} }), [skillId]);
      assert.equal(globalThis.__qqRuntimeRegression.activate, 1);

      await writeEntry(`${lifecyclePrelude}\nexport function setup(api){${toolSource('partial_tool')}throw new Error("setup failed after registration")}\nexport function activate(){globalThis.__qqRuntimeRegression.activate++}\nexport function deactivate(){globalThis.__qqRuntimeRegression.deactivate++}`);
      const failed = await loadPlugins({ roots, log: () => {} });
      assert.equal(failed.failed.some((item) => item.id === skillId), true);
      assert.strictEqual(skillManager.registry.get(skillId), oldSkill, '失败 reload 必须保留旧 Skill 对象');
      assert.ok(getTool(`${skillId}__old_tool`), '失败 reload 不能清空旧工具');
      assert.equal(getTool(`${skillId}__partial_tool`), null, '失败 setup 的暂存工具不能泄漏');
      assert.deepEqual(activateLoadedPlugins(failed, { log: () => {} }), [], '失败扫描不能激活保留的旧实例');
      assert.equal(globalThis.__qqRuntimeRegression.activate, 1, '失败 reload 不能重复 activate 旧实例');
      assert.equal(globalThis.__qqRuntimeRegression.deactivate, 0, '失败 reload 不应停掉旧实例');

      await writeEntry(`${lifecyclePrelude}\nexport function setup(api){${toolSource('new_tool')}}\nexport function activate(){globalThis.__qqRuntimeRegression.activate++}\nexport function deactivate(){globalThis.__qqRuntimeRegression.deactivate++}`);
      const succeeded = await loadPlugins({ roots, log: () => {} });
      assert.equal(succeeded.loaded.some((item) => item.id === skillId), true);
      assert.equal(getTool(`${skillId}__old_tool`), null, '成功替换应移除旧版独有工具');
      assert.ok(getTool(`${skillId}__new_tool`));
      assert.deepEqual(skillManager.registry.get(skillId).toolIds, [`${skillId}__new_tool`]);
      assert.deepEqual(activateLoadedPlugins(succeeded, { log: () => {} }), [skillId]);
      assert.equal(globalThis.__qqRuntimeRegression.activate, 2);
      assert.equal(globalThis.__qqRuntimeRegression.deactivate, 1, '成功替换只停用旧实例一次');

      const appSource = await fs.readFile(new URL('../app/src/app.js', import.meta.url), 'utf8');
      assert.match(appSource, /activateLoadedPlugins\(result, \{ log \}\)/,
        '应用重扫必须只激活本次扫描成功的实例');
      assert.match(appSource, /onReload: \(result\) => applyPluginScan\(result, \{ reason: 'watch' \}\)/,
        'watcher 应复用自己这一轮的扫描结果');
      assert.doesNotMatch(appSource, /onReload:\s*\(\)\s*=>\s*reloadSkills\(/,
        'watcher 回调不能再触发第二次扫描');
    } finally {
      unloadSkill(skillId, { reason: 'test-cleanup' });
      unregisterToolsBySkill(skillId);
      delete globalThis.__qqRuntimeRegression;
    }
  });

  await test('关闭 watcher 后不执行待处理的防抖扫描', async () => {
    const skillsRoot = path.join(tempRoot, 'watch-skills');
    const pluginsRoot = path.join(tempRoot, 'watch-plugins');
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.mkdir(pluginsRoot, { recursive: true });
    let reloadCount = 0;
    const watcher = watchPlugins({
      roots: { skills: skillsRoot, plugins: pluginsRoot },
      log: () => {},
      onReload: () => { reloadCount++; }
    });
    assert.ok(watcher);
    let sawChange = false;
    let resolveChange;
    const changeObserved = new Promise((resolve) => { resolveChange = resolve; });
    let observer = null;
    try {
      observer = watchFs(skillsRoot, () => {
        sawChange = true;
        resolveChange();
      });
      await fs.writeFile(path.join(skillsRoot, 'pending-change.txt'), 'change');
      await Promise.race([changeObserved, new Promise((resolve) => setTimeout(resolve, 250))]);
      observer.close();
      observer = null;
      assert.equal(sawChange, true, '文件系统必须已向监听器报告这次变化');
      await watcher.close();
      await new Promise((resolve) => setTimeout(resolve, 550));
      assert.equal(reloadCount, 0, 'close 必须取消未触发的重载计时器');
    } finally {
      observer?.close();
      await watcher.close();
    }
  });

  await test('ZIP 在 inflate 前检查路径、数量与声明体积', async () => {
    const tooMany = zipArchive(Array.from({ length: 101 }, (_, i) => ({ name: `pkg/${i}.txt`, data: '' })));
    assert.throws(() => validateZipStructure(tooMany), /文件数量过多/);
    const unsafePath = zipArchive([{ name: '../outside.js', data: 'x' }]);
    assert.throws(() => validateZipStructure(unsafePath), /非法路径/);
    const oversizedDeclaration = zipArchive([{ name: 'pkg/large.bin', data: 'x', declaredSize: 32 * 1024 * 1024 + 1 }]);
    assert.throws(() => validateZipStructure(oversizedDeclaration), /总大小超过 32MB/);
    const metadata = validateZipStructure(zipArchive([{ name: 'pkg/small.txt', data: 'x' }]));
    assert.equal('data' in metadata[0], false, '校验阶段不应解压条目');
  });

  await test('ZIP deflate 输出受单条声明大小和剩余额度限制，失败前不建安装目录', async () => {
    const bomb = Buffer.alloc(32 * 1024 * 1024 + 1, 0x41);
    const lyingSizeZip = zipArchive([{ name: 'bomb/data.txt', data: bomb, method: 8, declaredSize: 1 }]);
    assert.equal(validateZipStructure(lyingSizeZip)[0].uncompressedSize, 1);
    const installRoot = path.join(tempRoot, 'inflate-install-root');
    await assert.rejects(
      unzipToModuleDir(lyingSizeZip, { root: installRoot, type: 'skill', preferId: 'bomb' })
    );
    assert.equal(await fs.stat(path.join(installRoot, 'skills')).then(() => true, () => false), false);
  });

  await test('ZIP 拒绝恶意 preferId，并在目录冲突耗尽时保留现有内容', async () => {
    const simpleZip = zipArchive([{ name: 'index.js', data: 'new content' }]);
    const installRoot = path.join(tempRoot, 'path-install-root');
    await assert.rejects(
      unzipToModuleDir(simpleZip, { root: installRoot, type: 'skill', preferId: '../plugins/escaped' }),
      /模块目录名非法/
    );
    assert.equal(await fs.stat(path.join(tempRoot, 'plugins', 'escaped')).then(() => true, () => false), false);

    const collisionZip = zipArchive([{ name: 'collision/index.js', data: 'new content' }]);
    const skillBase = path.join(installRoot, 'skills');
    await fs.mkdir(skillBase, { recursive: true });
    for (let i = 0; i <= 100; i++) await fs.mkdir(path.join(skillBase, i ? `collision_${i}` : 'collision'));
    const sentinel = path.join(skillBase, 'collision_100', 'keep.txt');
    await fs.writeFile(sentinel, 'existing plugin data');
    await assert.rejects(unzipToModuleDir(collisionZip, { root: installRoot, type: 'skill' }), /冲突过多/);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'existing plugin data');
  });

  await test('市场下载流在超出 8MB 限额时停止，恰好到限额可读', async () => {
    assert.equal(MAX_ZIP_BYTES, 8 * 1024 * 1024);
    const exactlyLimit = await readLimitedResponseBody(streamResponse([Buffer.alloc(16, 1)]), 16);
    assert.equal(exactlyLimit.length, 16);
    await assert.rejects(readLimitedResponseBody(streamResponse([Buffer.alloc(17, 1)]), 16), /超过 8MB/);
  });

  await test('市场错误响应体超限时取消流，不调用text且不创建安装目录', async () => {
    const id = 'market_error_limit_runtime_regression';
    const targetDir = path.join(ROOT, 'skills', id);
    assert.equal(await fs.stat(targetDir).then(() => true, () => false), false,
      '测试开始前拒绝碰撞已有安装目录');

    let cancelled = false;
    let textCalled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc(MAX_ERROR_RESPONSE_BYTES + 1, 0x41));
      },
      cancel() { cancelled = true; }
    });
    const response = {
      ok: false,
      status: 502,
      body,
      headers: { get: () => null },
      text: async () => { textCalled = true; return 'unbounded'; }
    };
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => response;
      await assert.rejects(
        installByCode({ code: 'TEST', verified: { ok: true, id, type: 'skill' } }),
        /下载失败：市场服务故障（HTTP 502）/);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(cancelled, true, '错误响应流超限后必须取消');
    assert.equal(textCalled, false, '不应使用无上限的response.text()');
    assert.equal(await fs.stat(targetDir).then(() => true, () => false), false,
      '错误响应不应创建技能安装目录');
  });

  await test('删除群成员备注使用整体替换，保留其他 QQ 的备注', async () => {
    const source = await fs.readFile(new URL('../app/ui/app/05-memory-settings.js', import.meta.url), 'utf8');
    const handlers = new Map();
    const noteInput = { value: '' };
    const button = (selector) => ({ addEventListener: (event, fn) => handlers.set(`${selector}:${event}`, fn) });
    const overlay = {
      querySelector(selector) {
        if (selector === '#mn-note') return noteInput;
        if (selector === '#mn-delete' || selector === '#mn-save' || selector === '#mn-cancel') return button(selector);
        return null;
      }
    };
    const state = { config: { memberNotes: { '111': '删除我', '222': '保留我' } }, groupMembers: [] };
    let submittedPatch;
    const context = {
      state,
      $: (selector) => selector === '#mn-note' ? noteInput : null,
      esc: (value) => String(value ?? ''),
      modelModalShell: () => overlay,
      closeModelModal: () => {},
      loadGroupMembers: async () => {},
      api: async (_url, options) => {
        submittedPatch = JSON.parse(options.body);
        state.config = deepMerge(state.config, submittedPatch);
        return { config: state.config };
      },
      alert: () => {}
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: '05-memory-settings.js' });
    await context.openMemberNoteModal('111', 'group:9');
    await handlers.get('#mn-delete:click')();
    assert.deepEqual(submittedPatch.memberNotes.__replace__, { '222': '保留我' });
    assert.deepEqual(state.config.memberNotes, { '222': '保留我' });
  });
} finally {
  const systemTemp = path.resolve(os.tmpdir());
  const resolvedTemp = path.resolve(tempRoot);
  const relativeTemp = path.relative(systemTemp, resolvedTemp);
  if (!path.basename(resolvedTemp).startsWith('qq-agent-runtime-regression-')
      || !relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) {
    throw new Error(`拒绝清理超出测试临时目录范围的路径：${resolvedTemp}`);
  }
  await fs.rm(resolvedTemp, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n===== Runtime regressions: ${results.length - failed.length}/${results.length} passed =====`);
if (failed.length) process.exitCode = 1;
