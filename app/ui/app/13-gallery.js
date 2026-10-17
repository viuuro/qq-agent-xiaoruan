// 〔本地图库管理页〕—— 第 13 段（在 11-init 之前执行，只定义函数，不启动）
//
// 管理端职责（对应需求）：
//   · 存入图片：从本机选择常规格式图片（PNG/JPG/GIF/WebP/BMP）→ 原始二进制上传；
//   · 新建分类：在图库根目录下创建同名文件夹；
//   · 分类：重命名 / 删除（非空时先移到「未分类」）；
//   · 单图：查看大图、移动到分类、编辑标题/标签/描述、下载、删除。
//
// 智能体侧只有只读工具（list_gallery / view_gallery_image）；
// 聊天侧不能发送或存入图库，所有写入都只发生在管理端（本页）。
'use strict';

const DEFAULT_GALLERY_CATEGORY = '未分类';

const galleryState = {
  loaded: false,
  loading: false,
  seq: 0,
  categories: [],
  images: [],
  total: 0,
  totalAll: 0,
  stats: null,
  root: '',
  limits: { maxFileMB: 15 },
  category: '',
  query: '',
  error: ''
};

// ── 小工具 ───────────────────────────────────────────────────────────────
function galleryPageToken() {
  try { return new URL(location.href).searchParams.get('token') || ''; } catch { return ''; }
}

