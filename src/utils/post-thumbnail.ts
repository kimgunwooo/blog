import type { CollectionEntry } from 'astro:content';

type BlogPost = CollectionEntry<'blog'>;

export function getPostThumbnail(post: BlogPost): string | undefined {
	const heroImage = post.data.heroImage;
	if (heroImage) {
		return typeof heroImage === 'string' ? heroImage : heroImage.src;
	}

	const body = post.body ?? '';
	const markdownImage = body.match(/!\[[^\]]*\]\(\s*<?([^\s)>]+)[^)]*\)/);
	if (markdownImage?.[1]) return markdownImage[1];

	const htmlImage = body.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
	return htmlImage?.[1];
}
