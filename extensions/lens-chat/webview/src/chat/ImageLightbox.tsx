import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { filenameFromSrc, nextZoom, ZOOM_DEFAULT } from './image';
import { closeLightbox, lightbox } from './lightbox';

export function ImageLightbox() {
	return (
		<Show when={lightbox()}>
			{image => <LightboxDialog src={image().src} alt={image().alt} />}
		</Show>
	);
}

function LightboxDialog(props: { src: string; alt: string }) {
	const [zoom, setZoom] = createSignal(ZOOM_DEFAULT);
	const [copyState, setCopyState] = createSignal<'idle' | 'copied' | 'error'>('idle');
	let copyTimer = 0;
	let preview: HTMLImageElement | undefined;
	let dialog: HTMLDivElement | undefined;

	createEffect(() => {
		props.src;
		setZoom(ZOOM_DEFAULT);
		setCopyState('idle');
	});

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeLightbox();
			return;
		}
		if (event.key === '+' || event.key === '=') {
			event.preventDefault();
			setZoom(value => nextZoom(value, 1));
		} else if (event.key === '-' || event.key === '_') {
			event.preventDefault();
			setZoom(value => nextZoom(value, -1));
		} else if (event.key === '0') {
			event.preventDefault();
			setZoom(ZOOM_DEFAULT);
		}
	};

	window.addEventListener('keydown', onKeyDown);
	onMount(() => dialog?.focus());
	onCleanup(() => {
		window.removeEventListener('keydown', onKeyDown);
		window.clearTimeout(copyTimer);
	});

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		setZoom(value => nextZoom(value, event.deltaY < 0 ? 1 : -1));
	}

	async function copyImage() {
		const ok = await copyImageToClipboard(props.src, preview);
		setCopyState(ok ? 'copied' : 'error');
		window.clearTimeout(copyTimer);
		copyTimer = window.setTimeout(() => setCopyState('idle'), 1400);
	}

	function download() {
		void downloadImage(props.src, filenameFromSrc(props.src, props.alt), preview);
	}

	const filename = () => filenameFromSrc(props.src, props.alt);
	const copyLabel = () => (copyState() === 'copied' ? 'Copied' : copyState() === 'error' ? 'Copy failed' : 'Copy');

	return (
		<div
			class="lens-lightbox"
			role="dialog"
			aria-modal="true"
			aria-label={props.alt || 'Image preview'}
			tabIndex={-1}
			ref={el => { dialog = el; }}
			onClick={closeLightbox}
			onWheel={onWheel}
		>
			<div class="lens-lightbox-toolbar" onClick={event => event.stopPropagation()}>
				<button type="button" class="lens-lightbox-btn" title="Zoom out" aria-label="Zoom out" onClick={() => setZoom(value => nextZoom(value, -1))}>
					<IconMinus />
				</button>
				<button
					type="button"
					class="lens-lightbox-zoom"
					title="Reset zoom"
					aria-label="Reset zoom"
					onClick={() => setZoom(ZOOM_DEFAULT)}
				>
					{Math.round(zoom() * 100)}%
				</button>
				<button type="button" class="lens-lightbox-btn" title="Zoom in" aria-label="Zoom in" onClick={() => setZoom(value => nextZoom(value, 1))}>
					<IconPlus />
				</button>
				<button type="button" class="lens-lightbox-btn" title={copyLabel()} aria-label={copyLabel()} onClick={() => void copyImage()}>
					<Show when={copyState() !== 'copied'} fallback={<IconCheck />}>
						<IconCopy />
					</Show>
				</button>
				<button type="button" class="lens-lightbox-btn" title="Download" aria-label="Download" onClick={download}>
					<IconDownload />
				</button>
				<button type="button" class="lens-lightbox-btn" title="Close" aria-label="Close" onClick={closeLightbox}>
					<IconClose />
				</button>
			</div>
			<div class="lens-lightbox-stage" onClick={event => event.stopPropagation()}>
				<img
					class="lens-lightbox-image"
					src={props.src}
					alt={props.alt || filename()}
					draggable={false}
					ref={el => { preview = el; }}
					style={{ zoom: zoom() }}
				/>
			</div>
		</div>
	);
}

