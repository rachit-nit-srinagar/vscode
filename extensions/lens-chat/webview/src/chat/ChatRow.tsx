import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from 'solid-js';
import { fileChangesFromPart, isFileChangeTool, previewLines, type FileChange } from './fileChange';
import { isQuestionTool, readPreviewFromPart, type ReadPreview } from './fileRead';
import { asTodos, isCancelledStatus, isVisiblePart, messageRole, shortPath, statusLabel, toolLabel, toolLanguage, toolOutput, toolTarget } from './format';
import { isImagePart } from './image';
import { highlightCode } from './markdown';
import { groupAssistantParts, toolCallHeading, toolCardStatus, toolInputSummary, toolOutputPreview } from './mcpTool';
import { CodeFence, MarkdownBlock } from './MarkdownBlock';
import { chosenAnswersFromPart, QuestionCard, questionsFromPart } from './QuestionCard';
import type { ChatMessage, ChatPart, QuestionRequest } from './types';
import { vscode } from '../vscode';
import { ProviderErrorView } from './ProviderError';

export function ChatRow(props: { message: ChatMessage; isLast?: boolean; busy?: boolean; questions?: QuestionRequest[]; rewound?: boolean; userActions?: JSX.Element; focusMode?: boolean }) {
	const role = createMemo(() => messageRole(props.message));
	const parts = createMemo(() => (props.message.parts ?? []).filter(isVisiblePart));
	const reads = createMemo(() => (props.message.parts ?? []).flatMap(part => {
		const preview = readPreviewFromPart(part);
		return preview?.kind === 'file' && preview.text ? [preview] : [];
	}));

	const groups = createMemo(() => groupAssistantParts(parts()));
	const error = createMemo(() => messageError(props.message));
	const lastPart = createMemo(() => {
		const all = parts();
		return all[all.length - 1];
	});
	const copyText = createMemo(() => parts().filter(part => part.type === 'text' && !part.synthetic).map(part => part.text ?? '').join('\n\n').trim());

	return (
		<Show when={parts().length > 0 || !!error()}>
			<div class={`lens-row lens-row-${role()}${props.rewound ? ' lens-rewound' : ''}`}>
				<Show when={role() === 'user'} fallback={
					<>
						<For each={groups()}>
							{group => (
								<Switch>
									<Match when={group.kind === 'tools' ? group.parts : undefined}>
										{toolParts => (
											<Show when={!props.focusMode} fallback={<FocusedToolGroup parts={toolParts()} />}>
												<div class="lens-tool-group">
													<For each={toolParts()}>
														{part => (
															<AssistantPart
																part={part}
																questions={props.questions ?? []}
																reads={reads()}
																streaming={!!props.busy && !!props.isLast && part === lastPart()}
															/>
														)}
													</For>
												</div>
											</Show>
										)}
									</Match>
									<Match when={group.kind === 'part' ? group.part : undefined}>
										{part => (
											<AssistantPart
												part={part()}
												questions={props.questions ?? []}
												reads={reads()}
												streaming={!!props.busy && !!props.isLast && part() === lastPart()}
											/>
										)}
									</Match>
								</Switch>
							)}
						</For>
						<Show when={copyText() && !(!!props.busy && !!props.isLast)}>
							<CopyResponseButton text={copyText()} />
						</Show>
					</>
				}>
					{/* The engine records a compaction as a user message holding only a compaction part. */}
					<Show when={parts().some(part => part.type === 'compaction')} fallback={<UserBubble parts={parts()} />}>
						<div class="lens-muted-row lens-compaction-row">Conversation compacted: the summary below replaces the messages above.</div>
					</Show>
					{props.userActions}
				</Show>
				<Show when={error()}>
					<ProviderErrorView text={error()!} />
				</Show>
			</div>
		</Show>
	);
}

/** Focus view: a one-line summary that replaces a group of tool cards, click to reveal them. */
function FocusedToolGroup(props: { parts: ChatPart[] }) {
	const [revealed, setRevealed] = createSignal(false);
	const count = () => props.parts.length;
	const label = () => (count() === 1 ? toolLabel(props.parts[0]?.tool || 'tool', props.parts[0]?.state?.status) : `${count()} tool calls`);

	return (
		<Show when={!revealed()} fallback={
			<div class="lens-tool-group">
				<For each={props.parts}>{part => <AssistantPart part={part} questions={[]} reads={[]} />}</For>
			</div>
		}>
			<button type="button" class="lens-tool-focused" onClick={() => setRevealed(true)}>
				<span class="lens-tool-focused-dot" />
				{label()}
			</button>
		</Show>
	);
}

