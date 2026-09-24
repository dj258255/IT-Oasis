import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 490);
text(k, 700, 46, "조회가 몰리면 웹훅이 먼저 늦는다", { size: 24, weight: 700 });
text(k, 700, 80, "PG가 느린 동안 상품 조회를 더했다 · 토스 웹훅 규약: 10초 안에 2xx", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "조회가 커넥션을 쥔다", ["상품 조회 초당 200 · 400 · 800", "", "DB 커넥션 풀이 마르고", "웹훅도 같은 줄에 선다"]);
panel(490, 120, 420, 220, C.red, "웹훅이 10초를 넘긴다", ["조회 200/s · 웹훅 p95 12,021ms", "10초 초과 15.57%", "", "800/s · 10초 초과 81.90%"]);
panel(940, 120, 420, 220, C.green, "진행 중 조회를 16개로", ["넘치면 새 조회는 바로 503", "", "웹훅 p95 152~186ms", "10초 초과 0%"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "대가", ["조회의 31~83%를 돌려보냈다", "늦을 때 대가가 가장 싼 요청을 먼저 버린다", "", "문턱 16은 하나만 쟀다 · 풀 크기와 같이 바뀐다"], 15, 29);
panel(720, 380, 640, 270, C.blue, "주의", ["조회 용량 벤치마크는 이 필터를 끄고 잰다", "켠 채로 재면 용량이 아니라 문턱을 잰다", "", "실제 토스 재전송을 받아 본 것은 아니다"], 15, 29);
writeFileSync(process.argv[2], render(k));
