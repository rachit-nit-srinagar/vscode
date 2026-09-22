export const MAX_IMAGE_ATTACHMENTS = 8;

export const IMAGE_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

export type ImageAttachment = {
	type: 'file';
	mime: string;
	url: string;
	filename: string;
};

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const IMAGE_EXTENSIONS = new Map([
	['gif', 'image/gif'],
	['jpeg', 'image/jpeg'],
	['jpg', 'image/jpeg'],
	['png', 'image/png'],
	['webp', 'image/webp'],
]);

export const UNSUPPORTED_ATTACHMENT_MESSAGE = 'Only PNG, JPEG, GIF, and WebP images are supported.';

export function inferImageAttachmentMime(file: Pick<File, 'name' | 'type'>): string | undefined {
	const type = file.type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
	if (IMAGE_MIMES.has(type)) {
		return type;
	}
	const index = file.name.lastIndexOf('.');
	const suffix = index === -1 ? '' : file.name.slice(index + 1).toLowerCase();
	const fallback = IMAGE_EXTENSIONS.get(suffix);
	if ((!type || type === 'application/octet-stream') && fallback) {
		return fallback;
	}
	return undefined;
}

export function attachmentFilename(file: Pick<File, 'name'>): string {
	const name = file.name.trim();
	return name || 'image.png';
}

export function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ''));
		reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
		reader.readAsDataURL(file);
	});
}

export async function fileToImageAttachment(file: File): Promise<ImageAttachment | undefined> {
	const mime = inferImageAttachmentMime(file);
	if (!mime) {
		return undefined;
	}
	const url = await readFileAsDataUrl(file);
	return {
		type: 'file',
		mime,
		url,
		filename: attachmentFilename(file),
	};
}

export function clipboardFiles(event: ClipboardEvent): File[] {
	const clipboardData = event.clipboardData;
	if (!clipboardData) {
		return [];
	}
	return Array.from(clipboardData.items).flatMap(item => {
		if (item.kind !== 'file') {
			return [];
		}
		const file = item.getAsFile();
		return file ? [file] : [];
	});
}

export function hasClipboardFiles(event: ClipboardEvent): boolean {
	return clipboardFiles(event).length > 0;
}

export function dragEventFiles(event: DragEvent): File[] {
	const files = event.dataTransfer?.files;
	return files ? Array.from(files) : [];
}
