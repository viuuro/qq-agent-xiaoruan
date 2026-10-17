// 本地图库：按「分类 = 一级文件夹」存图片，元数据放 index.json。
//
// 为什么做成核心模块而不是 Skill / 插件：
//   · 图库需要 HTTP 管理接口（上传/删除/新建分类/移动图片）—— Skill 系统只允许
//     注册模型工具，没有路由能力；
//   · 它同时要给模型提供工具（list / send / save / view），所以不能只做成插件。
//
// 存储布局（DATA_DIR 会随 QQ_AGENT_DATA_DIR / PROFILE 变化，所以**每次现算**）：
//   data/image-gallery/
//     未分类/                 ← 默认分类，永远存在
//     风景/                   ← 管理端新建的分类（文件夹名 = 分类名）
//       g_xxx.png
//     index.json              ← 标题/标签/尺寸/来源等元数据（文件本身仍是唯一实体）
//     .cache/thumbs/           ← 可选缩略图（有 ffmpeg 才生成，没有则直接发原图）
//
// 设计要点：
//   1. **文件夹是分类的唯一真相**。删掉 index.json 也能从磁盘重建；
//      手动把图片丢进某个分类文件夹，刷新后会自动出现在图库里。
//   2. 文件 id 编码在文件名里（g_xxx.ext），所以手动把文件在分类之间移动，
//      元数据仍能跟着走；同名文件/手动命名的文件会得到 m_ 前缀的稳定 id。
//   3. 只接受 PNG/JPEG/GIF/WebP/BMP，按**文件魔数**校验 —— 不接收 SVG/HTML，
//      避免把可执行脚本当图片存进来、再被浏览器内联打开。
//   4. 所有删除都只针对**明确的一个文件**（或一个已经清空的目录），
//      绝不递归删除目录（与仓库的运维约定一致）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR, getConfig } from './config.js';
import { detectImageType } from './image-type.js';

export const DEFAULT_CATEGORY = '未分类';
const INDEX_FILE = 'index.json';
const CACHE_DIR = '.cache';
const THUMB_DIR = 'thumbs';
const MAX_CATEGORY_LEN = 40;
const MAX_TITLE_LEN = 80;
const MAX_DESC_LEN = 500;
const MAX_TAGS = 10;
const MAX_TAG_LEN = 20;
const SUPPORTED_EXT = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.bmp']);
const EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};
// 本模块自己生成的文件名：<id><ext>。id 只含小写字母数字与下划线。
const OWN_ID_RE = /^g_[a-z0-9]+_[0-9a-f]+$/i;
const SAFE_ID_RE = /^[a-z0-9_-]{1,80}$/i;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 图库根目录：DATA_DIR 在模块加载时已按 profile 解析好，这里再拼一次即可。 */
export function galleryRoot() {
  return path.join(DATA_DIR, 'image-gallery');
}

/** 管理端与工具共用的限制值（都从配置现读，改配置立即生效）。 */
export function galleryLimits() {
  const g = getConfig().gallery || {};
  return {
    maxFileMB: Math.min(100, Math.max(1, Number(g.maxFileMB) || 15)),
    maxList: Math.min(200, Math.max(1, Number(g.maxList) || 30)),
    maxCategories: Math.min(500, Math.max(1, Number(g.maxCategories) || 100))
  };
}

/** 带 HTTP 状态码的图库错误：路由层据此返回 4xx，而不是一律 500。 */
export class GalleryError extends Error {
  constructor(message, { status = 400, code = 'gallery-error', details = null } = {}) {
    super(message);
    this.name = 'GalleryError';
    this.status = status;
    this.code = code;
    this.details = details || {};
  }
}

function fail(message, options) {
  throw new GalleryError(message, options);
}

/**
 * 分类名校验。规则对齐 Windows（最严格的一侧）：其它平台能建、Windows 建不了的
 * 名字一律拒绝，避免"本机好的、迁到服务器就炸"。
 * @returns {{ok: true, name: string}|{ok: false, error: string}}
 */
export function normalizeCategoryName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: '分类名不能为空' };
  if (name.length > MAX_CATEGORY_LEN) return { ok: false, error: `分类名最长 ${MAX_CATEGORY_LEN} 个字符` };
  if (name === '.' || name === '..' || name.startsWith('.')) {
    return { ok: false, error: '分类名不能是 "." / ".."，也不能以点开头' };
  }
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    return { ok: false, error: '分类名不能包含 <>:"/\\|?* 或控制字符' };
  }
  if (/[. ]$/.test(name)) return { ok: false, error: '分类名不能以空格或点结尾' };
  if (RESERVED_NAMES.test(name)) return { ok: false, error: `"${name}" 是系统保留名，换一个吧` };
  if (name.toLowerCase() === INDEX_FILE) return { ok: false, error: `"${name}" 与图库索引文件同名，换一个吧` };
  return { ok: true, name };
}

