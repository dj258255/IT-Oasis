import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';
import { projects } from '../data/projects';

type BlogPost = CollectionEntry<'blog'>;

function projectStoryId(story: string): string {
  return story.replace(/^\/blog\//, '').replace(/\/$/, '');
}

function getProjectCategories(posts: BlogPost[]): Set<string> {
  const storyIds = new Set(
    projects
      .map((project) => project.story)
      .filter(Boolean)
      .map(projectStoryId),
  );

  return new Set(
    posts
      .filter((post) => storyIds.has(post.id))
      .map((post) => post.data.category),
  );
}

/**
 * 학습 프로젝트는 카테고리 최상위 이름으로 알아본다. 프로젝트 카드가 있는 학습 프로젝트는
 * 카드의 story 카테고리로도 걸러지지만, 카드가 없는 것(토이 Kafka, 분산 시스템)은 그렇지 않아
 * 스토리 피드와 카테고리 목록에 "학습 프로젝트"가 남았다. 카드 유무와 무관하게 묶는다.
 */
const STUDY_NAMESPACE = 'study';

function isStudyPost(post: BlogPost): boolean {
  return (post.data.category || '').split('/')[0] === STUDY_NAMESPACE;
}

function isProjectPost(post: BlogPost, projectCategories: Set<string>): boolean {
  return post.id.startsWith('project/') || isStudyPost(post) || projectCategories.has(post.data.category);
}

/**
 * All buildable posts (everything except drafts), sorted by date descending.
 * Use this for `getStaticPaths` so unlisted posts still get a page to link to.
 */
export async function getBuildablePosts() {
  return (await getCollection('blog'))
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

/**
 * Publicly listed posts (non-draft AND non-unlisted), sorted by date descending.
 * Use this for every listing, search index, RSS feed, and related-post computation.
 */
export async function getPublishedPosts() {
  return (await getBuildablePosts()).filter((p) => !p.data.unlisted);
}

/**
 * Project write-ups and study projects stay reachable from the Projects page, but do not
 * appear in the general Story feed, site search, category/tag listings, or RSS.
 */
export async function getStoryPosts() {
  const posts = await getPublishedPosts();
  const projectCategories = getProjectCategories(posts);
  return posts.filter((post) => !isProjectPost(post, projectCategories));
}

/** Project write-ups that can be surfaced after entering through a project. */
export async function getProjectPosts() {
  const posts = await getPublishedPosts();
  const projectCategories = getProjectCategories(posts);
  return posts.filter((post) => isProjectPost(post, projectCategories));
}
