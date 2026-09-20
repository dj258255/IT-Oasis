/**
 * 파일럿 이후에 추가한 글의 커버 스펙.
 * 파일럿(specs/pilot.mjs)과 형식이 같고, build/check/contact-sheet 가 둘을 합쳐서 돈다.
 */
export const posts = [
  {
    id: 'project/pay/pay-ch19-virtual-account-reversal',
    kicker: '결제 시스템 만들기 · 가상계좌',
    title: ['결제 완료는', '최종 상태가 아니었다'],
    thesis: '만료는 웹훅으로 오지 않는다. 완료는 되돌아온다.',
    layout: 'right-diagram',
    motif: 'state-reversal',
    accent: 'red',
    note: 'EXPIRED 웹훅 미전송 · 신한 DONE 역전',
    previous: '/uploads/project/pay/thumbs/pay-failure.svg',
    labels: {
      states: ['발급', '입금 대기', '완료'],
      back: '역전이',
      caption: '완료를 최종이라고 가정하면 안 된다',
    },
  },
  {
    id: 'project/pay/pay-ch20-fds-block-ignored',
    kicker: '결제 시스템 만들기 · 이상거래 탐지',
    title: ['BLOCK을 반환했는데', '결제가 계속 승인되고 있었다'],
    thesis: '지연이 이유가 아니라는 것을 재고도 켜지 않았다',
    layout: 'right-diagram',
    motif: 'block-ignored',
    accent: 'red',
    note: '판정 p99 1.92ms · 승인 종단의 1.8%',
    previous: '/uploads/banners/default-post-cover.png',
    labels: {
      request: '결제 요청',
      approve: '승인',
      path: '승인 경로',
      judge: '판정 엔진 · BLOCK',
      note: '이 선이 없다',
      caption: '판정이 나와도 결제를 세우지 않는다',
    },
  },
  {
    id: 'project/pay/pay-ch21-cancel-row-overwrite',
    kicker: '결제 시스템 만들기 · 대사',
    title: ['부분취소가 오자', '이미 끝난 판정의 근거가 바뀌었다'],
    thesis: '현재 상태를 담는 자리에 사건 이력을 덮어썼다',
    layout: 'two-cards',
    motif: 'overwrite-append',
    accent: 'red',
    note: '승인 10,000 → 7,000 덮어씀 · 확정 판정과 갈라짐',
    previous: '/uploads/banners/default-post-cover.png',
    labels: {
      before: {
        title: '덮어쓰면',
        rows: ['승인 행 10,000 → 7,000', '취소 기록 없음', '확정 판정과 갈라진다'],
      },
      after: {
        title: '따로 쌓으면',
        rows: ['승인 10,000 (seq 0)', '취소 −3,000 (seq 1)', '판정과 일치가 유지된다'],
      },
    },
  },
  {
    id: 'project/pay/pay-ch22-parser-drops-refund',
    kicker: '결제 시스템 만들기 · 정산 파서',
    title: ['환불을 음수 행으로 바꿨는데', '파서는 음수를 버리고 있었다'],
    thesis: '공유하는 계약을 바꿨으면 한쪽만 검증하면 안 된다',
    layout: 'right-diagram',
    motif: 'dropped-row',
    accent: 'red',
    note: '정상 환불이 매번 불일치로 쌓였다',
    previous: '/uploads/banners/default-post-cover.png',
    labels: {
      rows: ['승인 +10,000', '환불 −3,000', '다음 거래일 행'],
      note: '파싱된 행 1 · 건너뛴 행 1',
      caption: '버린 행이 아니라 음수 행이었다',
    },
  },
];