/** Provider failures arrive as `info.error` on an assistant message with no parts. */
function messageError(message: ChatMessage): string | undefined {
	const error = message.info?.error;
	// A user-initiated Stop leaves the same shape on the message; it is not a failure to report.
	if (!error || error.name === 'MessageAbortedError') {
		return undefined;
	}
	const text = error.data?.message ?? error.message ?? error.name ?? 'Unknown error';
	// Keep the provider's JSON body when the message alone does not carry it.
	return error.data?.responseBody && !/[[{]/.test(text) ? `${text}: ${error.data.responseBody}` : text;
}

function UserBubble(props: { parts: ChatPart[] }) {
	// Synthetic parts are what the engine added for the model (e.g. the text of an attached file), not what the user typed.
	const text = createMemo(() => props.parts.filter(part => part.type === 'text' && !part.synthetic).map(part => part.text ?? '').join('\n').trim());
	const files = createMemo(() => props.parts.filter(part => part.type === 'file' || !!part.filename || !!part.url));
	return (
		<div class="lens-composer-box lens-user-message">
			<Show when={files().length}>
				<div class="lens-image-row">
					<For each={files()}>
						{file => (
							<Show when={isImagePart(file) && file.url} fallback={<div class="lens-file-chip">{file.filename || 'attachment'}</div>}>
								<ChatImage src={file.url!} alt={file.filename || 'image'} />
							</Show>
						)}
					</For>
				</div>
			</Show>
			<Show when={text()}>
				<div class="lens-user-text">{text()}</div>
			</Show>
		</div>
	);
}

function AssistantPart(props: { part: ChatPart; streaming?: boolean; questions?: QuestionRequest[]; reads?: ReadPreview[] }) {
	return (
		<Switch fallback={<GenericPart part={props.part} reads={props.reads} />}>
			<Match when={props.part.type === 'text'}>
				<div class="lens-assistant-text">
					<MarkdownBlock markdown={props.part.text} reads={props.reads} />
				</div>
			</Match>
			<Match when={props.part.type === 'reasoning'}>
				<ThinkingRow text={props.part.text ?? ''} streaming={props.streaming} />
			</Match>
			<Match when={props.part.type === 'tool'}>
				<FileToolPart part={props.part} questions={props.questions ?? []} />
			</Match>
			<Match when={props.part.type === 'file'}>
				<Show when={isImagePart(props.part) && props.part.url} fallback={<div class="lens-file-chip">{props.part.filename || 'attachment'}</div>}>
					<ChatImage src={props.part.url!} alt={props.part.filename || 'image'} />
				</Show>
			</Match>
			<Match when={props.part.type === 'retry'}>
				<ProviderErrorView text={`Retrying (attempt ${props.part.attempt ?? 1}): ${props.part.text || errorText(props.part.state?.error ?? props.part.error)}`} />
			</Match>
			<Match when={props.part.type === 'compaction'}>
				<div class="lens-muted-row">Conversation condensed</div>
			</Match>
			<Match when={props.part.type === 'subtask'}>
				<ToolCard part={{ ...props.part, tool: props.part.tool || 'task', state: props.part.state ?? { status: 'completed', input: { description: props.part.description, prompt: props.part.prompt } } }} />
			</Match>
		</Switch>
	);
}

function GenericPart(props: { part: ChatPart; reads?: ReadPreview[] }) {
	if (props.part.text?.trim()) {
		return (
			<div class="lens-assistant-text">
				<MarkdownBlock markdown={props.part.text} reads={props.reads} />
			</div>
		);
	}
	return null;
}

function ThinkingRow(props: { text: string; streaming?: boolean }) {
	const [expanded, setExpanded] = createSignal(!!props.streaming);
	return (
		<div class="lens-think">
			<button type="button" class="lens-think-toggle" onClick={() => setExpanded(open => !open)}>
				<span class={`lens-think-label${props.streaming ? ' streaming' : ''}`}>Thinking</span>
				<Show when={expanded()} fallback={<ChevronRight />}>
					<ChevronDown />
				</Show>
			</button>
			<Show when={expanded()}>
				<div class="lens-think-body">{props.text}</div>
			</Show>
		</div>
	);
}

function FileToolPart(props: { part: ChatPart; questions: QuestionRequest[] }) {
	const read = createMemo(() => readPreviewFromPart(props.part));
	const changes = createMemo(() => isFileChangeTool(props.part.tool) ? fileChangesFromPart(props.part) : []);
	const question = createMemo(() => matchQuestion(props.part, props.questions));
	return (
		<Show when={!isQuestionTool(props.part.tool)} fallback={<QuestionToolPart part={props.part} request={question()} />}>
			<Show when={!read()} fallback={<ReadFileCard part={props.part} preview={read()!} />}>
				<Show when={changes().length > 0} fallback={<ToolCard part={props.part} />}>
					<div class="lens-filecards">
						<For each={changes()}>
							{change => <FileChangeCard part={props.part} change={change} />}
						</For>
					</div>
				</Show>
			</Show>
		</Show>
	);
}

function matchQuestion(part: ChatPart, questions: QuestionRequest[]): QuestionRequest | undefined {
	if (isCancelledStatus(part.state?.status)) {
		return undefined;
	}
	const callID = part.callID;
	return questions.find(item => item.tool?.callID && item.tool.callID === callID)
		?? (questions.length === 1 ? questions[0] : undefined);
}

function QuestionToolPart(props: { part: ChatPart; request?: QuestionRequest }) {
	const prompts = () => questionsFromPart(props.part.state?.input);
	const status = () => props.part.state?.status ?? '';
	const cancelled = () => isCancelledStatus(status());
	const completed = () => status() === 'completed';
	return (
		<Show when={!cancelled()} fallback={<div class="lens-muted-row">Question skipped</div>}>
			<Show when={!completed()} fallback={
				<QuestionCard questions={prompts()} status="completed" answers={chosenAnswersFromPart(props.part)} />
			}>
				<QuestionCard
					request={props.request}
					questions={prompts()}
					status={status() || 'running'}
				/>
			</Show>
		</Show>
	);
}

function ReadFileCard(props: { part: ChatPart; preview: ReadPreview }) {
	const status = () => props.part.state?.status ?? '';
	const running = () => status() === 'running' || status() === 'pending';
	const failed = () => status() === 'error';
	const [open, setOpen] = createSignal(true);
	const [more, setMore] = createSignal(false);
	const lines = createMemo(() => props.preview.text.replace(/\n$/, '').split('\n'));
	const shown = createMemo(() => {
		const all = lines();
		const limit = more() ? 80 : 12;
		if (all.length <= limit) {
			return { text: all.join('\n'), hidden: 0 };
		}
		return { text: all.slice(0, limit).join('\n'), hidden: all.length - limit };
	});
	const language = () => (failed() ? 'plaintext' : (props.preview.language === 'plaintext' && props.preview.path.toLowerCase().endsWith('.md') ? 'markdown' : props.preview.language));

	function openFile(event: MouseEvent) {
		event.preventDefault();
		if (!props.preview.path || props.preview.kind === 'directory') {
			return;
		}
		vscode.postMessage({ type: 'file.open', path: props.preview.path, addedLines: [], isNew: false });
	}

	return (
		<div class={`lens-filecard${failed() ? ' error' : ''}${running() ? ' running' : ''}`}>
			<div class="lens-filecard-head">
				<button type="button" class="lens-filecard-open" title={props.preview.path || 'Open file'} onClick={openFile} disabled={!props.preview.path || props.preview.kind === 'directory'}>
					<Show when={props.preview.languageBadge}>
						<span class="lens-filecard-badge">{props.preview.languageBadge}</span>
					</Show>
					<span class="lens-filecard-name">{props.preview.displayName}</span>
					<span class="lens-filecard-label">{running() ? (statusLabel(status()) || 'Reading') : failed() ? 'Error' : 'Read file'}</span>
				</button>
				<button type="button" class="lens-filecard-toggle" title={open() ? 'Collapse preview' : 'Expand preview'} onClick={() => setOpen(value => !value)}>
					<Show when={open()} fallback={<ChevronRight />}>
						<ChevronDown />
					</Show>
				</button>
			</div>
			<Show when={open()}>
				<div class="lens-filecard-body">
					<Show when={failed()} fallback={
						<Show when={props.preview.kind === 'directory'} fallback={
							<>
								<CodeFence code={shown().text} lang={language()} wrap />
								<Show when={!more() && shown().hidden > 0}>
									<button type="button" class="lens-filecard-more" onClick={() => setMore(true)}>
										Show {shown().hidden} more {shown().hidden === 1 ? 'line' : 'lines'}
									</button>
								</Show>
							</>
						}>
							<ul class="lens-todos">
								<For each={props.preview.entries}>
									{entry => <li class="lens-todo"><span class="lens-todo-mark" />{entry}</li>}
								</For>
							</ul>
						</Show>
					}>
						<div class="lens-tool-error">{toolOutput(props.part)}</div>
					</Show>
				</div>
			</Show>
		</div>
	);
}

function FileChangeCard(props: { part: ChatPart; change: FileChange }) {
	const status = () => props.part.state?.status ?? '';
	const running = () => status() === 'running' || status() === 'pending';
	const failed = () => status() === 'error';
	const [open, setOpen] = createSignal(true);
	const [more, setMore] = createSignal(false);
	const preview = createMemo(() => previewLines(props.change.lines, more()));
	const hasPreview = createMemo(() => props.change.lines.some(line => line.kind !== 'meta'));

	function openFile(event: MouseEvent) {
		event.preventDefault();
		if (!props.change.path || props.change.deleted) {
			return;
		}
		vscode.postMessage({
			type: 'file.open',
			path: props.change.path,
			addedLines: props.change.addedLines,
			isNew: props.change.isNew,
		});
	}

	return (
		<div class={`lens-filecard${failed() ? ' error' : ''}${running() ? ' running' : ''}`}>
			<div class="lens-filecard-head">
				<button type="button" class="lens-filecard-open" title={props.change.deleted ? 'File was deleted' : (props.change.path || 'Open file')} onClick={openFile} disabled={!props.change.path || props.change.deleted}>
					<Show when={props.change.languageBadge}>
						<span class="lens-filecard-badge">{props.change.languageBadge}</span>
					</Show>
					<span class="lens-filecard-name">{props.change.displayName}</span>
					<Show when={!running() && (props.change.additions > 0 || props.change.deletions > 0)} fallback={
						<Show when={!running()}>
							<span class="lens-filecard-label">{props.change.label}</span>
						</Show>
					}>
						<Show when={props.change.additions > 0}>
							<span class="lens-filecard-add">+{props.change.additions}</span>
						</Show>
						<Show when={props.change.deletions > 0}>
							<span class="lens-filecard-del">-{props.change.deletions}</span>
						</Show>
					</Show>
					<Show when={running()}>
						<span class="lens-filecard-label running">{statusLabel(status()) || 'Writing'}</span>
					</Show>
				</button>
				<Show when={hasPreview()}>
					<button type="button" class="lens-filecard-toggle" title={open() ? 'Collapse preview' : 'Expand preview'} onClick={() => setOpen(value => !value)}>
						<Show when={open()} fallback={<ChevronRight />}>
							<ChevronDown />
						</Show>
					</button>
				</Show>
			</div>
			<Show when={open() && hasPreview()}>
				<div class="lens-filecard-body">
					<div class="lens-diff-preview">
						<For each={preview().shown}>
							{line => (
								<div class={`lens-diff-line lens-diff-${line.kind}`}>
									<span class="lens-diff-num">{line.kind === 'hunk' ? '' : (line.lineNumber || '')}</span>
									<span class="lens-diff-mark">{line.kind === 'hunk' ? '' : line.marker}</span>
									<Show when={line.kind === 'hunk'} fallback={
										<code class="lens-diff-code" innerHTML={highlightCode(line.text, props.change.language)} />
									}>
										<span class="lens-diff-hunk">{line.text}</span>
									</Show>
								</div>
							)}
						</For>
					</div>
					<Show when={!more() && preview().hidden > 0}>
						<button type="button" class="lens-filecard-more" onClick={() => setMore(true)}>
							Show {preview().hidden} more {preview().hidden === 1 ? 'line' : 'lines'}
						</button>
					</Show>
					<Show when={more() && preview().hidden > 0}>
						<div class="lens-filecard-more muted">Truncated · {preview().hidden} more lines</div>
					</Show>
				</div>
			</Show>
		</div>
	);
}

function ToolCard(props: { part: ChatPart }) {
	const tool = () => props.part.tool || 'tool';
	const heading = () => toolCallHeading(tool());
	const cardStatus = () => toolCardStatus(props.part.state?.status);
	const target = () => toolTarget(props.part);
	const output = () => toolOutput(props.part);
	const preview = () => toolOutputPreview(output());
	const summary = () => toolInputSummary(props.part);
	const todos = () => asTodos(props.part);
	const running = () => cardStatus().kind === 'running' || cardStatus().kind === 'pending';
	const failed = () => cardStatus().kind === 'error';
	const [expanded, setExpanded] = createSignal(false);
	const hasBody = () => todos().length > 0 || (tool() === 'bash' && !!target()) || (!!output() && !failed());

	return (
		<div class="lens-tool-wrap">
			<div class={`lens-call-card${heading().isMcp ? ' mcp' : ''}${failed() ? ' error' : ''}${running() ? ' running' : ''}`}>
				<button
					type="button"
					class="lens-call-card-head"
					disabled={!hasBody() && !failed()}
					onClick={() => {
						if (hasBody()) {
							setExpanded(open => !open);
						}
					}}
				>
					<Show when={heading().isMcp} fallback={<ToolIcon tool={tool()} />}>
						<span class="lens-mcp-badge">MCP</span>
					</Show>
					<span class="lens-call-card-title">
						<Show when={heading().isMcp && heading().server} fallback={
							<span class="lens-call-card-tool">{heading().isMcp ? heading().tool : toolLabel(tool(), props.part.state?.status)}</span>
						}>
							<span class="lens-call-card-server">{heading().server}</span>
							<span class="lens-call-card-sep" aria-hidden="true">→</span>
							<span class="lens-call-card-tool">{heading().tool}</span>
						</Show>
					</span>
					<span class={`lens-call-card-status ${cardStatus().kind}`}>
						<span class={`lens-status-dot ${running() ? 'running' : failed() ? 'error' : 'done'}`} />
						{cardStatus().label}
					</span>
					<Show when={hasBody() && !expanded() && !!output() && !failed()}>
						<span class="lens-call-card-more">Show output</span>
					</Show>
					<Show when={hasBody()}>
						<Show when={expanded()} fallback={<ChevronRight />}>
							<ChevronDown />
						</Show>
					</Show>
				</button>
				<Show when={summary() && heading().isMcp && !expanded()}>
					<div class="lens-call-card-summary" title={summary()}>{shortPath(summary())}</div>
				</Show>
				<Show when={expanded() || failed()}>
					<Show when={tool() === 'bash' && target()}>
						<div class="lens-tool-command">
							<CodeFence code={target()} lang="bash" wrap />
						</div>
					</Show>
					<Show when={todos().length > 0}>
						<ul class="lens-todos">
							<For each={todos()}>
								{todo => (
									<li class={`lens-todo lens-todo-${todo.status || 'pending'}`}>
										<span class="lens-todo-mark" />
										{todo.content}
									</li>
								)}
							</For>
						</ul>
					</Show>
					<Show when={output()}>
						<Show when={failed()} fallback={
							<div class="lens-call-card-output">
								<CodeFence code={preview().text} lang={toolLanguage(props.part)} wrap />
								<Show when={preview().truncated}>
									<div class="lens-call-card-truncated">Truncated</div>
								</Show>
							</div>
						}>
							<div class="lens-tool-error">{output()}</div>
						</Show>
					</Show>
				</Show>
			</div>
		</div>
	);
}

function CopyResponseButton(props: { text: string }) {
	const [copied, setCopied] = createSignal(false);
	return (
		<button
			type="button"
			class="lens-row-copy"
			title={copied() ? 'Copied' : 'Copy response'}
			onClick={() => {
				void navigator.clipboard.writeText(props.text).then(() => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1200);
				});
			}}
		>
			<Show when={copied()} fallback={<IconCopy />}>
				<IconCheck />
			</Show>
		</button>
	);
}

