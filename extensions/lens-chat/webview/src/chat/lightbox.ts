import { createSignal } from 'solid-js';
import { filenameFromSrc } from './image';

export type LightboxImage = {
	src: string;
	alt: string;
};

const [lightbox, setLightbox] = createSignal<LightboxImage | null>(null);

export { lightbox };

export function openLightbox(image: LightboxImage): void {
	if (!image.src) {
		return;
	}
	setLightbox({ src: image.src, alt: image.alt || filenameFromSrc(image.src) });
}

export function closeLightbox(): void {
	setLightbox(null);
}

export function handleImageThumbClick(event: MouseEvent): void {
	const img = (event.target as HTMLElement | null)?.closest?.('img.lens-image-thumb') as HTMLImageElement | null;
	if (!img?.src) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	openLightbox({ src: img.currentSrc || img.src, alt: img.alt || '' });
}

export function handleImageThumbKeydown(event: KeyboardEvent): void {
	if (event.key !== 'Enter' && event.key !== ' ') {
		return;
	}
	const img = event.target as HTMLElement | null;
	if (!img?.classList?.contains('lens-image-thumb') || !(img instanceof HTMLImageElement) || !img.src) {
		return;
	}
	event.preventDefault();
	openLightbox({ src: img.currentSrc || img.src, alt: img.alt || '' });
}
