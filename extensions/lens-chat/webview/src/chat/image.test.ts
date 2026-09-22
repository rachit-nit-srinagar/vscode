import { describe, expect, it } from 'vitest';
import {
	clampZoom,
	filenameFromSrc,
	isImagePart,
	isImageSrc,
	nextZoom,
	ZOOM_DEFAULT,
	ZOOM_MAX,
	ZOOM_MIN,
} from './image';

describe('isImagePart', () => {
	it('treats image mime types as images', () => {
		expect(isImagePart({ mime: 'image/png', url: 'vscode-resource://file' })).toBe(true);
		expect(isImagePart({ mime: 'IMAGE/JPEG' })).toBe(true);
	});

	it('treats image filenames and srcs as images even without mime', () => {
		expect(isImagePart({ filename: 'Screenshot 2026-09-03.png' })).toBe(true);
		expect(isImagePart({ url: 'https://example.com/shot.webp?w=800' })).toBe(true);
		expect(isImagePart({ url: 'data:image/png;base64,abc' })).toBe(true);
	});

	it('does not treat non-image attachments as images', () => {
		expect(isImagePart({ mime: 'application/pdf', filename: 'spec.pdf' })).toBe(false);
		expect(isImagePart({ url: 'https://example.com/notes.txt' })).toBe(false);
		expect(isImagePart({})).toBe(false);
	});
});

describe('isImageSrc', () => {
	it('accepts data URLs and image extensions', () => {
		expect(isImageSrc('data:image/gif;base64,xx')).toBe(true);
		expect(isImageSrc('/tmp/photo.JPEG')).toBe(true);
	});

	it('rejects empty or non-image srcs', () => {
		expect(isImageSrc('')).toBe(false);
		expect(isImageSrc('data:text/plain;base64,xx')).toBe(false);
	});
});

describe('filenameFromSrc', () => {
	it('prefers a sanitized fallback name', () => {
		expect(filenameFromSrc('https://cdn/x.png', 'Screenshot 2026-09-03 at 3.48.12 PM.png')).toBe(
			'Screenshot 2026-09-03 at 3.48.12 PM.png',
		);
		expect(filenameFromSrc('https://cdn/x.png', 'a/b/c.png')).toBe('c.png');
	});

	it('derives a name from the URL path', () => {
		expect(filenameFromSrc('https://cdn.example.com/shots/login.png?token=1')).toBe('login.png');
		expect(filenameFromSrc('vscode-resource://host/Users/me/photo%20copy.jpg')).toBe('photo copy.jpg');
	});

	it('uses the data-URL mime for unnamed blobs', () => {
		expect(filenameFromSrc('data:image/jpeg;base64,/9j/4AAQ')).toBe('image.jpg');
		expect(filenameFromSrc('data:image/png;base64,iVBOR')).toBe('image.png');
	});

	it('falls back to image.png', () => {
		expect(filenameFromSrc(undefined)).toBe('image.png');
		expect(filenameFromSrc('https://example.com/')).toBe('image.png');
	});
});

describe('zoom helpers', () => {
	it('clamps zoom between 25% and 400%', () => {
		expect(clampZoom(0)).toBe(ZOOM_MIN);
		expect(clampZoom(8)).toBe(ZOOM_MAX);
		expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT);
		expect(clampZoom(1.5)).toBe(1.5);
	});

	it('steps zoom in 25% increments', () => {
		expect(nextZoom(1, 1)).toBe(1.25);
		expect(nextZoom(1, -1)).toBe(0.75);
		expect(nextZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
		expect(nextZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
	});
});
