/**
 * BE-commerce 글 상단 목록(HubSeriesNav)의 수조 기포.
 * tsParticles는 목록이 화면 가까이 올 때 한 번만 불러온다. 글을 여는 것만으로 받는 스크립트가
 * 늘지 않게 하려는 것이다. 움직임 줄이기 설정이면 아무것도 띄우지 않는다.
 */

type Destroyable = { destroy(): void } | undefined;

let engineReady: Promise<typeof import('@tsparticles/engine')> | null = null;

function loadEngine() {
  engineReady ??= (async () => {
    const [engine, slim] = await Promise.all([import('@tsparticles/engine'), import('@tsparticles/slim')]);
    await slim.loadSlim(engine.tsParticles);
    return engine;
  })();
  return engineReady;
}

function bubbleOptions(dark: boolean) {
  const tint = dark ? '#bfe6ff' : '#4a9fcf';
  return {
    fullScreen: { enable: false },
    background: { color: 'transparent' },
    detectRetina: true,
    fpsLimit: 60,
    pauseOnOutsideViewport: true,
    particles: {
      number: { value: 34, density: { enable: false } },
      shape: { type: 'circle' },
      paint: {
        fill: { enable: true, color: { value: tint }, opacity: { min: 0.05, max: 0.16 } },
        stroke: { width: 1, color: { value: tint }, opacity: { min: 0.35, max: 0.7 } },
      },
      size: { value: { min: 1.5, max: 5.5 } },
      move: {
        enable: true,
        direction: 'top',
        speed: { min: 0.3, max: 1.1 },
        drift: { min: -0.25, max: 0.25 },
        straight: false,
        outModes: { default: 'out' },
      },
    },
    interactivity: {
      // 캔버스는 글 목록 뒤에 깔려 있어 마우스는 수조(부모)에서 받는다.
      detectsOn: 'parent',
      events: { onHover: { enable: true, mode: 'repulse' } },
      modes: { repulse: { distance: 70, speed: 0.4 } },
    },
  };
}

export function startBubbles(host: HTMLElement, signal: AbortSignal) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceMotion.matches) return;

  let container: Destroyable;
  let started = false;
  const isDark = () => document.documentElement.classList.contains('dark');
  let lastDark = isDark();

  async function mount() {
    const { tsParticles } = await loadEngine();
    if (signal.aborted) return;
    container?.destroy();
    lastDark = isDark();
    container = (await tsParticles.load({ element: host, options: bubbleOptions(lastDark) as never })) as Destroyable;
    if (signal.aborted) container?.destroy();
  }

  // 목록이 화면 가까이 왔을 때 처음 불러온다.
  const io = new IntersectionObserver((entries) => {
    if (!started && entries.some((e) => e.isIntersecting)) {
      started = true;
      io.disconnect();
      void mount();
    }
  }, { rootMargin: '200px' });
  io.observe(host);

  // 테마를 바꾸면 기포 색도 바꾼다. <html> class는 언어 전환 때도 바뀌어 다크 여부만 본다.
  const mo = new MutationObserver(() => { if (started && isDark() !== lastDark) void mount(); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  signal.addEventListener('abort', () => {
    io.disconnect();
    mo.disconnect();
    container?.destroy();
  });
}
