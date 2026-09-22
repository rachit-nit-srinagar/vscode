import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');
const outDir = path.join(__dirname, 'dist');

const options = {
	entryPoints: [path.join(srcDir, 'extension.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	outfile: path.join(outDir, 'extension.js'),
	external: ['vscode'],
	sourcemap: true,
	target: ['es2022'],
	logLevel: 'info',
};

async function build() {
	fs.mkdirSync(outDir, { recursive: true });
	await esbuild.build(options);
}

const isWatch = process.argv.includes('--watch');
if (isWatch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('[lens-chat] watching...');
} else {
	build().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
