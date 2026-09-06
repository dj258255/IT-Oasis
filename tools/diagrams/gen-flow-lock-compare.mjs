import { canvas, box, frame, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';

// 재고 락 3종 — 인메모리와 실 MySQL 에서 순위가 뒤집힌 것이 요지다
const k = canvas(1400, 640);

marker(k, 700, 46, 560);
text(k, 700, 46, '인메모리에서 잰 순위가 실 DB에서 뒤집혔다', { size: 27, weight: 700 });
text(k, 700, 78, '스레드 30개가 재고 20에 동시 차감. 셋 다 초과판매 0, 소요만 갈렸다', { size: 15, fill: '#868e96' });

const rows = [
  { name: '조건부 UPDATE', mem: 21, db: 40, hi: 79, color: C.green, note: '한 번의 UPDATE 로 끝낸다' },
  { name: '비관적 락',     mem: 32, db: 75, hi: null, color: C.blue, note: '줄을 세운다' },
  { name: '낙관적 락',     mem: 17, db: 151, hi: 429, color: C.red, note: '부딪히면 다시 읽고 다시 쓴다' },
];

// 왼쪽 — 인메모리
frame(k, 40, 118, 640, 400, { color: C.gray });
text(k, 360, 152, '인메모리 DB 에서', { size: 19, weight: 700 });
text(k, 360, 178, '낙관적이 제일 빨라 보였다', { size: 14, fill: '#868e96' });

const memMax = 32;
rows.slice().sort((a, b) => a.mem - b.mem).forEach((r, i) => {
  const y = 208 + i * 96;
  box(k, 70, y, 200, 62, { color: r.color });
  text(k, 170, y + 37, r.name, { size: 17, weight: 700 });
  const w = 300 * (r.mem / memMax);
  box(k, 300, y + 14, w, 34, { color: r.color, roughness: 1.0, r: 8 });
  text(k, 300 + w + 40, y + 38, `${r.mem}ms`, { size: 18, weight: 700, fill: r.color.s });
});
text(k, 360, 496, '왕복 비용이 거의 공짜라 재시도가 싸게 먹힌다', { size: 14, fill: '#868e96' });

// 오른쪽 — 실 MySQL
frame(k, 720, 118, 640, 400, { color: C.purple });
text(k, 1040, 152, '실 MySQL 8.4 InnoDB 에서', { size: 19, weight: 700 });
text(k, 1040, 178, '낙관적이 제일 느리다', { size: 14, fill: '#868e96' });

const dbMax = 151;
rows.forEach((r, i) => {
  const y = 208 + i * 96;
  box(k, 750, y, 200, 62, { color: r.color });
  text(k, 850, y + 37, r.name, { size: 17, weight: 700 });
  const w = 300 * (r.db / dbMax);
  box(k, 980, y + 14, w, 34, { color: r.color, roughness: 1.0, r: 8 });
  text(k, 980 + w + 42, y + 38, `${r.db}ms`, { size: 18, weight: 700, fill: r.color.s });
});
text(k, 1040, 496, '충돌마다 도는 조회·갱신 왕복이 여기서는 비싸다', { size: 14, fill: '#868e96' });

arrow(k, 686, 318, 714, 318, { color: C.purple.s });

// 아래 — 고경합
box(k, 40, 552, 1320, 62, { color: C.yellow, r: 16 });
text(k, 700, 590, '고경합 150스레드에서는 격차가 더 벌어진다 — 조건부 79ms 대 낙관적 429ms (5.4배)',
  { size: 17, weight: 700 });

writeFileSync(process.argv[2], render(k));
console.log('  →', process.argv[2]);
