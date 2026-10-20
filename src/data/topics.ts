/**
 * 글의 주제 목록. 독자가 글을 찾는 길은 이 목록 하나로 만든다(스토리의 주제 줄, 글 머리의 주제 표시,
 * 태그 페이지 위쪽, /topics/<id> 목록).
 *
 * 자유롭게 붙이는 `tags`와 달리 여기 있는 것만 쓸 수 있다. 글 하나에 하나나 둘을 붙이고 앞의 것이 대표 주제다.
 * 글이 다섯 편이 안 될 주제는 만들지 않고 옆 주제에 넣는다.
 */
export const TOPICS = [
  { id: 'database', name: '데이터베이스' },
  { id: 'payments', name: '결제·정산' },
  { id: 'search', name: '검색·추천' },
  { id: 'performance', name: '성능·용량' },
  { id: 'distributed', name: '동시성·분산' },
  { id: 'systems', name: '운영체제·런타임' },
  { id: 'messaging', name: '이벤트·메시징' },
  { id: 'pipeline', name: '데이터 파이프라인' },
  { id: 'cert', name: '자격증 공부' },
  { id: 'ai', name: 'AI 개발' },
  { id: 'testing', name: '테스트·검증' },
  { id: 'projects', name: '프로젝트·회고' },
] as const;

export type TopicId = (typeof TOPICS)[number]['id'];

export const TOPIC_IDS = TOPICS.map((t) => t.id) as [TopicId, ...TopicId[]];

const NAMES = new Map<string, string>(TOPICS.map((t) => [t.id, t.name]));

export function topicName(id: string): string {
  return NAMES.get(id) || id;
}
