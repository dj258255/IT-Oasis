import { canvas, box, frame, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
// 새 그림 — 상황 4(읽는 쪽을 전수로 봤다). 지금까지 이 자리에 그림이 없었다.
const k = canvas(1400, 660);

marker(k, 700, 46, 420);
text(k, 700, 46, '읽는 쪽을 전수로 봤다', { size: 27, weight: 700 });
text(k, 700, 78, '배치는 다 읽고 있었고, 서빙은 건수만 묶여 있었다', { size: 15, fill: '#868e96' });

frame(k, 40, 112, 640, 250, { color: C.orange });
text(k, 360, 144, '배치 — 상한이 없었다', { size: 19, weight: 700, fill: C.orange.s });
box(k, 80, 172, 250, 66, { color: C.gray }); lines(k, 205, 205, ['상한 없는 조회', '15곳'], { size: 16, weight: 700 });
box(k, 390, 172, 250, 66, { color: C.orange }); lines(k, 515, 205, ['500건 쌓이면', '500건을 한 번에'], { size: 15, weight: 600 });
arrow(k, 335, 205, 385, 205, { color: C.orange.s });
box(k, 80, 262, 560, 66, { color: C.green });
text(k, 360, 293, '상한 100건으로 묶었다 — 커서는 안 넣었다(항상 offset 0)', { size: 16, weight: 700 });

frame(k, 720, 112, 640, 250, { color: C.blue });
text(k, 1040, 144, '서빙 — 건수는 묶여 있었다', { size: 19, weight: 700, fill: C.blue.s });
box(k, 760, 172, 250, 66, { color: C.gray }); lines(k, 885, 205, ['findTop50', '건수는 이미 50건'], { size: 15, weight: 600 });
box(k, 1070, 172, 250, 66, { color: C.red }); lines(k, 1195, 205, ['그런데 65.6ms', '30만 행을 훑었다'], { size: 15, weight: 700 });
arrow(k, 1015, 205, 1065, 205, { color: C.red.s });
box(k, 760, 262, 560, 66, { color: C.green });
text(k, 1040, 293, '(user_id, id) 인덱스 → 0.6ms · 조회 조건 22개 중 18개에 인덱스', { size: 15, weight: 700 });

box(k, 40, 392, 1320, 82, { color: C.yellow, r: 14 });
text(k, 700, 424, 'EXPLAIN 만 봤으면 못 잡았다', { size: 19, weight: 700 });
text(k, 700, 452, '같은 노드에서 옵티마이저 추정 rows=50 · 실제 300,030행. 계획만 보면 멀쩡했다', { size: 15 });

frame(k, 40, 500, 1320, 120, { color: C.purple });
text(k, 700, 530, '한 건이 싸다고 동시에도 싼 건 아니라서 부하를 걸었다', { size: 17, weight: 700, fill: C.purple.s });
const steps = [['600/s', '5ms'], ['1000/s', '6ms'], ['1400/s', '7ms'], ['1800/s', '10ms'], ['2200/s', '27ms']];
steps.forEach(([r, ms], i) => {
  const x = 90 + i * 250;
  box(k, x, 548, 210, 52, { color: i === 3 ? C.green : C.gray, r: 10 });
  text(k, x + 105, 580, `${r}  ${ms}`, { size: 16, weight: i === 3 ? 700 : 500 });
});
text(k, 945, 542, '← 무릎', { size: 14, weight: 700, fill: C.green.s });
text(k, 700, 640, '평탄 p95 5ms 에 무릎 1,800 req/s — 조회 한 건이 이미 5ms 라 읽기 캐시는 안 넣었다(무릎 위 병목은 안 쟀다)',
  { size: 15, fill: '#868e96' });
writeFileSync(process.argv[2], render(k));
