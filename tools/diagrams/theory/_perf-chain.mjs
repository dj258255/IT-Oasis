import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';

/** 값을 하나 올렸을 때 얻는 것과 내는 것. gen- 접두사를 피해 빌드 대상에서 빠진다. */
export function chain(out, knob, gains, costs) {
  const k = canvas(1300, 290);

  box(k, 50, 105, 240, 80, { color: C.gray, r: 12 });
  text(k, 170, 153, knob, { size: 19, weight: 700, fill: C.gray.s });

  box(k, 380, 30, 880, 100, { color: C.green, r: 12 });
  text(k, 1240, 60, '얻는 것', { size: 14, weight: 700, fill: '#2b8a3e', anchor: 'end' });
  gains.forEach((g, i) => text(k, 404 + i * 290, 104, g, { size: 18, weight: 700, fill: C.green.s, anchor: 'start' }));

  box(k, 380, 156, 880, 100, { color: C.red, r: 12 });
  text(k, 1240, 186, '대가', { size: 14, weight: 700, fill: C.red.s, anchor: 'end' });
  costs.forEach((c, i) => text(k, 404 + i * 285, 230, c, { size: 17, weight: 700, fill: C.red.s, anchor: 'start' }));

  arrow(k, 296, 131, 374, 82, { color: '#adb5bd' });
  arrow(k, 296, 159, 374, 208, { color: '#adb5bd' });

  writeFileSync(out, render(k));
}
