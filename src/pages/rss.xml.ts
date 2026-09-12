import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getStoryPosts } from '../lib/posts';

export async function GET(context: APIContext) {
  const posts = await getStoryPosts();

  return rss({
    title: 'Blog',
    description: '개발 블로그',
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: `/blog/${post.id}/`,
      categories: post.data.tags,
    })),
  });
}
