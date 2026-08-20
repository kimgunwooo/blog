import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const createdAt = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
		'createdAt must use an ISO 8601 timestamp with seconds and timezone, for example 2026-08-20T21:04:28+09:00',
	)
	.transform((value) => new Date(value));

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			category: z.string().default('General'),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			createdAt,
			updatedDate: z.coerce.date().optional(),
			showTime: z.boolean().default(false),
			heroImage: z.optional(image()),
			tags: z.array(z.string()).default([]),
		}),
});

export const collections = { blog };
