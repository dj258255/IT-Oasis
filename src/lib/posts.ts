import { getCollection } from 'astro:content';

/** Fetch all published (non-draft) blog posts, sorted by date descending. */
export async function getPublishedPosts() {
  return (await getCollection('blog'))
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}
