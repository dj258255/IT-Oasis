import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 615);
text(k, 700, 46, "실제 GenPage 모델로 다시 잰 과부하", { size: 24, weight: 700 });
text(k, 700, 80, "모델 서버 직접: /recommend 999/s (p95 4.9ms) · /page 121/s · 앱·모델·k6 가 한 머신", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "추천 행", ["모델보다 앱이 먼저 포화", "", "150 · 300/s 에서 coverage 99%+", "설정값 추정은 88% 거절 (무효 실행)"]);
panel(490, 120, 420, 220, C.red, "게이트 밖의 2쪽 호출", ["2쪽 121/s · 자리 제한 없음", "앱이 포기한 요청까지 서버가 계산", "", "추천 행 coverage 0% · 실패 214"]);
panel(940, 120, 420, 220, C.green, "같은 자리를 나눠 쓴다", ["2쪽도 추천 행의 동시 호출 4 자리", "자리가 없으면 기다리지 않고 규칙 행", "", "모델 실패 0"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "대조: 모델이 없어도 무너졌다", ["규칙 행만 · 2쪽 121/s → p95 3.4초", "2쪽 앱 경로가 30~60/s 에서 먼저 포화", "", "자리 공유는 앱이 버티는 30/s 에서 판정"], 15, 29);
panel(720, 380, 640, 270, C.blue, "앱이 버티는 2쪽 30/s", ["자리 없음 p95 91.0ms · 공유 79.6ms", "자리가 없어 물러선 비율 0.1% 이하", "", "규칙 행(164.7ms)이 모델 행보다 비쌌다"], 15, 29);
writeFileSync(process.argv[2], render(k));