/** 磁盘上已存在的目录名是否可安全地当作分类（只拒绝路径分隔符/隐藏目录）。 */
function isSafeDirName(name) {
  const s = String(name || '');
  if (!s || s === '.' || s === '..' || s.startsWith('.')) return false;
  if (/[\/\\\u0000-\u001f]/.test(s)) return false;
  return true;
}

function sortCategories(names) {
  return [...new Set(names)].sort((a, b) => {
    if (a === DEFAULT_CATEGORY) return -1;
    if (b === DEFAULT_CATEGORY) return 1;
    return String(a).localeCompare(String(b), 'zh-CN');
  });
}

function nowIso() {
  return new Date().toISOString();
}

function cleanTitle(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LEN);
}

function cleanDescription(v) {
  return String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_DESC_LEN);
}

/** 标签既接受数组也接受逗号分隔字符串；去重、限长、限量。 */
export function normalizeTags(input) {
  const arr = Array.isArray(input) ? input : String(input ?? '').split(/[,，;；]/);
  const out = [];
  for (const item of arr) {
    const tag = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(absPath) {
  return sha256Buffer(fs.readFileSync(absPath));
}

function randomId() {
  return `g_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/** 只读文件头（尺寸解析/魔数校验用，不把整张图读进内存）。 */
function readHead(absPath, maxBytes = 256 * 1024) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** 从图片头解析宽高（纯手工，不引入 sharp/jimp 这类原生依赖）。 */
export function imageDimensions(buf) {
  if (!buf || buf.length < 24) return { width: 0, height: 0 };
  const ascii = (from, to) => buf.toString('ascii', from, to);
  try {
    // PNG：8 字节签名 + 4 长度 + "IHDR" + 宽高（大端）
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && ascii(12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF：逻辑屏幕宽高（小端）
    const gif = ascii(0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // BMP：BITMAPINFOHEADER 的宽高（有符号，高度可能为负）
    if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length >= 26) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    // WebP：VP8X / VP8 / VP8L 三种子格式
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
      const fourcc = ascii(12, 16);
      if (fourcc === 'VP8X' && buf.length >= 30) {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
      if (fourcc === 'VP8 ' && buf.length >= 30
        && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
        const val = buf.readUInt32LE(21);
        return { width: 1 + (val & 0x3fff), height: 1 + ((val >> 14) & 0x3fff) };
      }
    }
    // JPEG：扫 SOF 段
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpegDimensions(buf);
  } catch { /* 尺寸解析失败不影响存取，返回 0 即可 */ }
  return { width: 0, height: 0 };
}

function jpegDimensions(buf) {
  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) { pos += 1; continue; }
    const marker = buf[pos + 1];
    if (marker === 0xff) { pos += 1; continue; }
    // 无长度的独立标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { pos += 2; continue; }
    if (marker === 0xda) break;                    // SOS 之后是压缩数据
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return { width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5) };
    }
    pos += 2 + len;
  }
  return { width: 0, height: 0 };
}

function mimeFromExt(ext) {
  return EXT_MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

/**
 * 只信任白名单里的图片 MIME。
 * index.json 是磁盘文件（管理员/其它工具都可能改），如果直接把它里面的 mime
 * 当成响应头，改成 image/svg+xml 就能在本机控制台同源里执行脚本。
 * 未知值一律按扩展名回落。
 */
function safeImageMime(value, ext) {
  const mime = String(value || '').toLowerCase();
  return Object.values(EXT_MIME).includes(mime) ? mime : mimeFromExt(ext);
}

// ── ffmpeg 缩略图（可选）─────────────────────────────────────────────────
// 管理端网格如果直接加载原图，一屏十几张 5MB 的图会明显卡顿。有 ffmpeg 时
// 生成 480px 的 JPEG 缓存；没有（例如 deploy/Dockerfile 的精简镜像）就
// 老老实实回退原图 —— 功能不受影响，只是慢一点。

function runCapture(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

export class GalleryStore {
  constructor({ root = null } = {}) {
    this.root = path.resolve(root || galleryRoot());
    this._index = null;
    this._scanAt = 0;
    this._categories = [];
    this._images = [];
    this._ffmpegChecked = false;
    this._ffmpeg = null;
    this._thumbActive = 0;
    this._thumbWaiters = [];
    this._thumbJobs = new Map();
    this._thumbFailed = new Set();
  }

  get rootDir() {
    return this.root;
  }

  #indexPath() {
    return path.join(this.root, INDEX_FILE);
  }

  #thumbPath(id) {
    return path.join(this.root, CACHE_DIR, THUMB_DIR, `${id}.jpg`);
  }

  #ensureRoot() {
    fs.mkdirSync(this.root, { recursive: true });
    const def = path.join(this.root, DEFAULT_CATEGORY);
    if (!fs.existsSync(def)) fs.mkdirSync(def, { recursive: true });
  }

  /** 读索引（带缓存）。文件坏了就改名备份并从磁盘重建，绝不静默清空图片。 */
  #loadIndex() {
    if (this._index) return this._index;
    this.#ensureRoot();
    const file = this.#indexPath();
    const empty = { version: 1, updatedAt: nowIso(), images: {} };
    if (!fs.existsSync(file)) {
      this._index = empty;
      return this._index;
    }
    try {
      const text = fs.readFileSync(file, 'utf8');
      const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      const images = {};
      for (const [id, entry] of Object.entries(raw?.images || {})) {
        const clean = normalizeIndexEntry(id, entry);
        if (clean) images[clean.id] = clean;
      }
      this._index = { version: 1, updatedAt: String(raw?.updatedAt || nowIso()), images };
    } catch (error) {
      // 坏索引只影响标题/标签，图片本身还在文件夹里；备份后重建即可。
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${file}.corrupt-${stamp}`;
        fs.renameSync(file, backup);
        console.warn(`[gallery] 索引解析失败（${error?.message ?? error}），已备份为 ${backup}，将从磁盘重建`);
      } catch { /* 备份失败也不阻断，重建优先 */ }
      this._index = empty;
    }
    return this._index;
  }

  #saveIndex() {
    if (!this._index) return;
    this.#ensureRoot();
    this._index.version = 1;
    this._index.updatedAt = nowIso();
    const file = this.#indexPath();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._index, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /** 磁盘上的分类目录（隐藏目录与缓存目录不算）。 */
  #categoriesFromDisk() {
    this.#ensureRoot();
    let names = [];
    try {
      names = fs.readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && isSafeDirName(d.name))
        .map((d) => d.name);
    } catch (error) {
      throw new GalleryError(`读取图库目录失败：${error?.message ?? error}`, { status: 500, code: 'read-failed' });
    }
    if (!names.includes(DEFAULT_CATEGORY)) {
      try { fs.mkdirSync(path.join(this.root, DEFAULT_CATEGORY), { recursive: true }); } catch { /* ignore */ }
      names.push(DEFAULT_CATEGORY);
    }
    return sortCategories(names);
  }

  #resolveExistingCategory(raw) {
    const v = normalizeCategoryName(raw);
    if (!v.ok) fail(v.error, { status: 400, code: 'bad-category' });
    const cats = this.#categoriesFromDisk();
    const hit = cats.find((c) => c.toLowerCase() === v.name.toLowerCase());
    if (!hit) {
      fail(`分类不存在：${v.name}`, { status: 404, code: 'category-not-found', details: { categories: cats } });
    }
    return hit;
  }

  #resolveCategoryForWrite(raw, create = false) {
    const v = normalizeCategoryName(raw || DEFAULT_CATEGORY);
    if (!v.ok) fail(v.error, { status: 400, code: 'bad-category' });
    const cats = this.#categoriesFromDisk();
    const hit = cats.find((c) => c.toLowerCase() === v.name.toLowerCase());
    if (hit) return hit;
    if (!create) {
      fail(`分类「${v.name}」不存在`, {
        status: 404,
        code: 'category-not-found',
        details: { categories: cats }
      });
    }
    const created = this.createCategory(v.name);
    return created.name;
  }

  #entryPath(entry) {
    const category = String(entry?.category || '');
    const file = String(entry?.file || '');
    if (!isSafeDirName(category) || !file || /[\/\\]/.test(file) || file === '.' || file === '..') return null;
    if (!SUPPORTED_EXT.has(path.extname(file).toLowerCase())) return null;
    const abs = path.resolve(this.root, category, file);
    const rel = path.relative(this.root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (rel.split(path.sep).length !== 2) return null;
    return abs;
  }

  #public(entry) {
    if (!entry) return null;
    return {
      id: entry.id,
      title: entry.title || '',
      description: entry.description || '',
      tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
      category: entry.category,
      filename: entry.file,
      originalName: entry.originalName || '',
      mime: safeImageMime(entry.mime, path.extname(entry.file)),
      ext: String(path.extname(entry.file || '')).toLowerCase().replace(/^\./, ''),
      size: Number(entry.size) || 0,
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
      createdAt: entry.createdAt || '',
      updatedAt: entry.updatedAt || '',
      source: entry.source || 'manual',
      useCount: Number(entry.useCount) || 0,
      lastUsedAt: Number(entry.lastUsedAt) || 0,
      lastUsedBy: entry.lastUsedBy || '',
      senderId: entry.senderId || '',
      senderName: entry.senderName || '',
      messageId: entry.messageId || ''
    };
  }

  /** 新建一张图片条目所需的最小信息。 */
  #entryFromDisk({ id, file, category, absPath }) {
    let stat;
    try { stat = fs.statSync(absPath); } catch { return null; }
    if (!stat.isFile()) return null;
    let head;
    try { head = readHead(absPath); } catch { return null; }
    const info = detectImageType(head);
    if (!info) return null;                     // 扩展名像图、内容不是图 → 不索引
    const { width, height } = imageDimensions(head);
    const now = nowIso();
    return {
      id,
      file,
      category,
      mime: info.mime,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: OWN_ID_RE.test(id) ? sha256File(absPath) : '',
      width,
      height,
      title: '',
      description: '',
      tags: [],
      source: 'manual',
      originalName: file,
      sourceUrl: '',
      senderId: '',
      senderName: '',
      messageId: '',
      useCount: 0,
      lastUsedAt: 0,
      lastUsedBy: '',
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * 与磁盘对账：分类以目录为准、条目以文件为准。
   * 会补齐新文件、跟随手动移动、剔除已删除文件的元数据。
   */
  #scan() {
    this.#ensureRoot();
    const index = this.#loadIndex();
    const categories = this.#categoriesFromDisk();
    const images = [];
    const seen = new Set();
    const usedIds = new Set();
    let complete = true;
    let dirty = false;

    for (const category of categories) {
      const dir = path.join(this.root, category);
      let dirents;
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        complete = false;                       // 单个分类读失败时先不裁剪索引
        continue;
      }
      for (const dirent of dirents) {
        if (!dirent.isFile()) continue;
        const ext = path.extname(dirent.name).toLowerCase();
        if (!SUPPORTED_EXT.has(ext)) continue;
        const absPath = path.join(dir, dirent.name);
        const base = path.parse(dirent.name).name;
        let id = OWN_ID_RE.test(base) ? base : '';
        // 同一 id 出现两份（手动复制了文件）：后出现的那份用路径哈希做稳定 id
        if (!id || usedIds.has(id)) {
          const relKey = `${category}/${dirent.name}`;
          id = `m_${sha256Buffer(Buffer.from(relKey, 'utf8')).slice(0, 16)}`;
          let n = 1;
          while (usedIds.has(id)) id = `m_${sha256Buffer(Buffer.from(`${relKey}#${n++}`, 'utf8')).slice(0, 16)}`;
        }
        usedIds.add(id);
        seen.add(id);

        const existing = index.images[id];
        if (!existing) {
          const entry = this.#entryFromDisk({ id, file: dirent.name, category, absPath });
          if (!entry) continue;
          index.images[id] = entry;
          images.push(entry);
          dirty = true;
          continue;
        }

        let stat;
        try { stat = fs.statSync(absPath); } catch { continue; }
        const changed = Number(existing.size) !== stat.size
          || Number(existing.mtimeMs) !== stat.mtimeMs
          || !existing.mime;
        if (changed) {
          let head;
          try { head = readHead(absPath); } catch { continue; }
          const info = detectImageType(head);
          if (!info) continue;                  // 内容坏了：不索引，但也不删文件
          const { width, height } = imageDimensions(head);
          existing.size = stat.size;
          existing.mtimeMs = stat.mtimeMs;
          existing.mime = info.mime;
          existing.width = width;
          existing.height = height;
          existing.sha256 = (existing.sha256 || OWN_ID_RE.test(id)) ? sha256File(absPath) : '';
          existing.updatedAt = nowIso();
          dirty = true;
        }
        if (existing.category !== category) { existing.category = category; existing.updatedAt = nowIso(); dirty = true; }
        if (existing.file !== dirent.name) { existing.file = dirent.name; existing.updatedAt = nowIso(); dirty = true; }
        if (!existing.createdAt) { existing.createdAt = nowIso(); dirty = true; }
        images.push(existing);
      }
    }

    if (complete) {
      for (const id of Object.keys(index.images)) {
        if (!seen.has(id)) { delete index.images[id]; dirty = true; }
      }
    }
    if (dirty) {
      this._index = index;
      this.#saveIndex();
    }
    // 按分类 + 文件名稳定排序；实际展示时 list() 还会按创建时间排一次。
    images.sort((a, b) => String(a.category).localeCompare(String(b.category), 'zh-CN')
      || String(a.file).localeCompare(String(b.file), 'zh-CN'));
    this._categories = categories;
    this._images = images;
    this._scanAt = Date.now();
    return { categories, images };
  }

  #scanIfStale(refresh = false) {
    if (refresh || !this._scanAt || Date.now() - this._scanAt > 1500) this.#scan();
  }

  #stats() {
    let totalBytes = 0;
    let latestAt = '';
    for (const e of this._images) {
      totalBytes += Number(e.size) || 0;
      const t = String(e.createdAt || '');
      if (t > latestAt) latestAt = t;
    }
    return {
      total: this._images.length,
      totalBytes,
      categories: this._categories.length,
      latestAt
    };
  }

  /** 是否已存在完全相同（sha256 相同）的图片。旧条目缺哈希时就地补算。 */
  #findDuplicate(hash, size) {
    const index = this.#loadIndex();
    for (const entry of Object.values(index.images)) {
      if (Number(entry.size) !== Number(size)) continue;
      let h = String(entry.sha256 || '');
      if (!h) {
        const abs = this.#entryPath(entry);
        if (!abs) continue;
        try { h = sha256File(abs); entry.sha256 = h; } catch { continue; }
      }
      if (h === hash) return entry;
    }
    return null;
  }

  /**
   * 列表/搜索。分类计数统计的是全库（不受搜索词影响），
   * total 是过滤后的张数，totalAll 是全库张数。
   */
  list({ category = '', query = '', limit = 200, offset = 0, includeRoot = false, refresh = false } = {}) {
    this.#scanIfStale(refresh);
    const allImages = this._images;
    const cats = this._categories.map((name) => ({
      name,
      count: allImages.filter((e) => e.category === name).length
    }));
    let cat = String(category ?? '').trim();
    if (cat) {
      const hit = cats.find((c) => c.name.toLowerCase() === cat.toLowerCase());
      cat = hit ? hit.name : cat;
    }
    let images = cat ? allImages.filter((e) => e.category === cat) : [...allImages];
    const q = String(query ?? '').trim().toLowerCase();
    if (q) {
      images = images.filter((e) => {
        const hay = [
          e.title, e.description, e.file, e.originalName, e.category,
          (e.tags || []).join(' '), e.senderName
        ].map((x) => String(x || '').toLowerCase()).join('\n');
        return hay.includes(q);
      });
    }
    images.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      || String(b.id).localeCompare(String(a.id)));
    const lim = Math.min(1000, Math.max(1, Number(limit) || 200));
    const off = Math.max(0, Number(offset) || 0);
    return {
      categories: cats,
      images: images.slice(off, off + lim).map((e) => this.#public(e)),
      total: images.length,
      totalAll: allImages.length,
      offset: off,
      limit: lim,
      stats: this.#stats(),
      ...(includeRoot ? { root: this.root } : {})
    };
  }

  /** 单张（公开字段）；不存在返回 null。 */
  get(id) {
    this.#scanIfStale();
    const entry = this.#loadIndex().images[String(id || '')];
    return entry ? this.#public(entry) : null;
  }

  /** 取图片实体（管理端发文件用）。thumb=true 时尝试返回缓存缩略图。 */
  async resolveFile(id, { thumb = false } = {}) {
    this.#scanIfStale();
    const key = String(id || '');
    let entry = this.#loadIndex().images[key];
    if (!entry) fail('图片不存在', { status: 404, code: 'image-not-found' });
    let abs = this.#entryPath(entry);
    if (!abs || !fs.existsSync(abs)) {
      // 可能刚被外部删掉/挪走：强制对账一次再试
      this.#scan();
      entry = this.#loadIndex().images[key];
      abs = entry ? this.#entryPath(entry) : null;
      if (!entry || !abs || !fs.existsSync(abs)) {
        fail('图片文件已丢失', { status: 404, code: 'image-file-missing' });
      }
    }
    if (thumb) {
      const thumbPath = await this.#ensureThumb(entry, abs);
      if (thumbPath) {
        return { entry: this.#public(entry), path: thumbPath, mime: 'image/jpeg', thumbnail: true };
      }
    }
    return { entry: this.#public(entry), path: abs, mime: safeImageMime(entry.mime, path.extname(abs)), thumbnail: false };
  }

  /**
   * 存入一张图片（**只有管理端会走到这里**；聊天侧的智能体工具不提供写入口）。
   * @returns {{entry: object, duplicate: boolean}}
   */
  saveBuffer(buffer, {
    category = '',
    title = '',
    description = '',
    tags = [],
    source = 'upload',
    sourceUrl = '',
    originalName = '',
    senderId = '',
    senderName = '',
    messageId = '',
    createCategory = false,
    allowDuplicate = false,
    // 入库发起方：'admin' = 管理端上传；其余一律视为智能体（群成员触发）。
    // 默认取 'model' 是刻意的 fail-closed —— 将来新增的调用方忘了传也拦得住。
    actor = 'model'
  } = {}) {
    this.#ensureRoot();
    // ── 唯一写入口：管理端上传 ──
    // 聊天里的图片只用于"当下看懂"，不落图库（隐私边界，见 prompt.js 的
    // 【图片与表情包入库禁令】）。管理端上传会显式传 actor:'admin'。
    // 默认取 'model' 是刻意的 fail-closed —— 将来新增调用方忘了传也拦得住。
    if (actor !== 'admin') {
      fail('图库只能由管理员在控制台「图库」页上传；聊天里的图片不会被写入图库。', {
        status: 403, code: 'chat-write-forbidden'
      });
    }
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      fail('图片内容为空', { status: 400, code: 'empty-image' });
    }
    const { maxFileMB } = galleryLimits();
    const maxBytes = maxFileMB * 1024 * 1024;
    if (buffer.length > maxBytes) {
      fail(`图片太大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），上限 ${maxFileMB}MB`, {
        status: 413, code: 'image-too-large'
      });
    }
    const info = detectImageType(buffer);
    if (!info) {
      fail('不是受支持的图片格式（只收 PNG / JPG / GIF / WebP / BMP）', {
        status: 415, code: 'unsupported-image'
      });
    }
    const cat = this.#resolveCategoryForWrite(category, createCategory === true);
    const index = this.#loadIndex();
    const hash = sha256Buffer(buffer);

    const existing = this.#findDuplicate(hash, buffer.length);
    if (existing && !allowDuplicate) {
      // 完全相同的内容不重复占磁盘；返回已有条目，让调用方提示"已存在"。
      // #findDuplicate 可能顺手给旧条目补了 sha256，这里一并落盘。
      this.#saveIndex();
      this._scanAt = 0;
      return { entry: this.#public(existing), duplicate: true };
    }

    let id = randomId();
    while (index.images[id] || fs.existsSync(path.join(this.root, cat, `${id}${info.ext}`))) id = randomId();
    const file = `${id}${info.ext}`;
    const dest = path.join(this.root, cat, file);
    const { width, height } = imageDimensions(buffer);
    const now = nowIso();
    const entry = {
      id,
      file,
      category: cat,
      mime: info.mime,
      size: buffer.length,
      mtimeMs: Date.now(),
      sha256: hash,
      width,
      height,
      title: cleanTitle(title) || cleanTitle(originalName ? path.parse(String(originalName)).name : ''),
      description: cleanDescription(description),
      tags: normalizeTags(tags),
      source: ['upload', 'message', 'url', 'manual', 'import'].includes(String(source)) ? String(source) : 'upload',
      originalName: String(originalName || '').replace(/[\/\\]/g, '').slice(0, 200),
      sourceUrl: String(sourceUrl || '').slice(0, 1000),
      senderId: String(senderId || '').slice(0, 30),
      senderName: String(senderName || '').slice(0, 80),
      messageId: String(messageId || '').slice(0, 40),
      useCount: 0,
      lastUsedAt: 0,
      lastUsedBy: '',
      createdAt: now,
      updatedAt: now
    };
    // 先写临时文件再改名：避免进程中断留下半个图片文件被扫描进来
    const tmp = path.join(this.root, cat, `.${file}.tmp`);
    try {
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, dest);
      // 记账时用**磁盘上的真实 mtime**：用 Date.now() 会和文件系统时间差几毫秒，
      // 导致下一次扫描误判"文件变了"、白白重算一次 sha256。
      entry.mtimeMs = fs.statSync(dest).mtimeMs;
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      fail(`写入图库失败：${error?.message ?? error}`, { status: 500, code: 'write-failed' });
    }
    index.images[id] = entry;
    this.#saveIndex();
    this._scanAt = 0;
    return { entry: this.#public(entry), duplicate: false };
  }

  /** 改标题/描述/标签，或把图片移动到另一个分类（会真的移动文件）。 */
  update(id, patch = {}) {
    this.#scanIfStale();
    const key = String(id || '');
    const index = this.#loadIndex();
    const entry = index.images[key];
    if (!entry) fail('图片不存在', { status: 404, code: 'image-not-found' });
    let changed = false;

    if ('title' in patch) {
      const v = cleanTitle(patch.title);
      if (v !== entry.title) { entry.title = v; changed = true; }
    }
    if ('description' in patch) {
      const v = cleanDescription(patch.description);
      if (v !== entry.description) { entry.description = v; changed = true; }
    }
    if ('tags' in patch) {
      const v = normalizeTags(patch.tags);
      if (JSON.stringify(v) !== JSON.stringify(entry.tags || [])) { entry.tags = v; changed = true; }
    }
    if (patch.category !== undefined && patch.category !== null && String(patch.category).trim()) {
      const target = this.#resolveExistingCategory(String(patch.category));
      if (target !== entry.category) {
        this.#moveEntryFile(entry, target);
        changed = true;
      }
    }
    if (changed) {
      entry.updatedAt = nowIso();
      this.#saveIndex();
      this._scanAt = 0;
    }
    return this.#public(entry);
  }

  #moveEntryFile(entry, targetCategory) {
    const src = this.#entryPath(entry);
    if (!src || !fs.existsSync(src)) {
      fail('图片文件已丢失，无法移动', { status: 404, code: 'image-file-missing' });
    }
    const dest = path.join(this.root, targetCategory, entry.file);
    if (fs.existsSync(dest)) {
      fail(`目标分类里已有同名文件：${entry.file}`, { status: 409, code: 'file-conflict' });
    }
    try {
      fs.renameSync(src, dest);
    } catch (error) {
      fail(`移动图片失败：${error?.message ?? error}`, { status: 500, code: 'move-failed' });
    }
    entry.category = targetCategory;
  }

  /** 删除一张图片（只删这一个文件 + 缩略图缓存）。 */
  remove(id) {
    this.#scanIfStale();
    const key = String(id || '');
    const index = this.#loadIndex();
    const entry = index.images[key];
    if (!entry) fail('图片不存在', { status: 404, code: 'image-not-found' });
    const abs = this.#entryPath(entry);
    if (abs) {
      try { fs.unlinkSync(abs); } catch (error) {
        if (error?.code !== 'ENOENT') {
          fail(`删除图片文件失败：${error?.message ?? error}`, { status: 500, code: 'delete-failed' });
        }
      }
    }
    const thumb = this.#thumbPath(key);
    try { fs.unlinkSync(thumb); } catch { /* 没有缩略图属正常 */ }
    this._thumbFailed.delete(key);
    delete index.images[key];
    this.#saveIndex();
    this._scanAt = 0;
    return { id: key };
  }

  /** 新建分类（= 在图库根目录下建一个同名文件夹）。 */
  createCategory(rawName) {
    this.#ensureRoot();
    const v = normalizeCategoryName(rawName);
    if (!v.ok) fail(v.error, { status: 400, code: 'bad-category' });
    const cats = this.#categoriesFromDisk();
    const exists = cats.find((c) => c.toLowerCase() === v.name.toLowerCase());
    if (exists) return { name: exists, created: false };
    const { maxCategories } = galleryLimits();
    if (cats.length >= maxCategories) {
      fail(`分类数量已达上限（${maxCategories} 个）`, { status: 409, code: 'too-many-categories' });
    }
    try {
      fs.mkdirSync(path.join(this.root, v.name));
    } catch (error) {
      fail(`创建分类文件夹失败：${error?.message ?? error}`, { status: 500, code: 'category-create-failed' });
    }
    this._scanAt = 0;
    return { name: v.name, created: true };
  }

  /** 重命名分类（重命名文件夹，并把索引里的 category 一起改掉）。 */
  renameCategory(rawFrom, rawTo) {
    // 先与磁盘对账：手动挪过文件时，索引里的 category 可能还是旧值，
    // 不先同步会导致"文件夹改了名，索引却只改了一半"。
    this.#scanIfStale();
    const from = this.#resolveExistingCategory(rawFrom);
    if (from === DEFAULT_CATEGORY) {
      fail(`「${DEFAULT_CATEGORY}」是默认分类，不能重命名`, { status: 400, code: 'default-category' });
    }
    const v = normalizeCategoryName(rawTo);
    if (!v.ok) fail(v.error, { status: 400, code: 'bad-category' });
    if (v.name === from) return { from, to: from };   // 同名重命名是 no-op，不该报"已存在"
    const cats = this.#categoriesFromDisk();
    const clash = cats.find((c) => c.toLowerCase() === v.name.toLowerCase() && c.toLowerCase() !== from.toLowerCase());
    if (clash) fail(`分类「${clash}」已存在`, { status: 409, code: 'category-exists' });

    const fromPath = path.join(this.root, from);
    const toPath = path.join(this.root, v.name);
    const caseOnly = from.toLowerCase() === v.name.toLowerCase() && from !== v.name;
    try {
      if (caseOnly) {
        // Windows 大小写不敏感：先改名到临时目录，再改成目标名
        const tmp = path.join(this.root, `.rename-${Date.now().toString(36)}`);
        fs.renameSync(fromPath, tmp);
        fs.renameSync(tmp, toPath);
      } else {
        if (fs.existsSync(toPath)) fail(`分类「${v.name}」已存在`, { status: 409, code: 'category-exists' });
        fs.renameSync(fromPath, toPath);
      }
    } catch (error) {
      if (error instanceof GalleryError) throw error;
      fail(`重命名分类失败：${error?.message ?? error}`, { status: 500, code: 'category-rename-failed' });
    }
    const index = this.#loadIndex();
    for (const entry of Object.values(index.images)) {
      if (entry.category === from) {
        entry.category = v.name;
        entry.updatedAt = nowIso();
      }
    }
    this.#saveIndex();
    this._scanAt = 0;
    return { from, to: v.name };
  }

  /**
   * 删除分类。分类里还有图片时必须显式给 moveTo（先移走再删目录），
   * 避免"点一下删除，图全没了"这种不可逆事故。
   */
  removeCategory(rawName, { moveTo = '' } = {}) {
    const name = this.#resolveExistingCategory(rawName);
    if (name === DEFAULT_CATEGORY) {
      fail(`「${DEFAULT_CATEGORY}」是默认分类，不能删除`, { status: 400, code: 'default-category' });
    }
    this.#scanIfStale(true);                    // 先与磁盘对账，确保 count 准确
    const index = this.#loadIndex();
    const entries = Object.values(index.images).filter((e) => e.category === name);
    let movedTo = '';
    if (entries.length) {
      if (!moveTo) {
        fail(`分类「${name}」里还有 ${entries.length} 张图片，请先把它们移到别的分类（或指定 moveTo）`, {
          status: 409,
          code: 'category-not-empty',
          details: { count: entries.length, category: name }
        });
      }
      movedTo = this.#resolveExistingCategory(moveTo);
      if (movedTo === name) fail('移入目标不能是分类自身', { status: 400, code: 'bad-move-target' });
      for (const entry of entries) {
        this.#moveEntryFile(entry, movedTo);
        entry.updatedAt = nowIso();
      }
      this.#saveIndex();
      this._scanAt = 0;
    }
    const dir = path.join(this.root, name);
    let remaining = [];
    try { remaining = fs.readdirSync(dir); } catch { remaining = []; }
    if (remaining.length) {
      fail(`分类目录里还有 ${remaining.length} 个未纳入图库的文件（可能是非图片/临时文件），请先手动处理`, {
        status: 409,
        code: 'category-has-extra-files',
        details: { files: remaining.slice(0, 20) }
      });
    }
    try {
      fs.rmdirSync(dir);                        // 只删空目录，绝不递归
    } catch (error) {
      fail(`删除分类文件夹失败：${error?.message ?? error}`, { status: 500, code: 'category-delete-failed' });
    }
    this._scanAt = 0;
    return { removed: name, moved: entries.length, moveTo: movedTo };
  }

  // ── 缩略图 ──────────────────────────────────────────────────────────────

  async #ensureFfmpeg() {
    if (this._ffmpegChecked) return this._ffmpeg;
    this._ffmpegChecked = true;
    for (const name of ['ffmpeg', 'ffmpeg.exe']) {
      // eslint-disable-next-line no-await-in-loop
      if (await runCapture(name, ['-version'], 5000)) { this._ffmpeg = name; break; }
    }
    return this._ffmpeg;
  }

  async #acquireThumbSlot() {
    if (this._thumbActive < 2) { this._thumbActive += 1; return; }
    await new Promise((resolve) => this._thumbWaiters.push(resolve));
    this._thumbActive += 1;
  }

  #releaseThumbSlot() {
    this._thumbActive = Math.max(0, this._thumbActive - 1);
    const next = this._thumbWaiters.shift();
    if (next) next();
  }

  async #ensureThumb(entry, absPath) {
    if (this._thumbFailed.has(entry.id)) return null;
    const dest = this.#thumbPath(entry.id);
    // 已有缓存且不比源文件旧才直接用；手动替换过同 id 的文件时重新生成。
    try {
      const st = fs.statSync(dest);
      if (st.size > 0 && st.mtimeMs >= Number(entry.mtimeMs || 0)) return dest;
    } catch { /* 没有缓存就往下生成 */ }
    if (this._thumbJobs.has(entry.id)) return this._thumbJobs.get(entry.id);
    const job = (async () => {
      await this.#acquireThumbSlot();
      try {
        if (!(await this.#ensureFfmpeg())) return null;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const ok = await runCapture(this._ffmpeg, [
          '-y', '-i', absPath,
          '-vf', "scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
          '-frames:v', '1', '-q:v', '5', dest
        ], 20000);
        if (!ok || !fs.existsSync(dest)) {
          this._thumbFailed.add(entry.id);
          return null;
        }
        return dest;
      } catch {
        this._thumbFailed.add(entry.id);
        return null;
      } finally {
        this.#releaseThumbSlot();
      }
    })().finally(() => this._thumbJobs.delete(entry.id));
    this._thumbJobs.set(entry.id, job);
    return job;
  }
}

