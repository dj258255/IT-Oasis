import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { TOPIC_IDS } from './data/topics';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    category: z.string().default('일반'),
    /** 주제 한두 개. 앞의 것이 대표 주제다. 목록은 src/data/topics.ts */
    topics: z.array(z.enum(TOPIC_IDS)).max(2).default([]),
    coverImage: z.string().optional(),
    draft: z.boolean().default(false),
    /** Built and reachable by direct link, but hidden from all listings, search, RSS, and search engines. */
    unlisted: z.boolean().default(false),
    series: z.string().optional(),
    seriesOrder: z.number().optional(),
  }),
});

export const collections = { blog };
