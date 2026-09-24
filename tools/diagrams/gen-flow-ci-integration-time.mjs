import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 590);
text(k, 700, 46, "통합 테스트 잡 18~35분 → 전부 3.2분", { size: 24, weight: 700 });
text(k, 700, 80, "GitHub Actions · Testcontainers MySQL·Redis · 기다리는 시간은 가장 긴 잡이 정한다", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "35분의 내역", ["MySQL 기동 25번 · 약 8.7분", "컨텍스트 기동 16번 · 약 6.3분", "테스트 17.2분 · 그중 측정 넷 14분"]);
panel(490, 120, 420, 220, C.blue, "한 일", ["측정 넷은 매일 새벽 3시로 · 9.9분", "컨테이너 한 번, 클래스마다 새 DB · 7.0분", "Modulith 로 바뀐 모듈만 · 골라 돌면 1.7분"]);
panel(940, 120, 420, 220, C.green, "지금", ["문서만 바뀐 PR 은 통합 테스트 없음", "코드 PR 은 바뀐 모듈과 기대는 모듈만", "종료 훅 60초 · 적재 2.5분도 걷어냄"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "Modulith 에서 걸린 것", ["1.3.1 은 판단 단계에서 10분 넘게 멈춤 → 1.3.12", "건너뛴 이유가 JUnit XML 에 없다 → 리스너로 기록", "테스트 도우미가 바뀌면 전부 돌린다"], 15, 29);
panel(720, 380, 640, 270, C.red, "닫은 개선", ["템플릿 DB 복사: 줄일 몫이 20초 남짓", "컨테이너 공유 뒤 마이그레이션은 번마다 1.3~1.6초", "잡 시간 편차(4.9~7.0분)에 묻힌다"], 15, 29);
writeFileSync(process.argv[2], render(k));
