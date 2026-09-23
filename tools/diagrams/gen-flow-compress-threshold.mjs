import { canvas, box, text, lines, line, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 620);

marker(k, 700, 46, 520);
text(k, 700, 46, '압축은 작은 값에서 손해이고, 임계값은 교차점에 두지 않았다', { size: 25, weight: 700 });
text(k, 700, 80, '컨텍스트 JSON 모양의 값 · 저장/원본 비율(1보다 크면 손해) · 로컬 Redis', { size: 15, fill: '#868e96' });

const rows = [
  ['187B', 1.070, 1.070], ['279B', 0.817, 0.846], ['553B', 0.499, 0.521],
  ['1.1KB', 0.338, 0.352], ['50KB', 0.168, 0.163], ['500KB', 0.166, 0.170],
];
const X0 = 170, W = 420;          // 비율 1.0 = 420px
text(k, 380, 130, 'LZ4 · SNAPPY 저장/원본', { size: 16, weight: 700 });
rows.forEach(([label, lz, sn], i) => {
  const y = 150 + i * 62;
  text(k, X0 - 14, y + 30, label, { size: 15, weight: 600, anchor: 'end' });
  box(k, X0, y + 6, lz * W, 20, { color: lz > 1 ? C.red : C.blue, r: 6 });
  box(k, X0, y + 30, sn * W, 20, { color: lz > 1 ? C.red : C.green, r: 6 });
  text(k, X0 + Math.max(lz, sn) * W + 12, y + 32, `${lz.toFixed(3)} / ${sn.toFixed(3)}`, { size: 13.5, anchor: 'start' });
});
line(k, X0 + W, 140, X0 + W, 520, { color: C.red.s, width: 1.6 });
text(k, X0 + W, 540, '1.0 (원본 크기)', { size: 13, fill: C.red.s });
text(k, 380, 580, '파랑 LZ4 · 초록 SNAPPY · 빨강은 둘 다 원본보다 커짐', { size: 13, fill: '#868e96' });

box(k, 760, 120, 600, 140, { color: C.orange });
text(k, 1060, 154, '교차점은 사실, 임계값은 결정', { size: 18, weight: 700, fill: C.orange.s });
lines(k, 1060, 210, ['교차점 187~279B 근처의 이득은 몇 %라 값이 조금만 달라도 뒤집힌다', '1KB에서는 66% 감소 → 임계값 1KB'], { size: 14.5, gap: 26 });

box(k, 760, 280, 600, 140, { color: C.blue });
text(k, 1060, 314, '코덱은 통념과 반대로 나왔다', { size: 18, weight: 700, fill: C.blue.s });
lines(k, 1060, 370, ['500KB · 500왕복 CPU: SNAPPY 242ms · LZ4 359ms', '왜 뒤집혔는지는 확인하지 못했다'], { size: 14.5, gap: 26 });

box(k, 760, 440, 600, 150, { color: C.yellow });
text(k, 1060, 474, '값은 정했고 켜지 않았다', { size: 18, weight: 700 });
lines(k, 1060, 532, ['적용할 캐시가 없다. 컨텍스트 캐시는 Lua가 값을 읽어', '병합하므로 압축하면 병합이 깨진다', '500KB get p99: 압축 없음 2.02ms · LZ4 0.27ms'], { size: 14.5, gap: 25 });
writeFileSync(process.argv[2], render(k));
