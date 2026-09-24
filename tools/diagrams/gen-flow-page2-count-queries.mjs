import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 490);
text(k, 700, 46, "홈 2쪽이 요청마다 세던 상품 수", { size: 24, weight: 700 });
text(k, 700, 80, "상품 105,545건 · 대분류 5개 · 모델 없이 규칙 행 · 같은 시간대에 고치기 전과 뒤", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "행 제목 5개", ["카테고리 목록 메서드를 재사용", "대분류마다 상품 수를 센다", "", "count 5개 · 합 19.2ms"]);
panel(490, 120, 420, 220, C.red, "신상품 채우기", ["상품 목록 검색(Page)을 재사용", "대분류 전체 개수를 같이 센다", "", "count 1~7ms · select 는 1ms 안팎"]);
panel(940, 120, 420, 220, C.green, "개수 없는 조회로", ["이름만 읽는다", "List 를 돌려주면 count 가 없다", "", "정렬은 그대로"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "2쪽 용량 (dropped 0 기준)", ["고치기 전 30/s · 처리량 35/s 에서 멈춤", "고친 뒤 120/s", "", "30/s p95 166.3ms → 39.0ms"], 15, 29);
panel(720, 380, 640, 270, C.blue, "폴백이 비쌌던 이유", ["모델 실패나 자리 없음 때 가는 규칙 행", "그 비용의 대부분이 이 개수 세기", "", "재사용한 메서드가 원래 비용까지 딸려 왔다"], 15, 29);
writeFileSync(process.argv[2], render(k));
