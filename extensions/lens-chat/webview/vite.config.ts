import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: __dirname,
	base: './',
	plugins: [solid()],
	build: {
		outDir: path.resolve(__dirname, '../media/webview'),
		emptyOutDir: true,
		assetsDir: '.',
		rollupOptions: {
			input: path.resolve(__dirname, 'index.html'),
			output: {
				format: 'iife',
				entryFileNames: 'index.js',
				assetFileNames: 'index.[ext]',
				inlineDynamicImports: true,
			},
		},
	},
});
