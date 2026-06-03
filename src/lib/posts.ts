import { getCollection } from 'astro:content';

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
