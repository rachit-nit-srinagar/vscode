export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.25;
export const ZOOM_DEFAULT = 1;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?)$/i;

export type ImageLikePart = {
	mime?: string;
	url?: string;
	filename?: string;
};

export function isImageMime(mime?: string): boolean {
	return !!mime?.toLowerCase().startsWith('image/');
}

export function isImageSrc(src?: string): boolean {
	if (!src) {
		return false;
	}
	if (src.startsWith('data:image/')) {
		return true;
	}
	const path = src.split('#')[0].split('?')[0];
	return IMAGE_EXT.test(path);
}

export function isImagePart(part: ImageLikePart): boolean {
	if (isImageMime(part.mime)) {
		return true;
	}
	if (part.filename && IMAGE_EXT.test(part.filename)) {
		return true;
	}
	return isImageSrc(part.url);
}

export function filenameFromSrc(src?: string, fallback?: string): string {
	const named = sanitizeFilename(fallback);
	if (named) {
		return named;
	}
	if (!src) {
		return 'image.png';
	}
	if (src.startsWith('data:')) {
		const comma = src.indexOf(',');
		const header = comma === -1 ? src.slice(5) : src.slice(5, comma);
		const mime = header.split(';')[0] || 'image/png';
		const subtype = mime.split('/')[1]?.split('+')[0] || 'png';
		const ext = subtype === 'jpeg' ? 'jpg' : subtype;
		return `image.${ext || 'png'}`;
	}
	try {
		const withoutQuery = src.split('#')[0].split('?')[0];
		const last = withoutQuery.split('/').pop() || '';
		const decoded = sanitizeFilename(decodeURIComponent(last));
		if (decoded) {
			return decoded;
		}
	} catch {
		// ignore malformed URIs
	}
	return 'image.png';
}

function sanitizeFilename(value?: string): string | undefined {
	const raw = (value ?? '').trim();
	if (!raw) {
		return undefined;
	}
	const base = raw.split(/[/\\]/).pop() ?? raw;
	const name = base.replace(/[?%*:|"<>]/g, '');
	if (!name || name === '.' || name === '..') {
		return undefined;
	}
	return name;
}

export function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) {
		return ZOOM_DEFAULT;
	}
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function nextZoom(current: number, direction: 1 | -1): number {
	const stepped = Math.round((clampZoom(current) + direction * ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP;
	return clampZoom(Number(stepped.toFixed(2)));
}
