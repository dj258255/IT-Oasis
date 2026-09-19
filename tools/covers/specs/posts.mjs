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
];
