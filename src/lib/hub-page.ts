/**
 * BE-commerce 개요 글의 영역 지도(HubMap)와 영역별 글(HubDomainList)을 잇는다.
 * 지도에서 영역을 고르면 아래 목록이 그 영역만 남고, 주소에 #영역 이 붙는다.
 */
import { initFlowMap } from './flow-map';

let controller: AbortController | null = null;

export function initHubPage() {
  const map = document.querySelector<HTMLElement>('[data-hub-map] [data-flow-map]');
  const list = document.getElementById('hub-list');
  if (!map || !list) return;
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;

  const sections = Array.from(list.querySelectorAll<HTMLElement>('[data-domain-section]'));
  const status = list.querySelector<HTMLElement>('[data-hub-status]')!;
  const reset = list.querySelector<HTMLButtonElement>('[data-hub-reset]')!;
  const erd = document.getElementById('hub-erd') as HTMLDetailsElement | null;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const initialStatus = status.textContent?.trim() ?? '';
  const isDomain = (id: string | null) => !!id && /^[a-z-]+$/.test(id) && !!map.querySelector(`[data-node="${id}"]`);
  let current: string | null = null;

  // 아래 목록을 고른 영역에 맞춘다. 지도 타일의 표시는 flow-map이 맡는다.
  // 주소는 영역을 고르거나 풀 때만 바꾼다. 본문 제목으로 가는 #해시는 건드리지 않는다.
  function show(id: string | null, { scroll = false, touchUrl = true } = {}) {
    const active = isDomain(id) ? id : null;
    const tile = active ? map!.querySelector<HTMLElement>(`[data-node="${active}"]`) : null;
    sections.forEach((s) => {
      s.hidden = active !== null && s.dataset.domainSection !== active;
    });
    reset.hidden = active === null;
    if (tile) {
      const name = tile.querySelector('.node-name')?.textContent ?? '';
      const count = tile.querySelector('.node-count')?.textContent?.trim() ?? '';
      status.textContent = `${name} 영역, ${count}`;
    } else {
      status.textContent = initialStatus;
    }
    if (touchUrl && (active || current)) {
      history.replaceState(null, '', active ? `#${active}` : location.pathname + location.search);
    }
    current = active;
    if (scroll) {
      const top = list!.getBoundingClientRect().top;
      if (top > window.innerHeight * 0.6 || top < 0) {
        list!.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
      }
    }
  }

  const flow = initFlowMap(map, {
    signal,
    allowDeselect: true,
    onSelect: (id) => show(id, { scroll: true }),
  });

  function pick(id: string | null, opts?: { scroll?: boolean }) {
    flow.select(id);
    show(flow.selected(), opts);
  }

  list.querySelectorAll<HTMLAnchorElement>('[data-domain-link]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      pick(a.dataset.domainLink!);
    }, { signal });
  });

  reset.addEventListener('click', () => pick(null), { signal });

  // 본문의 "핵심 ERD" 링크를 누르면 접힌 ERD를 펼친다.
  function openErdIfTargeted() {
    if (erd && location.hash === '#hub-erd') erd.open = true;
  }
  document.querySelectorAll<HTMLAnchorElement>('a[href="#hub-erd"]').forEach((a) => {
    a.addEventListener('click', () => { if (erd) erd.open = true; }, { signal });
  });
  openErdIfTargeted();

  // 다른 곳(예: 옛 허브 주소)에서 #영역 으로 들어오면 그 영역을 연다.
  const hash = decodeURIComponent(location.hash.slice(1));
  if (isDomain(hash)) pick(hash, { scroll: true });
}