/** 索引条目清洗：丢弃路径穿越/非法 id，保证手动编辑 index.json 也不能越界。 */
function normalizeIndexEntry(id, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = String(id || '');
  if (!SAFE_ID_RE.test(key)) return null;
  if (String(raw.id || key) !== key) return null;
  const file = String(raw.file || '');
  if (!file || /[\/\\]/.test(file) || file === '.' || file === '..') return null;
  const category = String(raw.category || DEFAULT_CATEGORY);
  if (!isSafeDirName(category)) return null;
  const ext = path.extname(file).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) return null;
  const createdAt = String(raw.createdAt || nowIso());
  return {
    id: key,
    file,
    category,
    mime: safeImageMime(raw.mime, ext),
    size: Number(raw.size) || 0,
    mtimeMs: Number(raw.mtimeMs) || 0,
    sha256: /^[0-9a-f]{64}$/i.test(String(raw.sha256 || '')) ? String(raw.sha256).toLowerCase() : '',
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    title: cleanTitle(raw.title),
    description: cleanDescription(raw.description),
    tags: normalizeTags(raw.tags),
    source: String(raw.source || 'manual').slice(0, 20),
    originalName: String(raw.originalName || '').slice(0, 200),
    sourceUrl: String(raw.sourceUrl || '').slice(0, 1000),
    senderId: String(raw.senderId || '').slice(0, 30),
    senderName: String(raw.senderName || '').slice(0, 80),
    messageId: String(raw.messageId || '').slice(0, 40),
    useCount: Number(raw.useCount) || 0,
    lastUsedAt: Number(raw.lastUsedAt) || 0,
    lastUsedBy: String(raw.lastUsedBy || '').slice(0, 100),
    createdAt,
    updatedAt: String(raw.updatedAt || createdAt)
  };
}

// ── 单例 ────────────────────────────────────────────────────────────────
// 管理端路由与模型工具必须操作**同一个**实例（同一个索引缓存），否则
// "管理端刚存的图，模型 list 不到"这类问题会非常隐蔽。
let singleton = null;
export function getGallery() {
  if (!singleton) singleton = new GalleryStore();
  return singleton;
}
