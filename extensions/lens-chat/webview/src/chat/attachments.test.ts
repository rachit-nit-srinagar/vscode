import { describe, expect, it, vi } from 'vitest';
import {
	attachmentFilename,
	clipboardFiles,
	fileToImageAttachment,
	inferImageAttachmentMime,
	UNSUPPORTED_ATTACHMENT_MESSAGE,
} from './attachments';

describe('inferImageAttachmentMime', () => {
	it('accepts supported image mime types', () => {
		expect(inferImageAttachmentMime({ name: 'shot.png', type: 'image/png' })).toBe('image/png');
		expect(inferImageAttachmentMime({ name: 'photo.jpg', type: 'image/jpeg' })).toBe('image/jpeg');
		expect(inferImageAttachmentMime({ name: 'anim.gif', type: 'image/gif' })).toBe('image/gif');
		expect(inferImageAttachmentMime({ name: 'thumb.webp', type: 'image/webp' })).toBe('image/webp');
	});

	it('infers mime from filename when type is empty or octet-stream', () => {
		expect(inferImageAttachmentMime({ name: 'Screenshot.png', type: '' })).toBe('image/png');
		expect(inferImageAttachmentMime({ name: 'photo.JPG', type: 'application/octet-stream' })).toBe('image/jpeg');
	});

	it('rejects unsupported types', () => {
		expect(inferImageAttachmentMime({ name: 'notes.txt', type: 'text/plain' })).toBeUndefined();
		expect(inferImageAttachmentMime({ name: 'icon.svg', type: 'image/svg+xml' })).toBeUndefined();
		expect(inferImageAttachmentMime({ name: 'spec.pdf', type: 'application/pdf' })).toBeUndefined();
	});
});

describe('attachmentFilename', () => {
	it('uses the file name when present', () => {
		expect(attachmentFilename({ name: 'Screenshot 2026-09-03.png' })).toBe('Screenshot 2026-09-03.png');
	});

	it('falls back to image.png for unnamed clipboard images', () => {
		expect(attachmentFilename({ name: '' })).toBe('image.png');
	});
});

describe('fileToImageAttachment', () => {
	it('returns a data-url attachment for supported images', async () => {
		class MockFileReader {
			result = 'data:image/png;base64,abc';
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			readAsDataURL() {
				queueMicrotask(() => this.onload?.());
			}
		}
		vi.stubGlobal('FileReader', MockFileReader);

		const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const file = new File([bytes], 'shot.png', { type: 'image/png' });
		const attachment = await fileToImageAttachment(file);
		expect(attachment).toEqual({
			type: 'file',
			mime: 'image/png',
			url: 'data:image/png;base64,abc',
			filename: 'shot.png',
		});

		vi.unstubAllGlobals();
	});

	it('returns undefined for unsupported files', async () => {
		const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
		expect(await fileToImageAttachment(file)).toBeUndefined();
		expect(UNSUPPORTED_ATTACHMENT_MESSAGE).toContain('PNG');
	});
});

describe('clipboardFiles', () => {
	it('extracts file items from clipboard events', () => {
		const file = new File(['x'], 'paste.png', { type: 'image/png' });
		const event = {
			clipboardData: {
				items: [
					{ kind: 'file', getAsFile: () => file },
					{ kind: 'string', getAsFile: () => null },
				],
			},
		} as unknown as ClipboardEvent;
		expect(clipboardFiles(event)).toEqual([file]);
	});
});