function IconCopy() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<rect x="9" y="9" width="13" height="13" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</svg>
	);
}
function IconCheck() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<polyline points="20 6 9 17 4 12" />
		</svg>
	);
}

function ChatImage(props: { src: string; alt?: string }) {
	return (
		<img
			class="lens-image-thumb"
			src={props.src}
			alt={props.alt || 'image'}
			role="button"
			tabindex="0"
			draggable={false}
		/>
	);
}

function errorText(value: unknown): string {
	if (!value) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	const error = value as { message?: string; data?: { message?: string; responseBody?: string } };
	return error.data?.responseBody ?? error.data?.message ?? error.message ?? JSON.stringify(value);
}

function ToolIcon(props: { tool: string }) {
	return (
		<Switch fallback={<IconSparkle />}>
			<Match when={props.tool === 'bash'}><IconTerminal /></Match>
			<Match when={props.tool === 'read'}><IconFile /></Match>
			<Match when={props.tool === 'write'}><IconFilePlus /></Match>
			<Match when={props.tool === 'edit'}><IconPencil /></Match>
			<Match when={props.tool === 'grep' || props.tool === 'glob'}><IconSearch /></Match>
			<Match when={props.tool === 'list'}><IconFolder /></Match>
			<Match when={props.tool === 'webfetch'}><IconGlobe /></Match>
			<Match when={props.tool === 'todowrite' || props.tool === 'todoread'}><IconList /></Match>
			<Match when={props.tool === 'task'}><IconRobot /></Match>
			<Match when={props.tool === 'question' || props.tool === 'ask_question'}><IconSparkle /></Match>
		</Switch>
	);
}

