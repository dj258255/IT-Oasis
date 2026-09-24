import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 615);
text(k, 700, 46, "점수가 같은 상품의 순서가 결과를 흔들었다", { size: 24, weight: 700 });
text(k, 700, 80, "이름이 같은 색상 변형이 많다 · 10위 자리 동점 무리가 상위 50개 중 중앙값 45개", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "동점을 내부 문서 순서로", ["문서 번호는 색인 절차와", "갈아 끼운 이력이 정한다", "", "가격만 바꿔도 순서가 바뀐다"]);
panel(490, 120, 420, 220, C.red, "쪽을 넘기는 사이", ["결과 상품의 가격을 초당 20건 변경", "스냅숏 3,000개 중", "중복 88 · 누락 888"]);
panel(940, 120, 420, 220, C.green, "동점을 상품 id로 끊는다", ["점수 내림차순, 같으면 id 오름차순", "", "중복 0 · 누락 9", "p95 변화 없음"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "같은 원인: 두 엔진의 차이", ["Elasticsearch와 OpenSearch 상위 10개 겹침 0.799", "다른 197개 쿼리 중 점수가 다른 것 0개", "적재 중 refresh가 세그먼트 순서를 갈랐다", "동점 정렬 뒤 545개 쿼리 모두 1.000"], 15, 29);
panel(720, 380, 640, 270, C.blue, "남은 것", ["누락 9건은 동점이 아니다", "지운 옛 판이 병합 전까지 IDF에 남는다", "", "새 상품이 위로 끼어드는 것은 오프셋의 한계"], 15, 29);
writeFileSync(process.argv[2], render(k));
