/**
 * 파일럿 6편의 커버 스펙.
 *
 * - id      : 글 id 와 1:1. 출력 경로도 이 값을 그대로 쓴다.
 * - title   : 글의 주장을 1~2줄로. 글 제목을 그대로 복사하지 않는다(카드가 이미 제목을 보여준다).
 * - thesis  : 근거 한 줄. 숫자가 있으면 숫자를 박는다.
 * - previous: 교체 전 커버. contact sheet 에서 나란히 비교하는 데만 쓴다.
 * - labels  : 모티프가 읽는 라벨. 모티프를 재사용하려면 라벨만 바꾸면 된다.
 */
export const pilot = [
  {
    id: 'project/pay/pay-ch17-db-rejected-it',
    kicker: '결제 시스템 만들기 · 17',
    title: ['테스트는 초록불이었는데', 'DB가 그 값을 거부했다'],
    thesis: '코드와 스키마가 조용히 어긋나 있던 두 자리',
    layout: 'two-cards',
    motif: 'schema-mismatch',
    accent: 'red',
    note: '한 번도 실행되지 않은 경로',
    previous: '/uploads/project/pay/thumbs/pay-ch17-db-rejected-it.svg',
    labels: {
      left: {
        title: '단위 테스트 (H2)',
        rows: ['enum 을 강제하지 않는다', '값이 뭐든 들어간다', '그래서 초록불'],
      },
      right: {
        title: 'MySQL 8.4 ENUM',
        rows: ['PAYOUT_HELD 가 없다', 'CASH · PG_FEE 가 없다', '그래서 값을 거부한다'],
      },
    },
  },
  {
    id: 'project/WikiEngine/cdc',
    kicker: 'WikiEngine · CDC',
    title: ['DB에 쓴 것을', '읽기 모델이 따라오게'],
    thesis: 'dual-write 직접 호출을 binlog 캡처로 바꿨다',
    layout: 'bottom-band',
    motif: 'cdc-pipeline',
    accent: 'blue',
    note: '쓰기 5,315ms → 33ms',
    previous: '/uploads/project/WikiEngine/cdc/phase14-cdc-k6-overview.png',
    labels: {
      stages: [
        { t: 'PostService', s: '쓰기', c: 'gray' },
        { t: 'binlog', s: '모든 변경', c: 'blue' },
        { t: 'Debezium', s: '캡처', c: 'purple' },
        { t: 'Kafka', s: '토픽', c: 'orange' },
        { t: 'Lucene · 캐시', s: '읽기 모델', c: 'green' },
      ],
      caption: 'dual-write 를 걷어내면 불일치도 사라진다',
    },
  },
  {
    id: 'ai/ai-guardrails-before-codegen',
    kicker: 'AI 검증',
    title: ['충분성을 기계가 판정하게', '만들려던 것이 잘못이었다'],
    thesis: '가르는 기준은 비용과 일관성이다',
    layout: 'bottom-band',
    motif: 'pipeline-roles',
    accent: 'purple',
    note: '자기 출력을 스스로 평가하면 편향된다',
    previous: '/uploads/banners/default-post-cover.png',
    labels: {
      roles: [
        { tag: '고정', t: '경계', rows: ['AI가 실수해도', '사고가 안 나는 자리'], c: 'green' },
        { tag: '고정', t: '구조 검사', rows: ['답이 하나인 검사', 'ArchUnit'], c: 'green' },
        { tag: '위임', t: '판단 재료', rows: ['규칙 대신', '근거를 준다'], c: 'blue' },
        { tag: '예외', t: '자기 심판', rows: ['자기 출력은', '스스로 못 매긴다'], c: 'red' },
      ],
    },
  },
  {
    id: 'project/db-hobby/db-internals-02-btree-index',
    kicker: '미니 DB로 이해하는 DB 내부 · 2',
    title: ['인덱스가 빠른 건', '디스크 때문이다'],
    thesis: '노드 하나에 키를 수백 개 담는 이유',
    layout: 'right-diagram',
    motif: 'btree',
    accent: 'green',
    note: '1천 행 11배 · 10만 행 416배',
    previous: '/uploads/project/db-hobby/cover.svg',
    labels: {
      root: '40 · 71',
      internal: ['12 · 33', '88 · 95'],
      leaf: ['3 · 8', '31 · 42', '77 · 91'],
      caption: '루트에서 리프로, 노드 하나가 곧 페이지다',
    },
  },
  {
    id: 'theory/db-connection-pool',
    kicker: 'Database',
    title: ['커넥션은 비싸서', '풀에 담아 다시 쓴다'],
    thesis: '매 요청마다 TCP 연결과 인증을 다시 하던 비용',
    layout: 'right-diagram',
    motif: 'pool-saturation',
    accent: 'blue',
    note: 'HikariCP: (코어 수 × 2) + 스핀들 수',
    previous: '/uploads/theory/db-connection-pool/cost.svg',
    labels: {
      thread: '스레드',
      pool: '커넥션 풀',
      slot: '커넥션 재사용',
      caption: '풀 크기를 정하는 것은 코어 수다',
    },
  },
  {
    id: 'hobby/kernel-hobby-09-tcp',
    kicker: 'C로 만드는 토이 커널 · 10',
    title: ['신뢰성은', '번호 매기기에서 온다'],
    thesis: '못 믿을 IP 위에 seq 와 ack 로 바이트 스트림을 세운다',
    layout: 'bottom-band',
    motif: 'tcp-handshake',
    accent: 'orange',
    note: '재전송 · 혼잡 제어 · 윈도우는 빼놓았다',
    previous: '/uploads/hobby/kernel-hobby-c/cover.svg',
    labels: {
      left: '클라이언트',
      right: '서버',
      steps: [
        { t: 'SYN', d: 'seq = x', c: 'blue' },
        { t: 'SYN · ACK', d: 'seq = y, ack = x + 1', c: 'purple' },
        { t: 'ACK', d: 'ack = y + 1', c: 'green' },
      ],
    },
  },
];