function galleryFileUrl(id, { thumb = false, download = false } = {}) {
  const params = new URLSearchParams();
  if (thumb) params.set('thumb', '1');
  if (download) params.set('download', '1');
  const token = galleryPageToken();
  if (token) params.set('token', token);
  const qs = params.toString();
  return `/api/gallery/file/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
}

function galleryFmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function galleryFmtDate(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', {
    hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function galleryImageLabel(img) {
  return String(img?.title || img?.originalName || img?.filename || '未命名图片');
}

function gallerySourceLabel(source) {
  return ({
    upload: '管理端上传',
    message: '聊天消息',
    url: '图片链接',
    manual: '手动放入',
    import: '导入'
  })[String(source || '')] || String(source || '未知');
}

// ── 页面渲染 ─────────────────────────────────────────────────────────────
function galleryCategoryRow(name, label, count, active) {
  const isAll = !name;
  const isDefault = name === DEFAULT_GALLERY_CATEGORY;
  return `
    <div class="gallery-cat ${active ? 'active' : ''}" data-gal-cat="${esc(name)}" role="button" tabindex="0">
      <span class="gallery-cat-icon">${isAll ? '🗂️' : '📁'}</span>
      <span class="gallery-cat-name" title="${esc(label)}">${esc(label)}</span>
      <span class="gallery-cat-count">${Number(count) || 0}</span>
      ${(isAll || isDefault) ? '' : `<span class="gallery-cat-actions">
        <button class="gallery-cat-btn" type="button" data-gal-action="rename-cat" data-cat="${esc(name)}" title="重命名分类">✎</button>
        <button class="gallery-cat-btn danger" type="button" data-gal-action="delete-cat" data-cat="${esc(name)}" title="删除分类">🗑</button>
      </span>`}
    </div>`;
}

function galleryCard(img) {
  const title = galleryImageLabel(img);
  const dims = img.width && img.height ? `${img.width}×${img.height}` : '';
  const tags = (img.tags || []).slice(0, 3)
    .map((t) => `<span class="gallery-tag">${esc(t)}</span>`).join('');
  return `
    <article class="gallery-card" data-gal-id="${esc(img.id)}" tabindex="0" role="button" title="${esc(title)}">
      <div class="gallery-thumb-wrap">
        <img class="gallery-thumb" loading="lazy" data-gal-id="${esc(img.id)}"
             src="${esc(galleryFileUrl(img.id, { thumb: true }))}" alt="${esc(title)}" />
      </div>
      <div class="gallery-card-meta">
        <div class="gallery-card-title" title="${esc(title)}">${esc(title)}</div>
        <div class="gallery-card-sub">
          <span class="gallery-card-cat">${esc(img.category)}</span>
          <span>${galleryFmtSize(img.size)}</span>
          ${dims ? `<span>${dims}</span>` : ''}
        </div>
        ${tags ? `<div class="gallery-card-tags">${tags}</div>` : ''}
      </div>
    </article>`;
}

function gallerySkeletonCards() {
  return Array.from({ length: 8 }, () => `
    <div class="gallery-card skeleton">
      <div class="gallery-thumb-wrap"></div>
      <div class="gallery-card-meta">
        <div class="gallery-skel-line"></div>
        <div class="gallery-skel-line short"></div>
      </div>
    </div>`).join('');
}

function renderGalleryPage() {
  const page = $('#gallery-page');
  if (!page) return;
  const st = galleryState;
  const current = st.category || '';
  const stats = st.stats || {};
  const totalAll = Number(st.totalAll) || 0;
  const total = Number(st.total) || 0;
  const shown = (st.images || []).length;

  let cards;
  if (!st.loaded && st.loading) {
    cards = `<div class="gallery-grid">${gallerySkeletonCards()}</div>`;
  } else if (!st.images.length) {
    const isSearch = !!st.query;
    cards = `
      <div class="gallery-empty">
        <div class="gallery-empty-icon">${isSearch ? '🔍' : '🖼️'}</div>
        <div class="gallery-empty-title">${isSearch ? '没有匹配的图片' : (totalAll ? '这个分类还是空的' : '图库还没有图片')}</div>
        <div class="gallery-empty-sub">${isSearch
          ? `试试别的关键词，或点「全部」查看所有图片。`
          : '点右上角「存入图片」上传，或在 QQ 里发图后让小软存进图库。'}</div>
      </div>`;
  } else {
    cards = `<div class="gallery-grid">${st.images.map(galleryCard).join('')}</div>`;
  }

  const noteParts = [];
  if (total > shown) noteParts.push(`当前筛选共 ${total} 张，只显示前 ${shown} 张。`);
  const note = noteParts.join(' ');

  page.innerHTML = `
    <div class="gallery-wrap ${st.loading ? 'is-loading' : ''}">
      <div class="gallery-head">
        <div class="gallery-head-main">
          <div class="gallery-title">🖼️ 本地图库</div>
          <div class="gallery-sub">图片按分类文件夹保存在 QQ Agent 所在服务器。<strong>只有管理端能上传/修改；聊天里的智能体只能只读查看，不能发送或存入。</strong></div>
        </div>
        <div class="gallery-actions">
          <button class="btn" type="button" data-gal-action="refresh" title="重新读取磁盘（手动往分类文件夹里放图后也点它）">刷新</button>
          <button class="btn" type="button" data-gal-action="new-category">＋ 新建分类</button>
          <button class="btn btn-primary" type="button" data-gal-action="upload" title="上传图片到当前分类；未选择分类时存入「未分类」">↑ 存入图片</button>
          <input type="file" id="gal-file-input" class="hidden" multiple
                 accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,.jpg,.jpeg,.jfif,.png,.gif,.webp,.bmp" />
        </div>
      </div>

      <div class="gallery-stats">
        <span class="gallery-chip">共 <b>${totalAll}</b> 张</span>
        <span class="gallery-chip"><b>${Number(stats.categories) || (st.categories || []).length}</b> 个分类</span>
        <span class="gallery-chip">占用 <b>${galleryFmtSize(stats.totalBytes)}</b></span>
        <span class="gallery-chip gallery-chip-muted">单张上限 ${Number(st.limits?.maxFileMB) || 15}MB · 支持 PNG / JPG / GIF / WebP / BMP</span>
      </div>

      ${st.error ? `<div class="gallery-error">⚠️ ${esc(st.error)} <button class="btn btn-small" type="button" data-gal-action="refresh">重试</button></div>` : ''}

      <div class="gallery-layout">
        <aside class="gallery-side">
          <div class="gallery-side-title">分类文件夹</div>
          <div class="gallery-cats">
            ${galleryCategoryRow('', '全部', totalAll, current === '')}
            ${(st.categories || []).map((c) => galleryCategoryRow(c.name, c.name, c.count, current === c.name)).join('')}
          </div>
          ${st.root ? `<div class="gallery-root">存储位置<br><code>${esc(st.root)}</code></div>` : ''}
        </aside>

        <section class="gallery-main">
          <div class="gallery-toolbar">
            <input class="inp gallery-search" id="gal-search" type="text" autocomplete="off"
                   placeholder="搜索标题 / 标签 / 文件名…" value="${esc(st.query)}" />
            <span class="gallery-result">${current ? `「${esc(current)}」` : '全部'} · ${total} 张</span>
          </div>
          <div class="gallery-note hidden" id="gal-upload-note"></div>
          ${note ? `<div class="gallery-note">${esc(note)}</div>` : ''}
          ${cards}
        </section>
      </div>
    </div>`;
}

// ── 数据加载 ─────────────────────────────────────────────────────────────
async function loadGalleryView({ force = false, quiet = false } = {}) {
  const page = $('#gallery-page');
  if (!page) return;
  const seq = ++galleryState.seq;
  if (!quiet) {
    galleryState.loading = true;
    renderGalleryPage();
  }
  const params = new URLSearchParams();
  if (galleryState.category) params.set('category', galleryState.category);
  if (galleryState.query) params.set('q', galleryState.query);
  if (force) params.set('refresh', '1');
  params.set('limit', '500');

  const active = document.activeElement;
  const focusSearch = active && active.id === 'gal-search'
    ? { start: active.selectionStart, end: active.selectionEnd }
    : null;

  try {
    const data = await api(`/api/gallery?${params.toString()}`);
    if (seq !== galleryState.seq) return;
    galleryState.categories = Array.isArray(data.categories) ? data.categories : [];
    if (galleryState.category
        && !galleryState.categories.some((c) => c.name === galleryState.category)) {
      galleryState.category = '';
    }
    galleryState.images = Array.isArray(data.images) ? data.images : [];
    galleryState.total = Number(data.total) || 0;
    galleryState.totalAll = Number(data.totalAll) || 0;
    galleryState.stats = data.stats || null;
    galleryState.root = String(data.root || '');
    galleryState.limits = data.limits || galleryState.limits;
    galleryState.error = '';
    galleryState.loaded = true;
  } catch (error) {
    if (seq !== galleryState.seq) return;
    galleryState.error = String(error?.message ?? error);
    if (!quiet) showAppAlert(`图库加载失败：${galleryState.error}`);
  } finally {
    if (seq !== galleryState.seq) return;
    galleryState.loading = false;
    renderGalleryPage();
    if (focusSearch) {
      const input = $('#gal-search');
      if (input) {
        input.focus();
        try { input.setSelectionRange(focusSearch.start, focusSearch.end); } catch { /* ignore */ }
      }
    }
  }
}

// ── 存入图片（原始二进制上传）────────────────────────────────────────────
function setGalleryStatus(text, busy = false) {
  const el = $('#gal-upload-note');
  if (!el) return;
  const value = String(text || '');
  el.textContent = value;
  el.classList.toggle('hidden', !value);
  el.classList.toggle('busy', !!busy);
}

async function galleryUploadOne(file, category) {
  const params = new URLSearchParams({
    category,
    filename: String(file.name || '')
  });
  const token = galleryPageToken();
  if (token) params.set('token', token);
  const res = await fetch(`/api/gallery/images?${params.toString()}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function handleGalleryUpload(files) {
  const list = (Array.isArray(files) ? files : Array.from(files || []))
    .filter((f) => f && typeof f.size === 'number');
  if (!list.length) return;
  const maxMB = Number(galleryState.limits?.maxFileMB) || 15;
  const maxBytes = maxMB * 1024 * 1024;
  const target = galleryState.category || DEFAULT_GALLERY_CATEGORY;
  const accepted = [];
  const tooBig = [];
  for (const file of list) {
    if (file.size > maxBytes) tooBig.push(file.name);
    else accepted.push(file);
  }
  if (!accepted.length) {
    showAppAlert(`选中的图片都超过单张 ${maxMB}MB 上限。`);
    return;
  }
  if (accepted.length > 30) {
    accepted.length = 30;
    tooBig.push('（一次最多上传 30 张）');
  }
  let saved = 0;
  let duplicate = 0;
  const errors = [];
  for (let i = 0; i < accepted.length; i++) {
    setGalleryStatus(`正在存入 ${i + 1}/${accepted.length}：${accepted[i].name}`, true);
    try {
      const r = await galleryUploadOne(accepted[i], target);
      if (r.duplicate) duplicate += 1;
      else saved += 1;
    } catch (error) {
      errors.push(`${accepted[i].name}：${error?.message ?? error}`);
    }
    // 让浏览器有机会重绘进度文字（上传是串行的，避免一次性把几十张图读进内存）
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  setGalleryStatus('');
  await loadGalleryView({ force: true });
  const summary = [
    `已存入 ${saved} 张`,
    duplicate ? `重复 ${duplicate} 张（未重复占用磁盘）` : '',
    tooBig.length ? `跳过 ${tooBig.length} 项` : '',
    errors.length ? `失败 ${errors.length} 张` : ''
  ].filter(Boolean).join('，');
  if (errors.length) {
    showAppAlert(`${summary}\n\n${errors.slice(0, 6).join('\n')}`);
  } else {
    setGalleryStatus(`${summary}（分类：${target}）`);
  }
}

// ── 分类操作 ─────────────────────────────────────────────────────────────
async function newGalleryCategory(select = true) {
  const name = await uiPrompt('新分类名称（会在图库目录下创建同名文件夹）');
  if (name === null) return null;
  try {
    const r = await api('/api/gallery/categories', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    const created = r.name || String(name || '').trim();
    if (select && created) galleryState.category = created;
    await loadGalleryView({ force: true });
    if (created) setGalleryStatus(r.created === false ? `分类「${created}」已存在，已切换过去` : `已新建分类「${created}」`);
    return created;
  } catch (error) {
    showAppAlert(`新建分类失败：${error?.message ?? error}`);
    return null;
  }
}

async function renameGalleryCategory(name) {
  const to = await uiPrompt(`把分类「${name}」重命名为：`, name);
  if (to === null) return;
  try {
    const r = await api('/api/gallery/categories/rename', {
      method: 'POST',
      body: JSON.stringify({ from: name, to })
    });
    if (galleryState.category === name) galleryState.category = r.to || String(to).trim();
    await loadGalleryView({ force: true });
    setGalleryStatus(`分类已重命名为「${r.to || to}」`);
  } catch (error) {
    showAppAlert(`重命名分类失败：${error?.message ?? error}`);
  }
}

async function deleteGalleryCategory(name) {
  const cat = (galleryState.categories || []).find((c) => c.name === name);
  const count = Number(cat?.count) || 0;
  let moveTo = '';
  if (count > 0) {
    const yes = await uiConfirm(
      `分类「${name}」里还有 ${count} 张图片。\n要先把它们移到「${DEFAULT_GALLERY_CATEGORY}」，再删除这个分类文件夹吗？`,
      { title: '删除分类', okText: '移动并删除' }
    );
    if (!yes) return;
    moveTo = DEFAULT_GALLERY_CATEGORY;
  } else {
    const yes = await uiConfirm(`确定删除空分类「${name}」？`, { title: '删除分类', okText: '删除' });
    if (!yes) return;
  }
  try {
    const r = await api('/api/gallery/categories', {
      method: 'DELETE',
      body: JSON.stringify({ name, moveTo })
    });
    if (galleryState.category === name) galleryState.category = '';
    await loadGalleryView({ force: true });
    setGalleryStatus(moveTo
      ? `已删除分类「${name}」，${Number(r.moved) || 0} 张图片移到「${moveTo}」`
      : `已删除空分类「${name}」`);
  } catch (error) {
    showAppAlert(`删除分类失败：${error?.message ?? error}`);
  }
}

// ── 单图操作 ─────────────────────────────────────────────────────────────
function openGalleryLightbox(id) {
  const img = (galleryState.images || []).find((x) => x.id === id);
  if (!img) return;
  const title = galleryImageLabel(img);
  const src = galleryFileUrl(img.id);
  const body = `
    <div class="gallery-lb">
      <div class="gallery-lb-imgwrap">
        <img class="gallery-lb-img" src="${esc(src)}" alt="${esc(title)}" />
      </div>
      <div class="gallery-lb-info">
        <div class="gallery-lb-title">${esc(title)}</div>
        <div class="gallery-lb-grid">
          <div><b>分类</b><span>${esc(img.category)}</span></div>
          <div><b>尺寸</b><span>${img.width && img.height ? `${img.width}×${img.height}` : '未知'}</span></div>
          <div><b>大小</b><span>${galleryFmtSize(img.size)}</span></div>
          <div><b>格式</b><span>${esc(String(img.mime || img.ext || '').replace('image/', '').toUpperCase() || '未知')}</span></div>
          <div><b>存入时间</b><span>${esc(galleryFmtDate(img.createdAt))}</span></div>
          <div><b>来源</b><span>${esc(gallerySourceLabel(img.source))}</span></div>
        </div>
        ${(img.tags || []).length ? `<div class="gallery-lb-tags">${img.tags.map((t) => `<span class="gallery-tag">${esc(t)}</span>`).join('')}</div>` : ''}
        ${img.description ? `<div class="gallery-lb-desc">${esc(img.description)}</div>` : ''}
        <div class="gallery-lb-file" title="${esc(img.filename || '')}">${esc(img.filename || '')}</div>
      </div>
    </div>`;
  const foot = `
    <a class="btn" href="${esc(galleryFileUrl(img.id, { download: true }))}" download>下载</a>
    <button class="btn" type="button" id="gal-lb-move">移动到分类</button>
    <button class="btn" type="button" id="gal-lb-edit">编辑信息</button>
    <button class="btn btn-danger" type="button" id="gal-lb-delete">删除</button>
    <button class="btn btn-ghost" type="button" id="gal-lb-close">关闭</button>`;
  const overlay = modelModalShell({ head: `🖼️ ${esc(title)}`, body, foot });
  overlay.querySelector('#gal-lb-close')?.addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#gal-lb-move')?.addEventListener('click', () => openGalleryMoveDialog(img, overlay));
  overlay.querySelector('#gal-lb-edit')?.addEventListener('click', () => openGalleryEditDialog(img, overlay));
  overlay.querySelector('#gal-lb-delete')?.addEventListener('click', () => deleteGalleryImage(img, overlay));
}

function openGalleryMoveDialog(img, parentOverlay) {
  const cats = (galleryState.categories || []).filter((c) => c.name !== img.category);
  if (!cats.length) {
    showAppAlert('还没有别的分类可以移动。请先点「新建分类」。');
    return;
  }
  const body = `
    <div class="field">
      <label>目标分类</label>
      <select id="gal-move-target">
        ${cats.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}（${Number(c.count) || 0} 张）</option>`).join('')}
      </select>
    </div>
    <div class="hint">移动会同步把图片文件搬进目标分类文件夹（不只是改数据库）。</div>`;
  const foot = `<button class="btn" type="button" id="gal-move-cancel">取消</button>
    <button class="btn btn-primary" type="button" id="gal-move-ok">移动</button>`;
  const dlg = modelModalShell({ head: `移动「${esc(galleryImageLabel(img))}」`, body, foot });
  dlg.querySelector('#gal-move-cancel')?.addEventListener('click', () => closeModelModal(dlg));
  dlg.querySelector('#gal-move-ok')?.addEventListener('click', async () => {
    const target = dlg.querySelector('#gal-move-target')?.value || '';
    if (!target) return;
    try {
      await api(`/api/gallery/images/${encodeURIComponent(img.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ category: target })
      });
      closeModelModal(dlg);
      closeModelModal(parentOverlay);
      await loadGalleryView({ force: true });
      setGalleryStatus(`已移动到分类「${target}」`);
    } catch (error) {
      showAppAlert(`移动失败：${error?.message ?? error}`);
    }
  });
}

