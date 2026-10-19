// zip 解压安装：把市场下载的安装包安全地落到 skills/ 或 plugins/ 目录。
//
// 独立成模块的原因：这段是"往磁盘写可执行 JS"的入口，安全边界必须集中、可单测。
// 与 server/community_app.py 的 validate_zip 规则对齐（那里上传时校验一次，
// 这里安装前再校验一次 —— 不信任任何传输环节）。
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const BANNED_EXT = /\.(exe|dll|bat|cmd|ps1|vbs|sh)$/i;
const MODULE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_FILES = 100;
const MAX_TOTAL = 32 * 1024 * 1024;

/**
 * 解压前校验中央目录元数据，不读取解压内容。
 * 返回仅含文件的描述符；真正解压时按剩余总量限制 zlib 输出。
 */
export function validateZipStructure(buffer) {
  const entries = parseZipDirectory(buffer);
  let total = 0;
  for (const e of entries) {
    validateEntryName(e.name);
    if (BANNED_EXT.test(e.name)) throw new Error(`安装包包含禁止的文件类型：${e.name}`);
    if (e.uncompressedSize > MAX_TOTAL - total) throw new Error('解压后总大小超过 32MB');
    total += e.uncompressedSize;
    if (e.method === 0 && e.compressedSize !== e.uncompressedSize) {
      throw new Error(`存储条目大小不匹配：${e.name}`);
    }
  }
  return entries;
}

/**
 * 解压安装到 <root>/skills/ 或 <root>/plugins/ 下的一个目录。
 *
 * 目录名规则：
 *   · zip 里通常有一层与包同名的根目录（服务端打包格式 `<id>/...`），剥掉它
 *   · 没有统一根目录时用 preferId（服务器告知的 id）
 *   · 与本地已有目录冲突 → 自动 _1/_2（重装场景：同 id 覆盖会丢用户改动，
 *     而且插件热重载正在 watch 旧目录，覆盖写一半会加载出半截代码）
 *
 * @returns {Promise<string>} 实际落地的目录名
 */
