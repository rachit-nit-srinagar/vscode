import type { Disposable, TextEditor } from 'vscode';
import { commands, Uri, window, workspace } from 'vscode';
import { realpath } from 'fs/promises';
import { dirname, join, relative, sep } from 'path';
import { editorContextInfo, exclusionReason, formatMention, selectionLineRange, type EditorContextInfo, type ExcludeGlobs, type GitignoreFile } from './editorContext';
import type { HostToWebview, PromptPart } from './protocol';

export const ATTACH_OPEN_FILE_SETTING = 'lens.chat.attachOpenFile';

type ChatPoster = (message: HostToWebview) => boolean;

/**
 * Follows the active editor and its selection and tells Lens Chat what it may offer as context.
 * All exclusion decisions happen here, in the extension host: the webview only ever learns about
 * files that passed them, and every `file:` part it sends back is checked again before it is used.
 */
export class EditorContextTracker implements Disposable {
	private readonly disposables: Disposable[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private last: EditorContextInfo | undefined;
	private pendingMention: string | undefined;

	constructor(private readonly postToChat: ChatPoster) {
		this.disposables.push(
			window.onDidChangeActiveTextEditor(() => this.schedule()),
			window.onDidChangeTextEditorSelection(event => {
				if (event.textEditor === window.activeTextEditor) {
					this.schedule();
				}
			}),
			workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(ATTACH_OPEN_FILE_SETTING) || event.affectsConfiguration('files.exclude') || event.affectsConfiguration('search.exclude')) {
					this.schedule();
				}
			}),
			commands.registerCommand('lens.chat.insertMention', () => this.insertMention()),
		);
		this.schedule();
	}

	dispose(): void {
		clearTimeout(this.timer);
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/** The chat webview (re)loaded: send it the current context and any mention it missed. */
	chatReady(): void {
		this.postToChat({ type: 'editorContext', context: this.last });
		if (this.pendingMention && this.postToChat({ type: 'insertMention', text: this.pendingMention })) {
			this.pendingMention = undefined;
		}
	}

	/**
	 * Rejects `file:` prompt parts that point outside the workspace or at an excluded file. The webview
	 * is untrusted, so this runs on every prompt, not only on parts the chip produced.
	 */
	async checkPromptParts(parts: readonly PromptPart[] | undefined): Promise<void> {
		for (const part of parts ?? []) {
			if (part.type !== 'file' || !/^file:/i.test(part.url)) {
				continue;
			}
			let uri: Uri;
			try {
				uri = Uri.parse(part.url.split(/[?#]/)[0], true);
			} catch {
				throw new Error(`Lens did not send "${part.filename ?? part.url}": it is not a valid file link.`);
			}
			const reason = await this.exclusionFor(uri);
			if (reason) {
				throw new Error(`Lens did not send "${part.filename ?? uri.fsPath}" to the model because ${reason}. Remove it and try again.`);
			}
		}
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.publish(), 150);
	}

	private async publish(): Promise<void> {
		const generation = ++this.generation;
		let context: EditorContextInfo | undefined;
		try {
			context = await this.contextFor(window.activeTextEditor);
		} catch {
			// Nothing is offered when the file cannot be checked; that is the safe outcome.
			context = undefined;
		}
		if (generation !== this.generation) {
			return;
		}
		if (context?.url === this.last?.url && context?.kind === this.last?.kind) {
			return;
		}
		this.last = context;
		this.postToChat({ type: 'editorContext', context });
	}

	private async contextFor(editor: TextEditor | undefined): Promise<EditorContextInfo | undefined> {
		if (!editor || editor.document.uri.scheme !== 'file') {
			return undefined;
		}
		const selection = editor.selection;
		const range = selectionLineRange(selection.start, selection.end);
		if (!range && !workspace.getConfiguration().get<boolean>(ATTACH_OPEN_FILE_SETTING, true)) {
			return undefined;
		}
		const relativePath = this.relativePath(editor.document.uri);
		if (!relativePath || await this.exclusionFor(editor.document.uri)) {
			return undefined;
		}
		return editorContextInfo(relativePath, editor.document.uri.toString(true), range);
	}

	private async insertMention(): Promise<void> {
		const editor = window.activeTextEditor;
		if (!editor || editor.document.uri.scheme !== 'file') {
			void window.showInformationMessage('Open a file from the workspace to mention it in Lens Chat.');
			return;
		}
		const relativePath = this.relativePath(editor.document.uri);
		const reason = relativePath ? await this.exclusionFor(editor.document.uri) : 'it is outside the workspace';
		if (!relativePath || reason) {
			void window.showWarningMessage(`Lens Chat will not mention this file because ${reason}.`);
			return;
		}
		const mention = formatMention(relativePath, selectionLineRange(editor.selection.start, editor.selection.end));
		await commands.executeCommand('lens.chat.focus');
		if (!this.postToChat({ type: 'insertMention', text: mention })) {
			this.pendingMention = mention;
		}
	}

	private relativePath(uri: Uri): string | undefined {
		const folder = workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return undefined;
		}
		const path = relative(folder.uri.fsPath, uri.fsPath);
		if (!path || path.startsWith('..') || path.includes(`..${sep}`)) {
			return undefined;
		}
		return path.split(sep).join('/');
	}

	/** Why the file must not be shared, or undefined when it may be. Symlinks are judged by both ends. */
	private async exclusionFor(uri: Uri): Promise<string | undefined> {
		const folder = workspace.getWorkspaceFolder(uri);
		const relativePath = this.relativePath(uri);
		if (!folder || !relativePath) {
			return 'it is outside the workspace';
		}
		const inputs = {
			filesExclude: workspace.getConfiguration('files', uri).get<ExcludeGlobs>('exclude'),
			searchExclude: workspace.getConfiguration('search', uri).get<ExcludeGlobs>('exclude'),
			gitignores: await readGitignores(folder.uri.fsPath, relativePath),
		};
		const reason = exclusionReason(relativePath, inputs);
		if (reason) {
			return reason;
		}
		let real: string;
		let realRoot: string;
		try {
			[real, realRoot] = await Promise.all([realpath(uri.fsPath), realpath(folder.uri.fsPath)]);
		} catch {
			// Not on disk (yet): only the path itself can be judged, and it passed.
			return undefined;
		}
		const realRelative = relative(realRoot, real);
		if (!realRelative || realRelative.startsWith('..')) {
			return 'it links to a file outside the workspace';
		}
		const target = realRelative.split(sep).join('/');
		return target === relativePath ? undefined : exclusionReason(target, { ...inputs, gitignores: await readGitignores(realRoot, target) });
	}
}

/** Reads the .gitignore files from the workspace root down to the file's folder. */
async function readGitignores(root: string, relativePath: string): Promise<GitignoreFile[]> {
	const dirs = [''];
	const parent = dirname(relativePath);
	if (parent !== '.') {
		const segments = parent.split('/');
		segments.forEach((_, index) => dirs.push(segments.slice(0, index + 1).join('/')));
	}
	const files = await Promise.all(dirs.map(async dir => {
		try {
			const bytes = await workspace.fs.readFile(Uri.file(join(root, dir, '.gitignore')));
			return { dir, content: new TextDecoder().decode(bytes) };
		} catch {
			return undefined;
		}
	}));
	return files.filter((file): file is GitignoreFile => !!file);
}
