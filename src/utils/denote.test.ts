import { describe, test, expect } from 'vitest';
import { denoteFilename, denoteIdentifier, denoteSlug, denoteSlugTag } from './denote';

describe('denoteIdentifier', () => {
	test('formats as YYYYMMDDTHHMMSS', () => {
		const d = new Date(2025, 0, 15, 9, 30, 45);
		expect(denoteIdentifier(d)).toBe('20250115T093045');
	});

	test('pads single-digit parts', () => {
		const d = new Date(2025, 0, 1, 1, 2, 3);
		expect(denoteIdentifier(d)).toBe('20250101T010203');
	});
});

describe('denoteSlug', () => {
	test('lowercases and kebab-cases', () => {
		expect(denoteSlug('Hello World')).toBe('hello-world');
	});

	test('removes ASCII punctuation without splitting words', () => {
		expect(denoteSlug("What's New? Yeah!")).toBe('whats-new-yeah');
	});

	test('handles C++ / C# style symbols', () => {
		expect(denoteSlug('C++ Tutorial: An Intro')).toBe('c-tutorial-an-intro');
	});

	test('strips typographic quotes and dashes', () => {
		expect(denoteSlug('“Smart” — quotes – test')).toBe('smart-quotes-test');
	});

	test('strips filesystem-unsafe characters', () => {
		expect(denoteSlug('a/b\\c')).toBe('abc');
	});

	test('collapses repeated separators', () => {
		expect(denoteSlug('a  b   c')).toBe('a-b-c');
	});

	test('strips leading and trailing separators', () => {
		expect(denoteSlug('---hello---')).toBe('hello');
	});

	test('removes diacritics', () => {
		expect(denoteSlug('Café Résumé')).toBe('cafe-resume');
	});

	test('preserves CJK letters', () => {
		expect(denoteSlug('测试 test')).toBe('测试-test');
	});

	test('preserves CJK-only titles', () => {
		expect(denoteSlug('你好世界')).toBe('你好世界');
	});

	test('keeps CJK punctuation, strips ASCII punctuation', () => {
		// Chinese question mark `？` is not in the ASCII excluded set so it stays.
		expect(denoteSlug('如何用 Emacs？一个介绍')).toBe('如何用-emacs？一个介绍');
	});

	test('strips ASCII colon even between CJK', () => {
		expect(denoteSlug('如何用 Emacs: 一个介绍')).toBe('如何用-emacs-一个介绍');
	});

	test('preserves Cyrillic letters', () => {
		expect(denoteSlug('Привет мир')).toBe('привет-мир');
	});

	test('empty input returns empty', () => {
		expect(denoteSlug('')).toBe('');
	});
});

describe('denoteSlugTag', () => {
	test('lowercases and removes non-alphanumeric', () => {
		expect(denoteSlugTag('My Tag')).toBe('mytag');
	});

	test('strips special chars', () => {
		expect(denoteSlugTag('a-b_c')).toBe('abc');
	});
});

describe('denoteFilename', () => {
	test('builds identifier+slug+ext', () => {
		const d = new Date(2025, 0, 15, 9, 30, 45);
		expect(denoteFilename({ title: 'Hello World', date: d }))
			.toBe('20250115T093045--hello-world.org');
	});

	test('adds tags with double-underscore separator', () => {
		const d = new Date(2025, 0, 15, 9, 30, 45);
		expect(denoteFilename({ title: 'Hello', tags: ['foo', 'bar'], date: d }))
			.toBe('20250115T093045--hello__foo_bar.org');
	});

	test('empty title produces identifier-only name', () => {
		const d = new Date(2025, 0, 15, 9, 30, 45);
		expect(denoteFilename({ title: '', date: d }))
			.toBe('20250115T093045.org');
	});

	test('custom extension', () => {
		const d = new Date(2025, 0, 15, 9, 30, 45);
		expect(denoteFilename({ title: 'x', date: d, extension: 'md' }))
			.toBe('20250115T093045--x.md');
	});

	test('filters empty tags', () => {
		const d = new Date(2025, 0, 15, 9, 30, 45);
		expect(denoteFilename({ title: 'x', tags: ['a', '', ' '], date: d }))
			.toBe('20250115T093045--x__a.org');
	});
});
