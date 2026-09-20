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
];
