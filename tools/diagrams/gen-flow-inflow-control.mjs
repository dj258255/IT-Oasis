import { canvas, box, frame, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 580);

marker(k, 700, 46, 560);
text(k, 700, 46, '전부를 느리게 하느니 일부는 잠시 뒤로 미룬다', { size: 27, weight: 700 });
text(k, 700, 78, '감당 못 할 요청은 가장 바깥에서 싸게 걸러 낸다. 같은 스파이크를 제어 전후로 쟀다', { size: 15, fill: '#868e96' });

box(k, 40, 190, 190, 130, { color: C.red });
lines(k, 135, 255, ['선착순 폭주', '15,445건'], { size: 17, weight: 700 });

frame(k, 280, 120, 700, 270, { color: C.purple });
text(k, 630, 150, '문 앞 세 겹 — Redis 재사용이라 추가 비용 0', { size: 16, weight: 700, fill: C.purple.s });
const layers = [
  { t: '① 초당 요청 제한', d: ['한 사람 5건/초 · 전체 100건/초', '429 + 다시 올 시각'], c: C.blue },
  { t: '② 선착순 대기열', d: ['입장권 없으면 결제 진입 불가'], c: C.green },
  { t: '③ DB 연결', d: ['길게 기다리지 않고 빨리 실패'], c: C.orange },
];
layers.forEach((l, i) => {
  const y = 172 + i * 72;
  box(k, 305, y, 650, 62, { color: l.c });
  text(k, 430, y + 36, l.t, { size: 16, weight: 700 });
  lines(k, 760, y + 31, l.d, { size: 13.5, gap: 19 });
});

box(k, 1030, 190, 190, 130, { color: C.green });
lines(k, 1125, 245, ['DB 도달', '약 510건', '들어온 것의 2.5%'], { size: 16, weight: 700, gap: 23 });

arrow(k, 235, 255, 275, 255, { color: C.red.s });
arrow(k, 985, 255, 1025, 255, { color: C.green.s });

box(k, 40, 420, 650, 62, { color: C.yellow, r: 14 });
text(k, 365, 458, '폭주의 97.5% 를 문 앞에서 걸렀다', { size: 18, weight: 700 });
box(k, 710, 420, 650, 62, { color: C.yellow, r: 14 });
text(k, 1035, 458, '통과한 요청 p95 737.81 → 52.01ms', { size: 18, weight: 700 });

text(k, 700, 526, '이 런에서 실제로 쳐낸 것은 ① 한 층뿐이었다. 40계정으로 다시 재서 ② 를 처음 발동시켰다.', { size: 15, fill: '#868e96' });
writeFileSync(process.argv[2], render(k));
