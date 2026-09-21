import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 값을 올리면 무엇을 얻고 무엇을 내는지. 초록이 얻는 쪽, 빨강이 대가.
const k = canvas(1400, 660);

text(k, 700, 30, '초록 = 얻는 것 · 빨강 = 대가', { size: 14, weight: 600, fill: '#868e96' });

const cells = [
  ['Concurrency ↑', 'Throughput ↑', 'Contention / Queueing ↑ 가능'],
  ['Connection Pool ↑', 'Application Connection Wait ↓', 'DB Concurrency / DB Load ↑'],
  ['Cache TTL ↑', 'Hit Rate ↑', 'Stale Data ↑'],
  ['Batch Size ↑', 'Throughput ↑', '개별 작업 Latency ↑'],
  ['Sampling Frequency ↑', '관측 정밀도 ↑', '관측 Overhead ↑'],
  ['Compression ↑', 'Network / Memory ↓', 'CPU Cost ↑'],
];

cells.forEach((c, i) => {
  const x = 40 + (i % 2) * 700;
  const y = 70 + Math.floor(i / 2) * 200;
  const [knob, gain, cost] = c;

  box(k, x, y + 52, 180, 62, { color: C.gray, r: 10 });
  text(k, x + 90, y + 90, knob, { size: 15, weight: 700, fill: C.gray.s });

  box(k, x + 250, y + 12, 390, 62, { color: C.green, r: 10 });
  text(k, x + 445, y + 50, gain, { size: 16, weight: 700, fill: C.green.s });

  box(k, x + 250, y + 92, 390, 62, { color: C.red, r: 10 });
  text(k, x + 445, y + 130, cost, { size: 16, weight: 700, fill: C.red.s });

  arrow(k, x + 186, y + 72, x + 244, y + 45, { color: '#adb5bd' });
  arrow(k, x + 186, y + 94, x + 244, y + 121, { color: '#adb5bd' });
});

writeFileSync(process.argv[2], render(k));