async function copyImageToClipboard(src: string, image?: HTMLImageElement): Promise<boolean> {
	try {
		const blob = await pngBlobFromImage(src, image);
		if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
			return true;
		}
		throw new Error('clipboard write unavailable');
	} catch {
		try {
			await navigator.clipboard.writeText(src);
			return true;
		} catch {
			return false;
		}
	}
}

async function pngBlobFromImage(src: string, image?: HTMLImageElement): Promise<Blob> {
	if (image && image.naturalWidth > 0) {
		return canvasPng(image);
	}
	const loaded = await loadImage(src);
	return canvasPng(loaded);
}

function canvasPng(image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }): Promise<Blob> {
	const canvas = document.createElement('canvas');
	canvas.width = image.naturalWidth || Number(image.width) || 0;
	canvas.height = image.naturalHeight || Number(image.height) || 0;
	const ctx = canvas.getContext('2d');
	if (!ctx || !canvas.width || !canvas.height) {
		return Promise.reject(new Error('canvas'));
	}
	ctx.drawImage(image, 0, 0);
	return new Promise((resolve, reject) => {
		canvas.toBlob(result => (result ? resolve(result) : reject(new Error('png'))), 'image/png');
	});
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error('load'));
		image.src = src;
	});
}

async function downloadImage(src: string, filename: string, image?: HTMLImageElement): Promise<void> {
	try {
		const blob = await pngBlobFromImage(src, image);
		const url = URL.createObjectURL(blob);
		triggerDownload(url, filename.endsWith('.png') ? filename : replaceExtension(filename, 'png'));
		window.setTimeout(() => URL.revokeObjectURL(url), 1500);
	} catch {
		triggerDownload(src, filename);
	}
}

function replaceExtension(filename: string, ext: string): string {
	return filename.replace(/\.[^./\\]+$/, '') + '.' + ext;
}

function triggerDownload(href: string, filename: string): void {
	const link = document.createElement('a');
	link.href = href;
	link.download = filename;
	link.rel = 'noopener';
	document.body.appendChild(link);
	link.click();
	link.remove();
}

function IconMinus() {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="currentColor" d="M3.5 7.25h9a.75.75 0 0 1 0 1.5h-9a.75.75 0 0 1 0-1.5Z" />
		</svg>
	);
}

function IconPlus() {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="currentColor" d="M8.75 3.5a.75.75 0 0 0-1.5 0V7.25H3.5a.75.75 0 0 0 0 1.5H7.25V12.5a.75.75 0 0 0 1.5 0V8.75H12.5a.75.75 0 0 0 0-1.5H8.75V3.5Z" />
		</svg>
	);
}

function IconCopy() {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="currentColor" d="M4 2.5A1.5 1.5 0 0 1 5.5 1h6A1.5 1.5 0 0 1 13 2.5v8A1.5 1.5 0 0 1 11.5 12H5.5A1.5 1.5 0 0 1 4 10.5v-8Zm1.5-.5a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5h-6ZM2 5.5a.5.5 0 0 1 .5-.5H3v6.25A2.25 2.25 0 0 0 5.25 13.5H11v.5a.5.5 0 0 1-.5.5h-6A2.5 2.5 0 0 1 2 12v-6.5Z" />
		</svg>
	);
}

function IconCheck() {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-6.25 6.25a.75.75 0 0 1-1.06 0L2.22 7.28a.75.75 0 0 1 1.06-1.06L7 9.94l5.72-5.72a.75.75 0 0 1 1.06 0Z" />
		</svg>
	);
}

function IconDownload() {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="currentColor" d="M8.75 1.75a.75.75 0 0 0-1.5 0v6.69L5.03 6.22a.75.75 0 0 0-1.06 1.06l3.5 3.5a.75.75 0 0 0 1.06 0l3.5-3.5a.75.75 0 0 0-1.06-1.06L8.75 8.44V1.75ZM2.75 11.5a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z" />
		</svg>
	);
}

function IconClose() {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="currentColor" d="m8 8.7 3.1 3.1a.5.5 0 0 0 .7-.7L8.7 8l3.1-3.1a.5.5 0 0 0-.7-.7L8 7.3 4.9 4.2a.5.5 0 1 0-.7.7L7.3 8l-3.1 3.1a.5.5 0 0 0 .7.7L8 8.7Z" />
		</svg>
	);
}
