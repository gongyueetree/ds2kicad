// lib/png.js — v0.8.7 item 7：完整 PNG 解码校验（拒绝"只有 PNG 头"的伪文件）。
// 逐 chunk 遍历：校验长度、类型、CRC32；要求 IHDR 首、IEND 尾、至少一个 IDAT，
// 并对 IDAT 做 zlib inflate 验证（内容真的能解开），最后按位深/颜色类型核对像素体积。
import { inflateSync } from 'node:zlib';

const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** @returns {{ok:true,width,height,bitDepth,colorType}|{ok:false,error}} */
export function decodePngStrict(buf, { maxBytes = 8 * 1024 * 1024, maxDim = 20000 } = {}) {
  if (!Buffer.isBuffer(buf)) return { ok: false, error: '不是二进制数据' };
  if (buf.length > maxBytes) return { ok: false, error: `超过 ${Math.round(maxBytes / 1048576)}MB` };
  if (buf.length < 45) return { ok: false, error: 'PNG 过短（最小合法 PNG 也需要 IHDR+IDAT+IEND）' };
  if (!buf.subarray(0, 8).equals(MAGIC)) return { ok: false, error: '魔数不匹配' };

  let off = 8, sawIHDR = false, sawIEND = false;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    if (off + 8 > buf.length) return { ok: false, error: 'chunk 头截断' };
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const dataStart = off + 8, dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) return { ok: false, error: `chunk ${type} 数据截断（声明 ${len} 字节）` };
    const data = buf.subarray(dataStart, dataEnd);
    const crcDeclared = buf.readUInt32BE(dataEnd);
    const crcActual = crc32(buf.subarray(off + 4, dataEnd));
    if (crcDeclared !== crcActual) return { ok: false, error: `chunk ${type} CRC 校验失败` };

    if (type === 'IHDR') {
      if (sawIHDR) return { ok: false, error: '重复的 IHDR' };
      if (len !== 13) return { ok: false, error: 'IHDR 长度非法' };
      sawIHDR = true;
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
      if (!width || !height) return { ok: false, error: '宽高为 0' };
      if (width > maxDim || height > maxDim) return { ok: false, error: `尺寸过大 ${width}x${height}` };
      if (!(CHANNELS[colorType] >= 1)) return { ok: false, error: `非法颜色类型 ${colorType}` };
      if (![1, 2, 4, 8, 16].includes(bitDepth)) return { ok: false, error: `非法位深 ${bitDepth}` };
    } else if (type === 'IDAT') {
      if (!sawIHDR) return { ok: false, error: 'IDAT 出现在 IHDR 之前' };
      idat.push(data);
    } else if (type === 'IEND') {
      sawIEND = true;
      if (len !== 0) return { ok: false, error: 'IEND 长度必须为 0' };
      break;
    }
    off = dataEnd + 4;
  }
  if (!sawIHDR) return { ok: false, error: '缺少 IHDR' };
  if (!sawIEND) return { ok: false, error: '缺少 IEND' };
  if (!idat.length) return { ok: false, error: '缺少 IDAT（只有 PNG 头的伪文件）' };

  // 真正解压 IDAT —— 只有头没有有效像素数据的伪文件会在此失败
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (e) {
    return { ok: false, error: `IDAT 解压失败：${e.message}` };
  }
  if (interlace === 0) {
    const bpp = (CHANNELS[colorType] * bitDepth) / 8;
    const expected = height * (1 + Math.ceil(width * CHANNELS[colorType] * bitDepth / 8));
    if (raw.length !== expected) {
      return { ok: false, error: `像素数据长度不符（期望 ${expected}，实际 ${raw.length}）` };
    }
    void bpp;
  }
  return { ok: true, width, height, bitDepth, colorType, bytes: buf.length };
}
