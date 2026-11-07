// =====================================================================
// 앱 아이콘(PNG) 생성: node tools/make-icons.mjs
// 테라코타 바탕에 크림색 "=" (차변 = 대변). 외부 라이브러리 없이 PNG를 직접 만듭니다.
// =====================================================================

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [0xA9, 0x50, 0x2A];   // --primary (테라코타)
const FG = [0xFF, 0xFC, 0xF8];   // --surface (크림)

/** 둥근 사각형 안에 있는지 (0~1 좌표) */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * @param {number} size 픽셀 크기
 * @param {boolean} maskable true면 바탕을 꽉 채우고 그림을 안전 영역(가운데 80%) 안에 둠
 */
function draw(size, maskable) {
  const scale = maskable ? 0.8 : 1;
  const px = Buffer.alloc(size * size * 4);
  const S = 4; // 계단 현상 줄이기: 픽셀당 4x4 표본
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (pxl + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          const inBg = maskable || inRoundRect(x, y, 0, 0, 1, 1, 0.22);
          if (!inBg) continue;
          bg++;
          // 가운데 기준 좌표 (안전 영역 축소 반영)
          const u = 0.5 + (x - 0.5) / scale;
          const v = 0.5 + (y - 0.5) / scale;
          const bar = (top) => inRoundRect(u, v, 0.24, top, 0.76, top + 0.11, 0.055);
          if (bar(0.33) || bar(0.56)) fg++;
        }
      }
      const i = (py * size + pxl) * 4;
      const n = S * S;
      const a = bg / n;
      const f = bg ? fg / bg : 0;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(BG[c] * (1 - f) + FG[c] * f);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, px);
}

// ---------- PNG 인코딩 ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // 필터 없음
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // 비트 깊이
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../icons/', import.meta.url);
mkdirSync(out, { recursive: true });
const files = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],   // iOS는 모서리를 알아서 둥글게 깎음
  ['favicon-32.png', 32, false],
];
for (const [name, size, maskable] of files) {
  writeFileSync(new URL(name, out), draw(size, maskable));
  console.log('✔', name);
}
