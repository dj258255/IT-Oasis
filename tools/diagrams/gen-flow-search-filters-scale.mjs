import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 565);
text(k, 700, 46, "검색어와 필터는 엔진 안에서 함께 건다", { size: 24, weight: 700 });
text(k, 700, 80, "H&M 카탈로그 · 필터 쿼리 171개 · 동시성 10 · 지연 예산 p95 100ms", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.blue, "Lucene 안에서 건다", ["점수에 끼지 않는 필터 절", "문서값으로 패싯을 센다", "", "정답과 같은 쿼리 171/171", "p95 37ms"]);
panel(490, 120, 420, 220, C.red, "상위 500개를 DB에서 거른다", ["엔진 상위 500개만 받아", "DB에서 다시 거르고 센다", "", "정답과 같은 쿼리 19/171", "결과 수 95.5%를 잃었다"]);
panel(940, 120, 420, 220, C.gray, "Elasticsearch 안에서 건다", ["filter 절과 집계", "", "정답과 같은 쿼리 171/171", "p95 39ms"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "앱 안 Lucene이 버티는 규모", ["복제 카탈로그로 늘려 가며 쟀다", "", "100만 건 · p95 86ms (예산 안, 여유 14ms)", "300만 건 · p95 232ms (예산 초과)"], 15, 29);
panel(720, 380, 640, 270, C.green, "결정", ["필터와 패싯은 엔진 안에서 (기본)", "엔진이 실패하면 후보 자르기로 물러선다", "", "앱 안 Lucene은 100만 건까지", "옮긴다면 샤드를 나눈 클러스터"], 15, 29);
writeFileSync(process.argv[2], render(k));
