import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root,
	plugins: [solid()],
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
	},
});
