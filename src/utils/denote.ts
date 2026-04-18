/**
 * Denote-style file naming.
 *
 * Format: IDENTIFIER--TITLE__TAG1_TAG2.org
 *   - IDENTIFIER: YYYYMMDDTHHMMSS (local time)
 *   - TITLE: kebab-case, lowercase, ASCII-only
 *   - TAGS: optional, each lowercase alphanumeric
 *
 * Reference: https://protesilaos.com/emacs/denote
 */

export interface DenoteOptions {
	title: string;
	tags?: string[];
	date?: Date;
	extension?: string;
}

/**
 * Build a Denote-style filename.
 */
export function denoteFilename(opts: DenoteOptions): string {
	const date = opts.date ?? new Date();
	const ext = opts.extension ?? 'org';
	const identifier = denoteIdentifier(date);
	const slug = denoteSlug(opts.title);
	const tags = (opts.tags ?? []).map(denoteSlugTag).filter(Boolean);

	let name = identifier;
	if (slug) name += `--${slug}`;
	if (tags.length > 0) name += `__${tags.join('_')}`;
	return `${name}.${ext}`;
}

/**
 * Build the Denote identifier from a date: YYYYMMDDTHHMMSS (local time).
 */
export function denoteIdentifier(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		date.getFullYear().toString() +
		pad(date.getMonth() + 1) +
		pad(date.getDate()) +
		'T' +
		pad(date.getHours()) +
		pad(date.getMinutes()) +
		pad(date.getSeconds())
	);
}

/**
 * ASCII punctuation that Denote strips from titles (replaced with empty
 * string, not a hyphen). Mirrors `denote-excluded-punctuation-regexp` in
 * Denote.el. Non-ASCII punctuation (e.g. CJK 。，！？：「」) is preserved.
 */
const DENOTE_EXCLUDED_PUNCT = /[\][{}!@#$%^&*()+'\\",.?;:/|<>~`‘’“”–—]/g;

/**
 * Filesystem-unsafe or reserved characters that must always be removed,
 * regardless of whether they are ASCII or not (e.g. NUL, CJK `／`).
 */
const FS_UNSAFE = /[\0/\\]/g;

/**
 * Characters reserved by the Denote filename grammar. They cannot appear
 * in a title slug because they would be confused with the field separators.
 */
const DENOTE_RESERVED = /[=@]/g;

/**
 * Slugify a title for the Denote TITLE field.
 *
 * Preserves Unicode letters, digits, and non-ASCII punctuation while
 * stripping ASCII punctuation and Latin diacritics. Whitespace and
 * underscores are folded into hyphens. Matches Denote.el's default
 * sluggification so round-tripping through Emacs stays stable.
 *
 * Examples:
 *   "What's up?"                -> "whats-up"
 *   "C++ Tutorial: An Intro"    -> "c-tutorial-an-intro"
 *   "Café Résumé"               -> "cafe-resume"
 *   "如何用 Emacs：一个介绍"       -> "如何用-emacs：一个介绍"
 */
export function denoteSlug(input: string): string {
	// NFD (not NFKD) so fullwidth CJK punctuation like `？` `：` are preserved
	// but Latin diacritics still decompose for stripping below.
	return (input || '')
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.replace(FS_UNSAFE, '')
		.replace(DENOTE_RESERVED, '')
		.replace(DENOTE_EXCLUDED_PUNCT, '')
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Slugify a tag: lowercase, Unicode letters/digits only, no separators.
 * (Tags are stricter than titles — they must not contain punctuation that
 * would collide with the `_` / `-` separators.)
 */
export function denoteSlugTag(input: string): string {
	return (input || '')
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '');
}
