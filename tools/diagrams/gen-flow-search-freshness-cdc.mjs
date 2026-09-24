import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 740);
text(k, 700, 46, "상품 변경이 검색에 보이기까지 10분에서 1.1초로", { size: 24, weight: 700 });
text(k, 700, 80, "상품 변경 600건 · 인스턴스 2개 · 30초 안에 반영되는지", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "상품 · 재고 변경", ["MySQL binlog", "", "Debezium이 읽어", "catalog.change 토픽으로", "(상품 id가 키)"]);
panel(490, 120, 420, 220, C.blue, "색인에 넣는다", ["id로 DB를 다시 읽는다", "", "Lucene: 인스턴스마다 모두 받음", "Elasticsearch: 색인기 하나가 받음"]);
panel(940, 120, 420, 220, C.green, "검색에 보인다", ["Lucene p95 1,122ms", "Elasticsearch p95 1,197ms", "", "30초 안에 못 한 변경 0/600"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.red, "이전: 10분마다 통째로 재색인", ["30초 안에 반영된 변경 0/60", "", "품절 상품이 '재고 있음' 결과에", "최대 10분 남는다"], 15, 29);
panel(720, 380, 640, 270, C.orange, "붙이며 드러난 결함", ["영어가 아닌 문자가 든 20건이 빠졌다 → UTF-8 바이트로", "거절된 문서 하나가 묶음 전체를 막았다", "처음 뜬 컨슈머가 토픽 전체를 다시 읽었다"], 15, 29);
writeFileSync(process.argv[2], render(k));
