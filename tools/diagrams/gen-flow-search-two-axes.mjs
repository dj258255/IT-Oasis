import { canvas, box, text, lines, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 600);

marker(k, 700, 46, 560);
text(k, 700, 46, '검색 엔진이 필요한가는 두 축으로 물어야 한다', { size: 26, weight: 700 });
text(k, 700, 80, '카탈로그 105,542행 · MySQL 8.4 · 로컬 단일 장비', { size: 15, fill: '#868e96' });

box(k, 40, 120, 640, 330, { color: C.green });
text(k, 360, 156, '지연 축: 재서 답을 냈다', { size: 20, weight: 700, fill: C.green.s });
lines(k, 360, 290, [
  '측정 전 기준 ① 목록 p95 300ms 초과 + 원인이 집계',
  '측정 전 기준 ② 패싯이 페이지 지연의 50% 이상',
  '',
  '② 발동: 패싯 몫 82.5% (동시성 1)',
  '① 미발동: 300ms를 넘긴 원인은 포화였다',
  '(필터 없는 목록도 같이 587ms)',
  '',
  '패싯 결과를 60초 캐시 → 패싯 p95 90.9 → 5.7ms · 몫 24.6%',
  '엔진을 검토할 조건이 사라졌다',
], { size: 14.5, gap: 25 });

box(k, 720, 120, 640, 330, { color: C.orange });
text(k, 1040, 156, '품질 축: 아직 재지 않았다', { size: 20, weight: 700, fill: C.orange.s });
lines(k, 1040, 290, [
  '지금 검색은 상품명·브랜드 부분 일치 (LIKE \'%검색어%\')',
  '',
  '관련도 순위가 없다',
  '어형 변화·오타·동의어를 다루지 못한다',
  '앞에 %가 붙어 B-Tree 인덱스를 못 탄다',
  '',
  'MySQL FULLTEXT도 관련도 점수는 내지만',
  '오타·어형·동의어는 분석기 선택지가 좁다',
], { size: 14.5, gap: 25 });

box(k, 40, 480, 1320, 90, { color: C.yellow });
lines(k, 700, 525, [
  '"지금 지연 때문에 넣을 이유는 없다"와 "검색 엔진이 필요 없다"는 다른 말이다',
  '다음 결정은 품질을 먼저 재고, 넣는다면 동기화 지연과 DB 폴백까지 함께 잰다',
], { size: 15.5, gap: 28, weight: 600 });
writeFileSync(process.argv[2], render(k));
