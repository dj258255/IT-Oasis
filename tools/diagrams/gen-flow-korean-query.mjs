import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 540);
text(k, 700, 46, "한국어 검색어를 라벨 사전으로 고친다", { size: 24, weight: 700 });
text(k, 700, 80, "상품 텍스트에 한글이 있는 상품 105,545개 중 3개 · 기본은 꺼 둔다", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "검색어", ["블랙스커트", "블랙 스커트", "pants"]);
panel(490, 120, 420, 220, C.blue, "고치기", ["한글만 남겨 라벨을 가장 길게 맞춘다", "색상 라벨 → 색상 필터", "중분류 라벨 → 원문 이름(Skirts)", "미국식 말에 영국식을 더한다"]);
panel(940, 120, 420, 220, C.green, "엔진에 넘기는 것", ["검색어 Skirts + 색상 Black", "", "pants trousers"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "결과 (0건 비율, 끔 → 켬)", ["중분류 한국어 90% → 10%", "색상 + 중분류 88 · 97% → 12%", "미국식 말 11% → 0%", "기존 545개 쿼리는 하나도 바뀌지 않았다"], 15, 29);
panel(720, 380, 640, 270, C.red, "기준(0건 5% 이하)을 못 넘었다", ["남은 0건은 '니트' · '기타'", "원문 이름이 부서명(Knitwear · Unknown)", "", "실제 검색 로그로 사전을 만들어 다시 잰다"], 15, 29);
writeFileSync(process.argv[2], render(k));