function svg(path: string) {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d={path} />
		</svg>
	);
}

function IconTerminal() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<polyline points="4 17 10 11 4 5" />
			<line x1="12" y1="19" x2="20" y2="19" />
		</svg>
	);
}
function IconFile() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
			<polyline points="14 2 14 8 20 8" />
		</svg>
	);
}
function IconFilePlus() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
			<polyline points="14 2 14 8 20 8" />
			<line x1="12" y1="18" x2="12" y2="12" />
			<line x1="9" y1="15" x2="15" y2="15" />
		</svg>
	);
}
function IconPencil() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M12 20h9" />
			<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
		</svg>
	);
}
function IconSearch() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="11" cy="11" r="8" />
			<line x1="21" y1="21" x2="16.65" y2="16.65" />
		</svg>
	);
}
function IconFolder() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
		</svg>
	);
}
function IconGlobe() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="10" />
			<line x1="2" y1="12" x2="22" y2="12" />
			<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
		</svg>
	);
}
function IconList() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<line x1="8" y1="6" x2="21" y2="6" />
			<line x1="8" y1="12" x2="21" y2="12" />
			<line x1="8" y1="18" x2="21" y2="18" />
			<line x1="3" y1="6" x2="3.01" y2="6" />
			<line x1="3" y1="12" x2="3.01" y2="12" />
			<line x1="3" y1="18" x2="3.01" y2="18" />
		</svg>
	);
}
function IconRobot() {
	return (
		<svg class="lens-row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<rect x="3" y="11" width="18" height="10" rx="2" />
			<circle cx="12" cy="5" r="2" />
			<line x1="12" y1="7" x2="12" y2="11" />
			<line x1="8" y1="16" x2="8" y2="16" />
			<line x1="16" y1="16" x2="16" y2="16" />
		</svg>
	);
}
function IconSparkle() {
	return svg('M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z');
}
function IconAlert() {
	return (
		<svg class="lens-row-icon lens-error-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="10" />
			<line x1="12" y1="8" x2="12" y2="12" />
			<line x1="12" y1="16" x2="12.01" y2="16" />
		</svg>
	);
}
function ChevronDown() {
	return (
		<svg class="lens-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<polyline points="6 9 12 15 18 9" />
		</svg>
	);
}
function ChevronRight() {
	return (
		<svg class="lens-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<polyline points="9 18 15 12 9 6" />
		</svg>
	);
}
