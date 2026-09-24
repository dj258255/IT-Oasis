import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 565);
text(k, 700, 46, "홈 2쪽 모델 입력: 세션인가 구매인가", { size: 24, weight: 700 });
text(k, 700, 80, "H&M 홀드아웃 주에 산 고객 1,000명 · 조회 한 건 뒤의 2쪽 · 기준은 측정 전에 이슈에", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "V0 세션(지금)", ["최근 조회·클릭", "", "recall 0.0013", "세션 반영 75.0%"]);
panel(490, 120, 420, 220, C.green, "V1 구매", ["결제 완료 주문 최근 100건", "", "recall 0.0251 (약 19배)", "세션 반영 0.0%"]);
panel(940, 120, 420, 220, C.orange, "V2 세션 + 구매", ["조회를 구매 앞에 붙임", "", "recall 0.0191 (V1의 0.76배)", "세션 반영 12.8% (기준 +20%p)"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.blue, "결정", ["구매를 쓰는 사용자의 2쪽은 구매만 넣는다", "입력은 추천 모듈이 고른다 (추천 행과 같은 규칙)", "", "배선: 엔진 직접 호출과 1,000/1,000 일치"], 15, 29);
panel(720, 380, 640, 270, C.red, "버린 실행 두 번", ["DB 활동 기록이 남아 조회가 409 → 기록 0%", "도커 Redis를 지웠는데 앱은 로컬 redis-server에", "", "이제 시작 전에 세션이 비었는지 확인한다"], 15, 29);
writeFileSync(process.argv[2], render(k));
