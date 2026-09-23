import { canvas, box, text, lines, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 600);

marker(k, 700, 46, 620);
text(k, 700, 46, '과부하 정책은 지연을 정하고, 개인화 비율은 모델 용량이 정한다', { size: 25, weight: 700 });
text(k, 700, 80, '추천 모델 처리량 80건/초 고정 · 유입 1×·2×·4× · 모델은 같은 프로세스의 스텁', { size: 15, fill: '#868e96' });

const cols = [
  { x: 40, name: 'ADMISSION (기본값)', color: C.green, rows: ['대기 예산 100ms로 자른다', '', 'p95 160ms (세 부하 모두)', 'coverage 93.6 / 47.1 / 23.7%', '4× 달성 부하 283/s'] },
  { x: 495, name: 'BOUNDED', color: C.blue, rows: ['대기열 상한 24', '', 'p95 320ms', 'coverage 93.7 / 47.1 / 23.7%', '모델이 2배가 되면 같은 24가 150ms'] },
  { x: 950, name: 'UNBOUNDED', color: C.red, rows: ['아무것도 거절하지 않는다', '', 'p95 454ms', 'coverage 93.5 / 46.9 / 31.4%', '4× 달성 부하 212/s · 3,102건 못 받음'] },
];
cols.forEach(c => {
  box(k, c.x, 120, 410, 270, { color: c.color });
  text(k, c.x + 205, 156, c.name, { size: 19, weight: 700, fill: c.color.s });
  lines(k, c.x + 205, 262, c.rows, { size: 15, gap: 27 });
});

box(k, 40, 420, 1320, 150, { color: C.yellow });
lines(k, 700, 495, [
  'coverage 차이는 ±0.3%p. coverage는 모델 처리량 ÷ 유입에서 곧장 나온다. 정책은 누가 포기할지를 정할 뿐이다',
  'UNBOUNDED의 31.4%는 생존자 편향이다. 받지도 못한 요청이 분모에서 빠졌다',
  'coverage는 달성 부하와 함께 읽는다. 달성률이 낮은 런의 coverage는 좋아 보이는 방향으로 틀린다',
], { size: 15, gap: 30, weight: 600 });
writeFileSync(process.argv[2], render(k));
