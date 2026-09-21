import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// HIT는 DB까지 가지 않고, MISS만 DB로 간다.
const k = canvas(1200, 380);

box(k, 60, 150, 160, 72, { color: C.gray });
text(k, 140, 192, '요청', { size: 18, weight: 700 });

box(k, 300, 150, 180, 72, { color: C.blue });
text(k, 390, 192, 'Redis', { size: 18, weight: 700, fill: C.blue.s });

box(k, 900, 60, 240, 68, { color: C.green });
text(k, 1020, 102, '응답 (HIT)', { size: 17, weight: 700, fill: C.green.s });

box(k, 620, 250, 170, 68, { color: C.orange });
text(k, 705, 292, 'DB', { size: 18, weight: 700, fill: C.orange.s });

box(k, 900, 250, 240, 68, { color: C.red });
text(k, 1020, 292, '응답 (MISS)', { size: 17, weight: 700, fill: C.red.s });

arrow(k, 224, 186, 294, 186, { color: '#adb5bd' });
arrow(k, 484, 158, 894, 100, { color: C.green.s });
arrow(k, 420, 226, 616, 278, { color: C.orange.s });
arrow(k, 794, 284, 894, 284, { color: '#adb5bd' });

text(k, 600, 120, 'HIT', { size: 16, weight: 700, fill: C.green.s });
text(k, 500, 268, 'MISS', { size: 16, weight: 700, fill: C.orange.s });

writeFileSync(process.argv[2], render(k));
