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

function isProjectPost(post: BlogPost, projectCategories: Set<string>): boolean {
  return post.id.startsWith('project/') || projectCategories.has(post.data.category);
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
 * Project write-ups stay reachable from the Projects page, but do not appear in
 * the general Story feed, site search, category/tag listings, or RSS.
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
