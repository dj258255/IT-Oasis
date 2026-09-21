import { chain } from './_perf-chain.mjs';
// TTL 을 늘리면 hit rate 는 오르고 신선도는 떨어진다.
chain(process.argv[2], 'Cache TTL ↑',
  ['Hit Rate ↑', 'DB Load ↓'],
  ['Stale Data ↑', 'Memory Usage ↑', 'Invalidation Complexity ↑']);