export async function unzipToModuleDir(buffer, { root, type, preferId = '' }) {
  const descriptors = validateZipStructure(buffer);
  const entries = inflateEntries(buffer, descriptors);
  if (!entries.length) throw new Error('安装包是空的');
  const baseDir = path.resolve(root, type === 'plugin' ? 'plugins' : 'skills');

  // 剥统一根目录：所有条目都共享同一个第一段时去掉它
  let names = entries.map((e) => e.name);
  let strip = 0;
  const firstSeg = names[0].split('/')[0];
  if (firstSeg && names.every((n) => n.startsWith(firstSeg + '/'))) strip = firstSeg.length + 1;
  const relNames = names.map((n) => n.slice(strip));
  if (relNames.some((n) => !n)) throw new Error('安装包结构异常（剥掉根目录后有条目为空）');

  // 落地目录名：优先 zip 根目录名，其次 preferId；两者都必须是单段安全标识。
  const dirName = strip ? firstSeg : (preferId || 'module');
  if (!MODULE_NAME_RE.test(dirName)) throw new Error(`安装包模块目录名非法：${dirName}`);
  fs.mkdirSync(baseDir, { recursive: true });

  // mkdir 的原子独占创建同时处理并发安装；冲突时换名，耗尽上限就失败，
  // 不能用 recursive=true 复用 _100 并覆盖已安装内容。
  let finalName = '';
  let target = '';
  for (let n = 0; n <= 100; n++) {
    const candidateName = n === 0 ? dirName : `${dirName}_${n}`;
    if (!MODULE_NAME_RE.test(candidateName)) {
      throw new Error('安装包模块目录名过长，无法生成安全的冲突后缀');
    }
    const candidate = path.resolve(baseDir, candidateName);
    const rel = path.relative(baseDir, candidate);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`安装包模块目录越界：${candidateName}`);
    }
    try {
      fs.mkdirSync(candidate);
      finalName = candidateName;
      target = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  if (!target) throw new Error(`同名目录冲突过多，无法安装：${dirName}`);

  for (let i = 0; i < entries.length; i++) {
    const rel = relNames[i];
    // 二次防线：拼接结果必须仍在 target 内（解析后 path.relative 检查）
    const dest = path.join(target, ...rel.split('/'));
    const relCheck = path.relative(target, dest);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`安装包包含非法路径：${entries[i].name}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entries[i].data);
  }
  return finalName;
}

/** 解析中央目录和本地头偏移，不解压任何条目。 */
function parseZipDirectory(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('zip 内容必须是 Buffer');
  if (buffer.length < 22) throw new Error('不是有效的 zip 文件');
  const sig = (off) => buffer.readUInt32LE(off);
  // 定位 EOCD（22 字节，从尾部向前扫，允许有注释）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i--) {
    if (sig(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  if (count > MAX_FILES) throw new Error(`文件数量过多（${count} > ${MAX_FILES}）`);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const directoryEnd = directoryOffset + directorySize;
  if (directoryOffset > eocd || directoryEnd > eocd) throw new Error('zip 中央目录范围损坏');

  const out = [];
  let ptr = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > directoryEnd) throw new Error('zip 中央目录损坏');
    if (sig(ptr) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const uncompressedSize = buffer.readUInt32LE(ptr + 24);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOff = buffer.readUInt32LE(ptr + 42);
    const nextPtr = ptr + 46 + nameLen + extraLen + commentLen;
    if (nextPtr > directoryEnd) throw new Error('zip 中央目录损坏');
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    const normalizedName = name.replace(/\\/g, '/');

    validateEntryName(normalizedName);
    if (normalizedName.endsWith('/')) {
      if (uncompressedSize !== 0 || compSize !== 0) throw new Error(`目录条目包含数据：${name}`);
    } else {
      if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式（method=${method}）：${name}`);
      if (localOff + 30 > directoryOffset || sig(localOff) !== 0x04034b50) {
        throw new Error('zip 本地头损坏');
      }
      const lNameLen = buffer.readUInt16LE(localOff + 26);
      const lExtraLen = buffer.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const dataEnd = dataStart + compSize;
      if (dataStart > directoryOffset || dataEnd > directoryOffset || dataEnd > buffer.length) {
        throw new Error(`zip 条目数据范围损坏：${name}`);
      }
      out.push({ name: normalizedName, method, compressedSize: compSize, uncompressedSize, dataStart });
    }
    ptr = nextPtr;
  }
  if (ptr !== directoryEnd) throw new Error('zip 中央目录长度不匹配');
  return out;
}

function validateEntryName(name) {
  const normalized = String(name).replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
      || normalized.includes('\0') || parts.includes('..')) {
    throw new Error(`安装包包含非法路径：${name}`);
  }
  if (BANNED_EXT.test(normalized)) throw new Error(`安装包包含禁止的文件类型：${name}`);
}

function inflateEntries(buffer, descriptors) {
  let total = 0;
  const out = [];
  for (const entry of descriptors) {
    const remaining = MAX_TOTAL - total;
    if (entry.uncompressedSize > remaining) throw new Error('解压后总大小超过 32MB');
    const raw = buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let data;
    if (entry.method === 0) {
      data = Buffer.from(raw);
    } else {
      // 也约束单条输出为其声明大小，防止伪造较小中央目录尺寸的 zip 炸弹。
      const maxOutputLength = Math.max(1, Math.min(remaining, entry.uncompressedSize));
      data = inflateRawSync(raw, { maxOutputLength });
    }
    if (data.length !== entry.uncompressedSize) throw new Error(`条目解压大小与中央目录不符：${entry.name}`);
    total += data.length;
    out.push({ name: entry.name, data });
  }
  return out;
}
