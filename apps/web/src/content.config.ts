/** Page copy (PRD §15): `src/content/{am,en}/<page>.md`. */
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const pages = defineCollection({
  loader: glob({ pattern: '{am,en}/*.md', base: './src/content' }),
  schema: z.object({
    title: z.string().max(70),
    description: z.string().max(170),
    heading: z.string(),
    lead: z.string(),
    faqs: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
  }),
});

export const collections = { pages };