function openGalleryEditDialog(img, parentOverlay) {
  const body = `
    <div class="field">
      <label>标题</label>
      <input type="text" id="gal-edit-title" maxlength="80" value="${esc(img.title || '')}" />
    </div>
    <div class="field">
      <label>标签（用逗号分隔，最多 10 个）</label>
      <input type="text" id="gal-edit-tags" value="${esc((img.tags || []).join('，'))}" />
    </div>
    <div class="field">
      <label>描述 / 备注</label>
      <textarea id="gal-edit-desc" rows="4" maxlength="500">${esc(img.description || '')}</textarea>
    </div>`;
  const foot = `<button class="btn" type="button" id="gal-edit-cancel">取消</button>
    <button class="btn btn-primary" type="button" id="gal-edit-ok">保存</button>`;
  const dlg = modelModalShell({ head: `编辑「${esc(galleryImageLabel(img))}」`, body, foot });
  dlg.querySelector('#gal-edit-cancel')?.addEventListener('click', () => closeModelModal(dlg));
  dlg.querySelector('#gal-edit-ok')?.addEventListener('click', async () => {
    const patch = {
      title: dlg.querySelector('#gal-edit-title')?.value || '',
      tags: dlg.querySelector('#gal-edit-tags')?.value || '',
      description: dlg.querySelector('#gal-edit-desc')?.value || ''
    };
    try {
      await api(`/api/gallery/images/${encodeURIComponent(img.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      closeModelModal(dlg);
      closeModelModal(parentOverlay);
      await loadGalleryView({ force: true });
      setGalleryStatus('图片信息已保存');
    } catch (error) {
      showAppAlert(`保存失败：${error?.message ?? error}`);
    }
  });
}

async function deleteGalleryImage(img, parentOverlay) {
  const yes = await uiConfirm(
    `确定删除图库里的「${galleryImageLabel(img)}」吗？\n图片文件会从服务器上删除，不可恢复。`,
    { title: '删除图片', okText: '删除' }
  );
  if (!yes) return;
  try {
    await api(`/api/gallery/images/${encodeURIComponent(img.id)}`, { method: 'DELETE' });
    closeModelModal(parentOverlay);
    await loadGalleryView({ force: true });
    setGalleryStatus('已删除 1 张图片');
  } catch (error) {
    showAppAlert(`删除失败：${error?.message ?? error}`);
  }
}

// ── 事件（委托在 #gallery-page 上，页面重绘不会丢监听）──────────────────
function onGalleryClick(e) {
  const action = e.target.closest('[data-gal-action]');
  if (action) {
    const name = action.dataset.galAction;
    if (name === 'upload') { e.preventDefault(); $('#gal-file-input')?.click(); return; }
    if (name === 'refresh') { e.preventDefault(); loadGalleryView({ force: true }); return; }
    if (name === 'new-category') { e.preventDefault(); newGalleryCategory(); return; }
    if (name === 'rename-cat') {
      e.preventDefault();
      e.stopPropagation();
      renameGalleryCategory(action.dataset.cat || '');
      return;
    }
    if (name === 'delete-cat') {
      e.preventDefault();
      e.stopPropagation();
      deleteGalleryCategory(action.dataset.cat || '');
      return;
    }
  }
  const cat = e.target.closest('[data-gal-cat]');
  if (cat) {
    const name = cat.dataset.galCat || '';
    if (name !== galleryState.category) {
      galleryState.category = name;
      loadGalleryView({ quiet: true });
    }
    return;
  }
  const card = e.target.closest('.gallery-card[data-gal-id]');
  if (card) openGalleryLightbox(card.dataset.galId || '');
}

let gallerySearchTimer = null;
function onGalleryInput(e) {
  if (e.target.id !== 'gal-search') return;
  galleryState.query = e.target.value;
  clearTimeout(gallerySearchTimer);
  gallerySearchTimer = setTimeout(() => loadGalleryView({ quiet: true }), 250);
}

function onGalleryChange(e) {
  if (e.target.id !== 'gal-file-input') return;
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) handleGalleryUpload(files);
}

function onGalleryKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const target = e.target.closest('[data-gal-cat], .gallery-card[data-gal-id]');
  if (!target || e.target.closest('button')) return;
  e.preventDefault();
  target.click();
}

function onGalleryImageError(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('gallery-thumb')) return;
  if (img.dataset.galFallback === '1') {
    img.classList.add('gallery-thumb-failed');
    img.removeAttribute('src');
    return;
  }
  img.dataset.galFallback = '1';
  const id = img.dataset.galId || '';
  if (id) img.src = galleryFileUrl(id);
}

(function initGalleryEvents() {
  const page = $('#gallery-page');
  if (!page) return;
  page.addEventListener('click', onGalleryClick);
  page.addEventListener('input', onGalleryInput);
  page.addEventListener('change', onGalleryChange);
  page.addEventListener('keydown', onGalleryKeydown);
  // capture：img 的 error 事件不冒泡，必须在捕获阶段接
  page.addEventListener('error', onGalleryImageError, true);
})();
