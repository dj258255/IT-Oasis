/**
 * 영역 흐름 지도(src/components/FlowMap.astro)의 동작.
 * 허브 페이지와 글 상단 시리즈 목록이 같은 지도를 쓰고, 고른 뒤에 무엇을 할지만 각자 정한다.
 */

type Edge = { from: string; to: string; label: string };
type Point = [number, number];

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface FlowMapOptions {
  /** 이미 고른 타일을 다시 누르면 선택을 푼다(허브). 시리즈 목록은 늘 하나가 열려 있다. */
  allowDeselect?: boolean;
  /** 사람이 타일을 눌러 선택이 바뀌었을 때만 부른다. */
  onSelect?: (id: string | null) => void;
  signal: AbortSignal;
}

export interface FlowMapHandle {
  select(id: string | null): void;
  selected(): string | null;
}

export function initFlowMap(map: HTMLElement, options: FlowMapOptions): FlowMapHandle {
  const { signal, allowDeselect = false, onSelect } = options;
  const svg = map.querySelector<SVGSVGElement>('[data-flow-lines]')!;
  const dot = map.querySelector<HTMLElement>('[data-flow-dot]')!;
  const nodes = new Map(
    Array.from(map.querySelectorAll<HTMLButtonElement>('[data-node]')).map((el) => [el.dataset.node!, el]),
  );
  const edges: Edge[] = JSON.parse(map.dataset.edges || '[]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // 유입(선이 들어오지 않는 타일)에서 각 타일까지의 길을 선에서 구한다.
  const routes = new Map<string, string[]>();
  const targets = new Set(edges.map((e) => e.to));
  const start = [...nodes.keys()].find((id) => !targets.has(id) && edges.some((e) => e.from === id));
  if (start) {
    routes.set(start, [start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of edges.filter((x) => x.from === cur)) {
        if (!routes.has(e.to)) {
          routes.set(e.to, [...routes.get(cur)!, e.to]);
          queue.push(e.to);
        }
      }
    }
  }

  let active: string | null = map.querySelector<HTMLElement>('[data-node].is-active')?.dataset.node ?? null;
  let hovered: string | null = null;

  // offset* 값을 쓴다. getBoundingClientRect는 확대된 타일의 크기를 돌려줘 줄 판정이 틀어진다.
  function segment(fromId: string, toId: string): Point[] {
    const a = nodes.get(fromId)!, b = nodes.get(toId)!;
    const ax = a.offsetLeft, ay = a.offsetTop, bx = b.offsetLeft, by = b.offsetTop;
    const aCx = ax + a.offsetWidth / 2, bCx = bx + b.offsetWidth / 2;
    if (Math.abs(ay - by) < 4) {
      const y = ay + a.offsetHeight / 2;
      return [[ax + a.offsetWidth, y], [bx, y]];
    }
    const startY = ay + a.offsetHeight;
    if (Math.abs(aCx - bCx) < 4) return [[aCx, startY], [bCx, by]];
    const midY = (startY + by) / 2;
    return [[aCx, startY], [aCx, midY], [bCx, midY], [bCx, by]];
  }

  const toPath = (pts: Point[]) =>
    pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

  function draw() {
    svg.setAttribute('viewBox', `0 0 ${map.clientWidth} ${map.clientHeight}`);
    svg.innerHTML = edges
      .map((e) => {
        const pts = segment(e.from, e.to);
        // 라벨은 가장 긴 구간의 가운데에 둔다. 세로 선 라벨은 선 왼쪽에 둬서
        // 같은 타일에서 오른쪽으로 꺾여 나가는 선과 겹치지 않게 한다.
        let best = 0, lx = 0, ly = 0;
        for (let i = 1; i < pts.length; i++) {
          const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          if (len > best) {
            best = len;
            lx = (pts[i][0] + pts[i - 1][0]) / 2;
            ly = (pts[i][1] + pts[i - 1][1]) / 2;
          }
        }
        const vertical = pts.length === 2 && pts[0][0] === pts[1][0];
        return `<g class="edge" data-edge="${esc(e.from)}>${esc(e.to)}">
          <path d="${toPath(pts)}" />
          <text x="${vertical ? lx - 8 : lx}" y="${vertical ? ly + 4 : ly - 8}" text-anchor="${vertical ? 'end' : 'middle'}">${esc(e.label)}</text>
        </g>`;
      })
      .join('');
    light(hovered ?? active);
  }

  function light(id: string | null) {
    const route = id ? routes.get(id) ?? [] : [];
    const pairs = new Set(route.slice(1).map((to, i) => `${route[i]}>${to}`));
    svg.querySelectorAll<SVGGElement>('[data-edge]').forEach((g) => {
      g.classList.toggle('is-lit', pairs.has(g.dataset.edge!));
    });
    nodes.forEach((el, key) => el.classList.toggle('is-on-route', route.includes(key) && key !== id));
  }

  function run(id: string) {
    const route = routes.get(id);
    if (!route || route.length < 2 || reduceMotion.matches) {
      dot.classList.remove('is-running');
      return;
    }
    const pts: Point[] = [];
    for (let i = 1; i < route.length; i++) pts.push(...segment(route[i - 1], route[i]));
    dot.style.offsetPath = `path('${toPath(pts)}')`;
    dot.classList.remove('is-running');
    void dot.offsetWidth; // 애니메이션을 처음부터 다시 시작한다
    dot.classList.add('is-running');
  }

  function select(id: string | null) {
    active = id && nodes.has(id) ? id : null;
    nodes.forEach((el, key) => {
      const on = key === active;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-pressed', String(on));
    });
    light(hovered ?? active);
  }

  nodes.forEach((el, id) => {
    el.addEventListener('mouseenter', () => { hovered = id; light(id); run(id); }, { signal });
    el.addEventListener('mouseleave', () => { hovered = null; light(active); }, { signal });
    el.addEventListener('focus', () => { light(id); run(id); }, { signal });
    el.addEventListener('blur', () => light(active), { signal });
    el.addEventListener('click', () => {
      const next = allowDeselect && active === id ? null : id;
      select(next);
      run(id);
      onSelect?.(next);
    }, { signal });
  });

  const ro = new ResizeObserver(() => draw());
  ro.observe(map);
  signal.addEventListener('abort', () => ro.disconnect());
  draw();

  return { select, selected: () => active };
}
