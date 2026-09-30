import { getCollection } from 'astro:content';
import { getPublishedPosts } from './posts';
import { hubDomains, OVERVIEW_ID } from '../data/be-commerce-hub';

const PREFIX = 'project/be-commerce/';

/**
 * BE-commerce 영역별 글 목록. 개요 글의 영역 지도와 영역별 글 목록이 함께 쓴다.
 *
 * 영역 매핑이 글과 어긋나면 빌드를 멈춘다. 새 글이 목록에서 조용히 빠지는 것을 막는다.
 * 초안·unlisted로 바뀐 글은 매핑에 남아 있어도 목록에서 빠진다.
 */
export async function getHubDomains() {
  const allIds = new Set((await getCollection('blog')).map((p) => p.id));
  const published = (await getPublishedPosts()).filter((p) => p.id.startsWith(PREFIX) && p.id !== OVERVIEW_ID);
  const publishedById = new Map(published.map((p) => [p.id, p]));

  const owner = new Map<string, string>();
  for (const domain of hubDomains) {
    for (const id of domain.posts) {
      if (!allIds.has(id)) throw new Error(`be-commerce 허브: 없는 글 id "${id}" (영역 ${domain.id})`);
      if (owner.has(id)) throw new Error(`be-commerce 허브: "${id}"가 ${owner.get(id)}와 ${domain.id} 두 영역에 있습니다`);
      owner.set(id, domain.id);
    }
  }
  const unmapped = published.filter((p) => !owner.has(p.id)).map((p) => p.id);
  if (unmapped.length > 0) {
    throw new Error(`be-commerce 허브: 영역이 정해지지 않은 공개 글 ${unmapped.join(', ')}. src/data/be-commerce-hub.ts에 추가하세요.`);
  }

  const domains = hubDomains.map((domain) => ({
    ...domain,
    entries: domain.posts
      .map((id) => publishedById.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .sort((a, b) => (a.data.seriesOrder ?? 999) - (b.data.seriesOrder ?? 999)),
  }));

  return {
    domains,
    tiles: domains.map((d) => ({ ...d, count: d.entries.length })),
    totalPosts: domains.reduce((n, d) => n + d.entries.length, 0),
  };
}
