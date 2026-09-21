import { chain } from './_perf-chain.mjs';
// Batch Size 를 올리면 얻는 것과 내는 것.
chain(process.argv[2], 'Batch Size ↑',
  ['Throughput ↑', 'Efficiency ↑'],
  ['Waiting Time ↑ 가능', 'Latency ↑ 가능', 'Memory Usage ↑ 가능']);
