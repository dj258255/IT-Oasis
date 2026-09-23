/**
 * BE-commerce 프로젝트 허브(/projects/be-commerce)의 영역 정의.
 *
 * 영역은 저장소의 실제 모듈 경계를 따르고, 배치는 요청이 흐르는 순서를 따른다.
 * 글은 영역 하나에만 속한다. 공개된 be-commerce 글이 어느 영역에도 없으면 허브 페이지가
 * 빌드 단계에서 실패한다(src/pages/projects/be-commerce.astro).
 */

const REPO = 'https://github.com/dj258255/BE-commerce/blob/main';

export interface HubDomain {
  id: string;
  name: string;
  /** 타일에 쓰는 짧은 설명 */
  tagline: string;
  /** 목록 머리에 쓰는 설명 */
  summary: string;
  /** 저장소의 실제 패키지·영역 이름 */
  modules: string[];
  doc: { label: string; url: string };
  /** 공개 글 id (src/content/blog 기준, 확장자 없음). 순서는 seriesOrder로 다시 정렬한다. */
  posts: string[];
  /** 지도 격자 위치 (데스크톱 4열 × 2행) */
  col: number;
  row: number;
  core?: boolean;
}

const post = (slug: string) => `project/be-commerce/be-commerce-${slug}`;

export const OVERVIEW_ID = post('0-overview');

export const hubDomains: HubDomain[] = [
  {
    id: 'entry',
    name: '유입·인증',
    tagline: '로그인과 요청 제한',
    summary: '로그인, 사용자별·전역 요청 제한, 대기열로 몰려드는 요청을 먼저 받습니다. 비밀번호 해시 강도를 올릴 때 로그인 한 건의 메모리 비용이 얼마나 커지는지도 여기서 쟀습니다.',
    modules: ['auth', 'member', 'ratelimit', 'queue'],
    doc: { label: 'ADR-009 비밀번호 해시와 이관 경로', url: `${REPO}/docs/adr/ADR-009-password-hashing-and-migration-path.md` },
    posts: [post('ch6-auth-cost')],
    col: 1,
    row: 1,
  },
  {
    id: 'storefront',
    name: '스토어프론트',
    tagline: '탐색, 장바구니, 주문',
    summary: '홈, 카테고리, 검색, 상품 상세, 장바구니, 주문 화면이 결제와 같은 API 위에 있습니다. 결제 응답이 불확실하면 화면에도 그 상태를 그대로 드러내고 주문 조회로 확정합니다.',
    modules: ['home', 'order', 'wishlist'],
    doc: { label: '스토어프론트 설계', url: `${REPO}/docs/28-스토어프론트-설계.md` },
    posts: [],
    col: 2,
    row: 1,
  },
  {
    id: 'payment',
    name: '결제',
    tagline: '승인, 취소, 원장',
    summary: '승인과 취소, 원장, 지갑과 포인트, 에스크로를 처리합니다. PG 응답이 오지 않은 결제는 성공이나 실패로 확정하지 않고 UNKNOWN으로 남긴 뒤 조회로 복구합니다. 이 저장소의 코어입니다.',
    modules: ['payment', 'ledger', 'wallet', 'point', 'escrow', 'subscription'],
    doc: { label: '결제 도메인 핵심 개념', url: `${REPO}/docs/02-결제도메인-핵심개념.md` },
    posts: [post('ch21-cancel-row-overwrite'), post('ch22-parser-drops-refund'), post('ch17-db-rejected-it')],
    col: 3,
    row: 1,
    core: true,
  },
  {
    id: 'settlement',
    name: '정산·대사',
    tagline: '정산 집계와 대사',
    summary: '판매자별 정산금을 집계하고 PG 정산 파일과 내부 기록을 대조합니다. 규칙으로 가르지 못한 불일치는 사람이 확인하는 큐로 보내고, 큐가 방치되면 알림을 보냅니다.',
    modules: ['settlement', 'reconciliation'],
    doc: { label: '지급 대사 엔진과 외부 reference', url: `${REPO}/docs/38-지급-대사-엔진과-외부-reference.md` },
    posts: [post('ch8-reconciliation-judgement'), post('ch9-batch-ownership')],
    col: 4,
    row: 1,
  },
  {
    id: 'personalization',
    name: '개인화',
    tagline: '행동 로그로 홈 추천',
    summary: '클릭과 조회, 구매 로그를 모아 홈 추천을 구성합니다. 추론이 늦으면 인기 상품으로 물러서고, 학습한 모델은 기준선을 넘지 못해 넣지 않았습니다.',
    modules: ['personalization', 'recommendation', 'pipeline (Python)'],
    doc: { label: '개인화 아키텍처', url: `${REPO}/personalization/docs/01-architecture.md` },
    posts: [],
    col: 2,
    row: 2,
  },
  {
    id: 'risk',
    name: '리스크',
    tagline: '이상거래, 분쟁, 제재 대조',
    summary: '승인 전에 이상거래 점수를 매기고, 분쟁 대응 기한을 관리하고, 정산금을 내보내기 전에 제재 명단과 대조합니다.',
    modules: ['fraud', 'dispute', 'seller'],
    doc: { label: 'FDS 규칙별 오탐', url: `${REPO}/docs/26-FDS-규칙별-오탐.md` },
    posts: [post('ch16-no-hangul-on-the-list')],
    col: 3,
    row: 2,
  },
  {
    id: 'ai',
    name: 'AI 운영',
    tagline: '운영 판단을 돕는 모델',
    summary: '장애 분석, 대사 원인 후보, 운영 타임라인 서술에 모델을 붙였습니다. 모델보다 검증기를 먼저 만들고, 검증기가 허락하지 않는 자리에서는 모델을 껐습니다.',
    modules: ['assist', 'timeline', 'audit'],
    doc: { label: 'AI 운영 자동화 검토', url: `${REPO}/docs/11-AI-운영자동화-검토.md` },
    posts: [
      post('ch10-ruler-first'),
      post('ch11-ruler-fooled-me'),
      post('ch13-residual-cause'),
      post('ch14-when-the-ruler-says-yes'),
      post('ch23-receiver-decides-guards'),
    ],
    col: 4,
    row: 2,
  },
];

/** 지도 위의 선. 라벨은 두 영역 사이로 실제로 무엇이 건너가는지 적는다. */
export const hubEdges: { from: string; to: string; label: string }[] = [
  { from: 'entry', to: 'storefront', label: '인증된 요청' },
  { from: 'storefront', to: 'payment', label: '체크아웃 사가' },
  { from: 'payment', to: 'settlement', label: 'Outbox 이벤트' },
  { from: 'storefront', to: 'personalization', label: '행동 로그' },
  { from: 'payment', to: 'risk', label: '승인 전 점수' },
  { from: 'payment', to: 'ai', label: '운영 타임라인' },
];
