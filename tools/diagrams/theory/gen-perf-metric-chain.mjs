import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 지표가 이어지는 순서만 그린다. 해석은 본문이 맡는다.
const k = canvas(1400, 240);

const steps = [
  ['트래픽 증가', 'RPS ↑', C.gray],
  ['DB 요청 증가', 'QPS ↑', C.gray],
  ['쿼리 지연 증가', 'SQL p95 ↑', C.orange],
  ['커넥션 반환 지연', '점유 시간 ↑', C.orange],
  ['풀 대기 증가', 'pending ↑', C.red],
  ['API p95 증가', 'p95 ↑', C.red],
];
const w = 178, h = 118, gap = 46, y = 60;
steps.forEach(([t, s, c], i) => {
  const x = 40 + i * (w + gap);
  box(k, x, y, w, h, { color: c });
  text(k, x + w / 2, y + 48, t, { size: 17, weight: 700, fill: c.s });
  text(k, x + w / 2, y + 84, s, { size: 14, weight: 600 });
  if (i < steps.length - 1) arrow(k, x + w + 6, y + h / 2, x + w + gap - 6, y + h / 2, { color: '#adb5bd' });
});

writeFileSync(process.argv[2], render(k));
