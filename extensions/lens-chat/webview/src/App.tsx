import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { ChatRow } from './chat/ChatRow';
import { isQuestionTool } from './chat/fileRead';
import { formatSessionTitle, isCancelledStatus } from './chat/format';
import { ImageLightbox } from './chat/ImageLightbox';
import { handleImageThumbClick, handleImageThumbKeydown, lightbox } from './chat/lightbox';
import { handleCodeCopyClick } from './chat/markdown';
import { QuestionCard } from './chat/QuestionCard';
import type { ChatMessage, ChatPart, QuestionRequest } from './chat/types';
import {
	DEFAULT_MODEL,
	filterModelChoices,
	groupModelChoices,
	parseModelChoices,
	resolvePreferredModel,
	shortModelLabel,
	type ModelChoice,
	type ModelGroup,
} from './chat/modelPicker';
import { isImagePart } from './chat/image';
import {
	dragEventFiles,
	clipboardFiles,
	fileToImageAttachment,
	hasClipboardFiles,
	IMAGE_ATTACHMENT_ACCEPT,
	MAX_IMAGE_ATTACHMENTS,
	UNSUPPORTED_ATTACHMENT_MESSAGE,
} from './chat/attachments';
import { applyChatEvent, eventSessionID } from './chat/streamEvents';
import { ExtensionsView } from './settings/ExtensionsView';
import { vscode } from './vscode';

type Tab = { id: string; title: string };
type SlashItem = { kind: 'command' | 'skill'; name: string; description?: string };
type Attachment = { type: 'file'; mime: string; url: string; filename?: string };
type PermissionRequest = { id: string; sessionID?: string; permission?: string; patterns?: string[] };
type AgentInfo = { name?: string; mode?: string; hidden?: boolean };
type HistoryItem = { id: string; title?: string; time?: { updated?: number; archived?: number } };
type MentionItem = { kind: 'file' | 'symbol'; label: string; insert: string; detail?: string };
type FileDiff = { path: string; status?: string; additions?: number; deletions?: number };

const view = document.getElementById('root')?.dataset.view ?? 'chat';
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type PickerKind = 'agent' | 'model';

export function App() {
	if (view === 'extensions') {
		onMount(() => vscode.postMessage({ type: 'ready' }));
		return <ExtensionsView />;
	}
	return <ChatApp />;
}

function ChatApp() {
	const [booted, setBooted] = createSignal(false);
	const [engine, setEngine] = createSignal(false);
	const [error, setError] = createSignal('');
	const [tabs, setTabs] = createSignal<Tab[]>([]);
	const [active, setActive] = createSignal<string | undefined>();
	const [messages, setMessages] = createSignal<ChatMessage[]>([]);
	const [draft, setDraft] = createSignal('');
	const [busy, setBusy] = createSignal(false);
	const [historyOpen, setHistoryOpen] = createSignal(false);
	const [history, setHistory] = createSignal<HistoryItem[]>([]);
	const [historyQuery, setHistoryQuery] = createSignal('');
	const [agents, setAgents] = createSignal<AgentInfo[]>([]);
	const [providers, setProviders] = createSignal<unknown>({});
	const [agent, setAgent] = createSignal('build');
	const [model, setModel] = createSignal(DEFAULT_MODEL);
	const [effort, setEffort] = createSignal('high');
	const [picker, setPicker] = createSignal<PickerKind | null>(null);
	const [modelPanelView, setModelPanelView] = createSignal<'main' | 'effort' | 'model'>('main');
	const [modelQuery, setModelQuery] = createSignal('');
	const [mentions, setMentions] = createSignal<MentionItem[]>([]);
	const [reviewDiffs, setReviewDiffs] = createSignal<FileDiff[]>([]);
	const [reviewOpen, setReviewOpen] = createSignal(false);
	const [slash, setSlash] = createSignal<SlashItem[]>([]);
	const [slashOpen, setSlashOpen] = createSignal(false);
	const [attachments, setAttachments] = createSignal<Attachment[]>([]);
	const [permissions, setPermissions] = createSignal<PermissionRequest[]>([]);
	const [questions, setQuestions] = createSignal<QuestionRequest[]>([]);
	let fileInput: HTMLInputElement | undefined;
	let pendingPrompt: PendingPrompt | undefined;
	const slashCatalog: SlashItem[] = [];

	const visibleAgents = createMemo(() => {
		const listed = agents().filter(item => item.name && item.mode !== 'subagent' && !item.hidden);
		const names = listed.map(item => item.name!).filter(Boolean);
		return names.length ? names : ['build', 'plan'];
	});

	const modelChoices = createMemo(() => parseModelChoices(providers()));
	const filteredPickerModels = createMemo(() => filterModelChoices(modelChoices(), modelQuery()));
	const groupedPickerModels = createMemo(() => groupModelChoices(filteredPickerModels()));
	const pickerModels = createMemo(() => modelChoices().length ? modelChoices() : [{ value: DEFAULT_MODEL, label: 'Claude 5 Sonnet', modelId: 'gcp/claude-5-sonnet', group: 'gcp' } satisfies ModelChoice]);
	const showModelSearch = createMemo(() => modelChoices().length > 8);
	const currentModelLabel = createMemo(() => pickerModels().find(choice => choice.value === model())?.label ?? shortModelLabel(model()));
	const agentTriggerLabel = createMemo(() => agentDisplayName(agent()));

	createEffect(() => {
		const choices = modelChoices();
		if (!choices.length) {
			return;
		}
		const next = resolvePreferredModel(choices, model());
		if (next && next !== model()) {
			setModel(next);
		}
	});

	onMount(() => {
		const onMessage = (event: MessageEvent) => {
			const data = event.data;
			if (!data || typeof data !== 'object') return;
			if (data.type === 'boot') {
				setBooted(true);
				setEngine(!!data.runtime);
				if (data.runtime) {
					vscode.postMessage({ type: 'agent.list' });
					vscode.postMessage({ type: 'provider.list' });
					vscode.postMessage({ type: 'session.list' });
					vscode.postMessage({ type: 'command.list' });
					vscode.postMessage({ type: 'skill.list' });
					vscode.postMessage({ type: 'permission.list' });
					vscode.postMessage({ type: 'question.list' });
				}
			} else if (data.type === 'error') {
				pendingPrompt = undefined;
				setBusy(false);
				setError(readableError(data.message));
			} else if (data.type === 'result') {
				handleResult(data.requestType, data.data);
			} else if (data.type === 'event') {
				handleEvent(data.payload);
			} else if (data.type === 'command') {
				if (data.action === 'new') {
					createSession();
				} else if (data.action === 'history') {
					const next = !historyOpen();
					setHistoryOpen(next);
					if (next) {
						vscode.postMessage({ type: 'session.list', search: historyQuery() });
					}
				}
			}
		};
		window.addEventListener('message', onMessage);
		vscode.postMessage({ type: 'ready' });
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest('.lens-picker-panel, .lens-picker-trigger')) {
				return;
			}
			closePicker();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			handleImageThumbKeydown(event);
			if (event.key === 'Escape') {
				if (lightbox()) {
					return;
				}
				closePicker();
			}
		};
		document.addEventListener('pointerdown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		onCleanup(() => {
			window.removeEventListener('message', onMessage);
			document.removeEventListener('pointerdown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		});
	});

	function closePicker() {
		setPicker(null);
		setModelPanelView('main');
		setModelQuery('');
	}

	function togglePicker(kind: PickerKind) {
		setPicker(current => current === kind ? null : kind);
		setModelPanelView('main');
	}

	function upsertSlash(items: SlashItem[]) {
		for (const item of items) {
			const index = slashCatalog.findIndex(entry => entry.kind === item.kind && entry.name === item.name);
			if (index >= 0) {
				slashCatalog[index] = item;
			} else {
				slashCatalog.push(item);
			}
		}
	}

	function handleResult(requestType: string, data: unknown) {
		if (requestType === 'session.create') {
			const session = data as { id?: string; title?: string };
			if (!session?.id) {
				pendingPrompt = undefined;
				setBusy(false);
				setError('Could not start a chat session.');
				return;
			}
			setError('');
			setTabs(current => current.some(tab => tab.id === session.id) ? current : [...current, { id: session.id!, title: session.title || 'New chat' }]);
			setActive(session.id);
			setMessages([]);
			setReviewDiffs([]);
			const queued = pendingPrompt;
			pendingPrompt = undefined;
			if (queued) {
				promptSession(session.id!, queued.text, queued.parts);
			}
		} else if (requestType === 'session.list') {
			setHistory(Array.isArray(data) ? data as HistoryItem[] : []);
		} else if (requestType === 'session.messages') {
			const list = Array.isArray(data)
				? data
				: Array.isArray((data as { data?: unknown })?.data)
					? (data as { data: unknown[] }).data
					: [];
			setMessages(list as ChatMessage[]);
		} else if (requestType === 'agent.list') {
			setAgents(Array.isArray(data) ? data as AgentInfo[] : []);
		} else if (requestType === 'provider.list') {
			setProviders(data ?? {});
		} else if (requestType === 'find.files') {
			const files = Array.isArray(data) ? (data as string[]).slice(0, 8) : [];
			setMentions(current => mergeMentions(current.filter(item => item.kind !== 'file'), files.map(file => ({
				kind: 'file' as const,
				label: file,
				insert: file,
				detail: 'file',
			}))));
		} else if (requestType === 'find.symbols') {
			const symbols = Array.isArray(data) ? data as Array<{ name?: string; location?: { uri?: string } }> : [];
			setMentions(current => mergeMentions(current.filter(item => item.kind !== 'symbol'), symbols.slice(0, 8).map(symbol => ({
				kind: 'symbol' as const,
				label: symbol.name || 'symbol',
				insert: symbol.name || '',
				detail: symbol.location?.uri ? basenameOf(symbol.location.uri) : 'symbol',
			}))));
		} else if (requestType === 'session.diff') {
			setReviewDiffs(Array.isArray(data) ? data as FileDiff[] : []);
		} else if (requestType === 'command.list') {
			const items = Array.isArray(data) ? data as Array<{ name?: string; description?: string; title?: string }> : [];
			upsertSlash(items.filter(item => item.name).map(item => ({ kind: 'command', name: item.name!, description: item.description || item.title })));
		} else if (requestType === 'skill.list') {
			const items = Array.isArray(data) ? data as Array<{ name?: string; description?: string }> : [];
			upsertSlash(items.filter(item => item.name).map(item => ({ kind: 'skill', name: item.name!, description: item.description })));
		} else if (requestType === 'permission.list') {
			setPermissions(Array.isArray(data) ? data as PermissionRequest[] : []);
		} else if (requestType === 'question.list') {
			setQuestions(Array.isArray(data) ? data as QuestionRequest[] : []);
		} else if (requestType === 'question.reply' || requestType === 'question.reject') {
			vscode.postMessage({ type: 'question.list' });
			if (active()) {
				vscode.postMessage({ type: 'session.messages', sessionID: active() });
			}
		} else if (requestType === 'permission.reply') {
			vscode.postMessage({ type: 'permission.list' });
		} else if (requestType === 'session.delete' || requestType === 'session.close') {
			const id = (data as { sessionID?: string })?.sessionID;
			const current = tabs();
			const remaining = current.filter(tab => tab.id !== id);
			setTabs(remaining);
			if (requestType === 'session.delete') {
				vscode.postMessage({ type: 'session.list', search: historyQuery() });
			}
			if (active() === id) {
				const next = remaining[remaining.length - 1];
				if (next) {
					selectTab(next.id);
				} else {
					setActive(undefined);
					setMessages([]);
					createSession();
				}
			}
		}
	}

	function handleEvent(payload: unknown) {
		const event = payload as { type?: string; properties?: { part?: ChatPart } };
		const eventType = String(event?.type ?? '');
		const sessionID = eventSessionID(payload);
		if (sessionID && sessionID !== active()) {
			if (eventType.includes('permission')) {
				vscode.postMessage({ type: 'permission.list' });
			}
			if (eventType.includes('question')) {
				vscode.postMessage({ type: 'question.list' });
			}
			return;
		}
		const streamed = applyChatEvent(messages(), payload);
		if (streamed) {
			setMessages(streamed);
		} else if ((eventType.includes('part') && eventType !== 'message.part.delta') || event?.properties?.part) {
			if (active()) {
				vscode.postMessage({ type: 'session.messages', sessionID: active() });
			}
		}
		if (eventType.includes('part') && eventType !== 'message.part.delta' && active()) {
			vscode.postMessage({ type: 'session.diff', sessionID: active() });
		}
		if (event?.properties?.part?.tool === 'question' || eventType.includes('question')) {
			vscode.postMessage({ type: 'question.list' });
		}
		if (eventType.includes('permission')) {
			vscode.postMessage({ type: 'permission.list' });
		}
		if (eventType.includes('session.status') || eventType === 'session.idle') {
			if (active()) {
				vscode.postMessage({ type: 'session.messages', sessionID: active() });
				vscode.postMessage({ type: 'session.diff', sessionID: active() });
			}
			if (!sessionQuestions().length) {
				setBusy(false);
			}
		}
	}

	function createSession() {
		setError('');
		setHistoryOpen(false);
		const ref = parseModelRef(model());
		vscode.postMessage({
			type: 'session.create',
			agent: agent(),
			model: ref ? { id: ref.modelID, providerID: ref.providerID, variant: effort() } : undefined,
		});
	}

	function selectTab(id: string) {
		if (active() === id) {
			return;
		}
		setHistoryOpen(false);
		setBusy(false);
		setActive(id);
		setMessages([]);
		setReviewDiffs([]);
		vscode.postMessage({ type: 'session.messages', sessionID: id });
		vscode.postMessage({ type: 'session.diff', sessionID: id });
		vscode.postMessage({ type: 'question.list' });
	}

	function closeTab(id: string) {
		setHistoryOpen(false);
		if (busy() && active() === id) {
			vscode.postMessage({ type: 'session.abort', sessionID: id });
			setBusy(false);
		}
		vscode.postMessage({ type: 'session.close', sessionID: id });
	}

	function promptSession(sessionID: string, text: string, parts: PendingPrompt['parts']) {
		const ref = parseModelRef(model());
		setBusy(true);
		setMessages(current => [...current, { info: { role: 'user' }, parts }]);
		vscode.postMessage({
			type: 'session.prompt',
			sessionID,
			text,
			agent: agent(),
			variant: effort(),
			model: ref ? { providerID: ref.providerID, modelID: ref.modelID } : undefined,
			parts,
		});
	}

	function send() {
		const text = draft().trim();
		if (!text && !attachments().length) {
			return;
		}
		setError('');
		const parts = [
			...(text ? [{ type: 'text' as const, text }] : []),
			...attachments(),
		];
		setDraft('');
		setAttachments([]);
		setSlashOpen(false);
		closePicker();
		const sessionID = active();
		if (!sessionID) {
			pendingPrompt = { text, parts };
			setBusy(true);
			createSession();
			return;
		}
		promptSession(sessionID, text, parts);
	}

	function onDraftInput(value: string) {
		setDraft(value);
		const at = value.match(/@([^\s]*)$/);
		if (at) {
			vscode.postMessage({ type: 'find.files', query: at[1] });
			vscode.postMessage({ type: 'find.symbols', query: at[1] });
		} else {
			setMentions([]);
		}
		const slashMatch = value.match(/(^|\s)\/([^\s]*)$/);
		if (slashMatch) {
			const q = (slashMatch[2] ?? '').toLowerCase();
			setSlash(slashCatalog.filter(item => item.name.toLowerCase().includes(q)).slice(0, 12));
			setSlashOpen(true);
		} else {
			setSlashOpen(false);
		}
	}

	function applySlash(item: SlashItem) {
		const sessionID = active();
		if (!sessionID) {
			setError('Start a chat before running a skill or command.');
			setSlashOpen(false);
			return;
		}
		const rest = draft().replace(/(^|\s)\/([^\s]*)$/, ' ').trim();
		setBusy(true);
		vscode.postMessage({
			type: 'session.command',
			sessionID,
			command: item.name,
			arguments: rest,
			agent: agent(),
			variant: effort(),
		});
		setDraft('');
		setSlashOpen(false);
		closePicker();
		setMessages(current => [...current, { info: { role: 'user' }, parts: [{ type: 'text', text: `/${item.name} ${rest}`.trim() }] }]);
	}

	function dictate() {
		const Speech = (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition
			?? (window as unknown as { SpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition;
		if (!Speech) {
			setError('Voice input is not available in this panel.');
			return;
		}
		const rec = new Speech();
		rec.lang = 'en-US';
		rec.onresult = event => {
			const said = Array.from(event.results).map(result => result[0]?.transcript ?? '').join(' ');
			setDraft(current => `${current}${current ? ' ' : ''}${said}`);
		};
		rec.start();
	}

	async function addImageFiles(files: File[]) {
		if (!files.length) {
			return;
		}
		let rejected = false;
		let readFailed = false;
		let remaining = MAX_IMAGE_ATTACHMENTS - attachments().length;
		for (const file of files) {
			if (remaining <= 0) {
				setError(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
				break;
			}
			let attachment: Awaited<ReturnType<typeof fileToImageAttachment>>;
			try {
				attachment = await fileToImageAttachment(file);
			} catch {
				readFailed = true;
				continue;
			}
			if (!attachment) {
				rejected = true;
				continue;
			}
			setAttachments(current => [...current, attachment]);
			remaining -= 1;
		}
		if (readFailed) {
			setError('Could not read one or more image attachments. Please try again.');
		} else if (rejected) {
			setError(UNSUPPORTED_ATTACHMENT_MESSAGE);
		}
	}

	function onFiles(files: FileList | null) {
		if (!files?.length) {
			return;
		}
		void addImageFiles(Array.from(files));
	}

	async function handleComposerPaste(event: ClipboardEvent) {
		if (!hasClipboardFiles(event)) {
			return;
		}
		event.preventDefault();
		await addImageFiles(clipboardFiles(event));
	}

	function handleComposerDragOver(event: DragEvent) {
		if (!dragEventFiles(event).length) {
			return;
		}
		event.preventDefault();
	}

	async function handleComposerDrop(event: DragEvent) {
		const files = dragEventFiles(event);
		if (!files.length) {
			return;
		}
		event.preventDefault();
		await addImageFiles(files);
	}

	function groupedHistory() {
		const now = Date.now();
		const items = history().filter(item => (item.title ?? '').toLowerCase().includes(historyQuery().toLowerCase()));
		const live = items.filter(item => !item.time?.archived);
		const archived = items.filter(item => item.time?.archived);
		const yesterday = now - 36 * 60 * 60 * 1000;
		return {
			recent: live.filter(item => (item.time?.updated ?? now) >= yesterday),
			older: live.filter(item => (item.time?.updated ?? now) < yesterday),
			archived,
		};
	}

	const sessionPermissions = createMemo(() => permissions().filter(item => !active() || item.sessionID === active()));
	const sessionQuestions = createMemo(() => questions().filter(item => !active() || !item.sessionID || item.sessionID === active()));
	const unmatchedQuestions = createMemo(() => {
		const parts = messages().flatMap(message => message.parts ?? []);
		const questionParts = parts.filter(part => isQuestionTool(part.tool));
		const latestQuestion = questionParts[questionParts.length - 1];
		return sessionQuestions().filter(request => {
			const callID = request.tool?.callID;
			if (callID && parts.some(part => part.callID === callID)) {
				return false;
			}
			if (latestQuestion && isCancelledStatus(latestQuestion.state?.status) && (!callID || callID === latestQuestion.callID || sessionQuestions().length === 1)) {
				return false;
			}
			if (callID) {
				return true;
			}
			return questionParts.length === 0;
		});
	});
	const showWorking = createMemo(() => {
		if (!busy() || sessionQuestions().length) {
			return false;
		}
		const msgs = messages();
		const last = msgs[msgs.length - 1];
		const parts = last?.parts ?? [];
		if (parts.some(part => (part.type === 'text' || part.type === 'reasoning') && !!part.text?.trim())) {
			return false;
		}
		return !parts.some(part => part.state?.status === 'running' || part.state?.status === 'pending');
	});
	let timeline: HTMLDivElement | undefined;
	let tabsList: HTMLDivElement | undefined;
	createEffect(() => {
		messages();
		busy();
		queueMicrotask(() => {
			if (timeline) {
				timeline.scrollTop = timeline.scrollHeight;
			}
		});
	});
	createEffect(() => {
		active();
		tabs();
		queueMicrotask(() => {
			tabsList?.querySelector<HTMLElement>('.lens-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
		});
	});

	return (
		<div class="lens-root">
			<ImageLightbox />
			<Show when={!booted()}>
				<div class="lens-status">Loading…</div>
			</Show>
			<Show when={booted() && !engine()}>
				<div class="lens-status">Lens engine is not running. Run “Lens: Configure LiteLLM Connection” from the Command Palette.</div>
			</Show>
			<Show when={booted() && engine()}>
				<header class="lens-tabs" aria-label="Chats">
					<div
						class="lens-tabs-list"
						role="tablist"
						ref={el => { tabsList = el; }}
						onWheel={event => {
							if (!tabsList || event.deltaY === 0 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) {
								return;
							}
							tabsList.scrollLeft += event.deltaY;
							event.preventDefault();
						}}
					>
						<Show when={tabs().length} fallback={
							<div class="lens-tab active" role="tab" aria-selected="true">
								<ChatTabIcon />
								<span class="lens-tab-label">New chat</span>
							</div>
						}>
							<For each={tabs()}>
								{tab => (
									<div
										class={`lens-tab ${active() === tab.id ? 'active' : ''}`}
										role="tab"
										aria-selected={active() === tab.id}
										title={formatSessionTitle(tab.title) || 'New chat'}
										onClick={() => selectTab(tab.id)}
									>
										<ChatTabIcon />
										<span class="lens-tab-label">{formatSessionTitle(tab.title) || 'New chat'}</span>
										<button
											type="button"
											class="lens-tab-close"
											title="Close chat"
											aria-label="Close chat"
											onClick={event => {
												event.stopPropagation();
												closeTab(tab.id);
											}}
										>
											<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="m8 8.7 3.1 3.1a.5.5 0 0 0 .7-.7L8.7 8l3.1-3.1a.5.5 0 0 0-.7-.7L8 7.3 4.9 4.2a.5.5 0 1 0-.7.7L7.3 8l-3.1 3.1a.5.5 0 0 0 .7.7L8 8.7Z" /></svg>
										</button>
									</div>
								)}
							</For>
						</Show>
					</div>
					<div class="lens-header-actions">
						<button type="button" class="lens-icon-btn" title="New Chat" onClick={() => createSession()}>
							<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8.5 2.5a.5.5 0 0 0-1 0V7.5H2.5a.5.5 0 0 0 0 1H7.5v5a.5.5 0 0 0 1 0V8.5h5a.5.5 0 0 0 0-1H8.5V2.5Z" /></svg>
						</button>
						<button
							type="button"
							class={`lens-icon-btn ${historyOpen() ? 'active' : ''}`}
							title="History"
							onClick={() => {
								const next = !historyOpen();
								setHistoryOpen(next);
								if (next) {
									vscode.postMessage({ type: 'session.list', search: historyQuery() });
								}
							}}
						>
							<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 2.5A5.5 5.5 0 1 1 2.5 8H1.09A6.5 6.5 0 1 0 3.5 3.06L2.28 4.28H5.5v-1H1.5v4h1V4.56l1.47-1.47A5.48 5.48 0 0 1 8 2.5Zm.75 2.75v2.88l2.03 1.22-.5.86L7.25 8.5V5.25h1.5Z" /></svg>
						</button>
					</div>
				</header>
				<Show when={historyOpen()}>
					<div class="lens-history">
						<input class="lens-history-search" placeholder="Search chats" value={historyQuery()} onInput={event => {
							const value = event.currentTarget.value;
							setHistoryQuery(value);
							vscode.postMessage({ type: 'session.list', search: value });
						}} />
						<For each={['recent', 'older', 'archived'] as const}>
							{group => (
								<Show when={groupedHistory()[group].length}>
									<div class="lens-history-group">{group}</div>
									<For each={groupedHistory()[group]}>
										{item => (
											<div class="lens-history-item">
												<button class="lens-history-open" onClick={() => {
													if (!tabs().some(tab => tab.id === item.id)) {
														setTabs(current => [...current, { id: item.id, title: item.title || 'Chat' }]);
													}
													selectTab(item.id);
													setHistoryOpen(false);
												}}>{item.title ? formatSessionTitle(item.title) : item.id}</button>
												<span class="lens-history-actions">
													<button class="lens-text-btn" onClick={() => vscode.postMessage({ type: 'session.update', sessionID: item.id, archived: true })}>Archive</button>
													<button class="lens-text-btn" onClick={() => vscode.postMessage({ type: 'session.delete', sessionID: item.id })}>Delete</button>
												</span>
											</div>
										)}
									</For>
								</Show>
							)}
						</For>
					</div>
				</Show>
				<div class="lens-timeline" ref={timeline} onClick={event => {
					handleImageThumbClick(event);
					handleCodeCopyClick(event);
				}}>
					<Show when={!active() && !messages().length}>
						<div class="lens-empty" />
					</Show>
					<For each={messages()}>
						{(message, index) => (
							<ChatRow busy={busy()} isLast={index() === messages().length - 1} message={message} questions={sessionQuestions()} />
						)}
					</For>
					<For each={unmatchedQuestions()}>
						{request => (
							<div class="lens-row lens-row-assistant">
								<QuestionCard request={request} status="running" />
							</div>
						)}
					</For>
					<Show when={showWorking()}>
						<div class="lens-working">
							<span class="lens-spinner" />
							Working…
						</div>
					</Show>
				</div>
				<Show when={sessionPermissions().length}>
					<div class="lens-dock">
						<For each={sessionPermissions()}>
							{request => (
								<div class="lens-card">
									<div>
										<strong>Permission: {request.permission ?? request.id}</strong>
										<div class="lens-muted">{(request.patterns ?? []).join(', ')}</div>
									</div>
									<span>
										<button class="lens-pill" onClick={() => vscode.postMessage({ type: 'permission.reply', requestID: request.id, reply: 'once' })}>Allow</button>
										<button class="lens-pill" onClick={() => vscode.postMessage({ type: 'permission.reply', requestID: request.id, reply: 'always' })}>Always</button>
										<button class="lens-pill" onClick={() => vscode.postMessage({ type: 'permission.reply', requestID: request.id, reply: 'reject' })}>Reject</button>
									</span>
								</div>
							)}
						</For>
					</div>
				</Show>
				<Show when={reviewDiffs().length}>
					<div class="lens-dock">
						<button class="lens-review-toggle" type="button" onClick={() => setReviewOpen(open => !open)}>
							<strong>Plan review</strong>
							<span class="lens-muted">{reviewDiffs().length} file{reviewDiffs().length === 1 ? '' : 's'} changed</span>
							<span class="lens-muted">{reviewOpen() ? 'Hide' : 'Show'}</span>
						</button>
						<Show when={reviewOpen()}>
							<For each={reviewDiffs()}>
								{file => (
									<button class="lens-review-file" type="button" onClick={() => vscode.postMessage({ type: 'file.open', path: file.path })}>
										<span>{file.path}</span>
										<span class="lens-muted">{file.status ?? 'modified'} +{file.additions ?? 0} −{file.deletions ?? 0}</span>
									</button>
								)}
							</For>
						</Show>
					</div>
				</Show>
				<Show when={error()}>
					<div class="lens-error">{error()}</div>
				</Show>
				<div class="lens-composer">
					<Show when={mentions().length}>
						<div class="lens-suggest">
							<For each={mentions()}>
								{item => (
									<button class="lens-suggest-item" onClick={() => {
										setDraft(current => current.replace(/@([^\s]*)$/, `@${item.insert} `));
										setMentions([]);
									}}>
										<span>@{item.label}</span>
										<span class="lens-muted">{item.kind}{item.detail ? ` · ${item.detail}` : ''}</span>
									</button>
								)}
							</For>
						</div>
					</Show>
					<Show when={slashOpen() && slash().length}>
						<div class="lens-slash">
							<For each={slash()}>
								{item => (
									<button class="lens-slash-item" onClick={() => applySlash(item)}>
										<span>/{item.name}</span>
										<span class="lens-muted">{item.kind} {item.description ?? ''}</span>
									</button>
								)}
							</For>
						</div>
					</Show>
					<div
						class="lens-composer-box"
						onClick={handleImageThumbClick}
						onPaste={handleComposerPaste}
						onDragOver={handleComposerDragOver}
						onDrop={handleComposerDrop}
					>
						<Show when={attachments().length}>
							<div class="lens-image-row lens-attachments">
								<For each={attachments()}>
									{file => (
										<Show when={isImagePart(file) && file.url} fallback={
											<span class="lens-chip">{file.filename || 'attachment'} <button type="button" class="lens-text-btn" onClick={() => setAttachments(current => current.filter(item => item !== file))}>×</button></span>
										}>
											<span class="lens-attachment-thumb">
												<img
													class="lens-image-thumb"
													src={file.url}
													alt={file.filename || 'image'}
													role="button"
													tabindex="0"
													draggable={false}
												/>
												<button
													type="button"
													class="lens-attachment-remove"
													title="Remove"
													aria-label={`Remove ${file.filename || 'attachment'}`}
													onClick={event => {
														event.preventDefault();
														event.stopPropagation();
														setAttachments(current => current.filter(item => item !== file));
													}}
												>×</button>
											</span>
										</Show>
									)}
								</For>
							</div>
						</Show>
						<textarea
							class="lens-input"
							placeholder="Ask Lens to plan or build…"
							rows={2}
							value={draft()}
							onInput={event => onDraftInput(event.currentTarget.value)}
							onKeyDown={event => {
								if (event.key === 'Enter' && !event.shiftKey) {
									event.preventDefault();
									if (busy()) return;
									send();
								}
							}}
						/>
						<Show when={picker()}>
							<div class="lens-picker-panel" role="menu">
								<Show when={picker() === 'agent'}>
									<For each={visibleAgents()}>
										{name => (
											<button
												type="button"
												role="menuitem"
												class={`lens-picker-item ${agent() === name ? 'selected' : ''}`}
												onClick={() => {
													setAgent(name);
													closePicker();
												}}
											>
												{agentDisplayName(name)}
											</button>
										)}
									</For>
								</Show>
								<Show when={picker() === 'model' && modelPanelView() === 'main'}>
									<button
										type="button"
										role="menuitem"
										class="lens-picker-row"
										onClick={() => setModelPanelView('effort')}
									>
										<span>Effort</span>
										<span class="lens-picker-value">{titleCaseEffort(effort())} <ChevronRight /></span>
									</button>
									<button
										type="button"
										role="menuitem"
										class="lens-picker-row"
										onClick={() => setModelPanelView('model')}
									>
										<span>Model</span>
										<span class="lens-picker-value">{currentModelLabel()} <ChevronRight /></span>
									</button>
								</Show>
								<Show when={picker() === 'model' && modelPanelView() === 'effort'}>
									<button
										type="button"
										class="lens-picker-row lens-picker-back"
										onClick={() => setModelPanelView('main')}
									>
										<span class="lens-picker-back-label"><ChevronLeft /> Effort</span>
									</button>
									<For each={EFFORTS}>
										{value => (
											<button
												type="button"
												role="menuitem"
												class={`lens-picker-item ${effort() === value ? 'selected' : ''}`}
												onClick={() => {
													setEffort(value);
													setModelPanelView('main');
												}}
											>
												{titleCaseEffort(value)}
											</button>
										)}
									</For>
								</Show>
								<Show when={picker() === 'model' && modelPanelView() === 'model'}>
									<button
										type="button"
										class="lens-picker-row lens-picker-back"
										onClick={() => setModelPanelView('main')}
									>
										<span class="lens-picker-back-label"><ChevronLeft /> Model</span>
									</button>
									<Show when={showModelSearch()}>
										<input
											class="lens-model-search"
											placeholder="Search models…"
											value={modelQuery()}
											onInput={event => setModelQuery(event.currentTarget.value)}
										/>
									</Show>
									<Show when={groupedPickerModels().length} fallback={
										<div class="lens-picker-empty">No models match your search.</div>
									}>
										<For each={groupedPickerModels()}>
											{(group: ModelGroup) => (
												<div class="lens-model-group">
													<div class="lens-model-group-label">{group.label}</div>
													<For each={group.choices}>
														{choice => (
															<button
																type="button"
																role="menuitem"
																class={`lens-picker-item lens-picker-model-item ${model() === choice.value ? 'selected' : ''}`}
																onClick={() => {
																	setModel(choice.value);
																	setModelPanelView('main');
																}}
															>
																<span class="lens-picker-model-name">{choice.label}</span>
																<span class="lens-picker-model-id">{choice.modelId}</span>
															</button>
														)}
													</For>
												</div>
											)}
										</For>
									</Show>
								</Show>
							</div>
						</Show>
						<div class="lens-composer-toolbar">
							<button
								type="button"
								class={`lens-picker-trigger ${picker() === 'agent' ? 'open' : ''}`}
								aria-haspopup="menu"
								aria-expanded={picker() === 'agent'}
								title={agentTriggerLabel()}
								onClick={() => togglePicker('agent')}
							>
								<span class="lens-picker-trigger-label">{agentTriggerLabel()}</span>
								<ChevronDown />
							</button>
							<button
								type="button"
								class={`lens-picker-trigger lens-picker-trigger-model ${picker() === 'model' ? 'open' : ''}`}
								aria-haspopup="menu"
								aria-expanded={picker() === 'model'}
								title={currentModelLabel()}
								onClick={() => togglePicker('model')}
							>
								<span class="lens-picker-trigger-label">{currentModelLabel()}</span>
								<ChevronDown />
							</button>
							<span class="lens-effort-chip" aria-hidden="true">{effort()}</span>
							<span class="lens-toolbar-spacer" />
							<button class="lens-icon-btn" title="Attach" onClick={() => fileInput?.click()}>
								<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M10.3 2.54a2.75 2.75 0 0 1 3.89 3.89l-6.4 6.4a3.75 3.75 0 0 1-5.3-5.3l5.48-5.48a.75.75 0 0 1 1.06 1.06L4.55 8.59a2.25 2.25 0 0 0 3.18 3.18l6.4-6.4a1.25 1.25 0 1 0-1.77-1.77L6.54 9.42a.75.75 0 1 1-1.06-1.06l5.82-5.82Z" /></svg>
							</button>
							<input
								ref={fileInput}
								type="file"
								multiple
								accept={IMAGE_ATTACHMENT_ACCEPT}
								hidden
								onChange={event => {
									onFiles(event.currentTarget.files);
									event.currentTarget.value = '';
								}}
							/>
							<button class="lens-icon-btn" title="Voice" onClick={dictate}>
								<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 1 0 4 0v-4a2 2 0 0 0-2-2Zm-3.5 6a.75.75 0 0 0-1.5 0 5 5 0 0 0 4.25 4.94V14H5.75a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5H8.75v-1.56A5 5 0 0 0 13 7.5a.75.75 0 0 0-1.5 0 3.5 3.5 0 1 1-7 0Z" /></svg>
							</button>
							<button
								class={`lens-send-btn ${busy() ? 'stop' : ''}`}
								title={busy() ? 'Stop' : 'Send'}
								disabled={!busy() && !draft().trim() && !attachments().length}
								onClick={() => busy() ? vscode.postMessage({ type: 'session.abort', sessionID: active() }) : send()}
							>
								<Show when={!busy()} fallback={<span class="lens-stop-icon" />}>
									<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M3.2 7.25h7.04L7.12 4.13a.75.75 0 1 1 1.06-1.06l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 1 1-1.06-1.06l3.12-3.12H3.2a.75.75 0 0 1 0-1.5Z" /></svg>
								</Show>
							</button>
						</div>
					</div>
				</div>
			</Show>
		</div>
	);
}

function ChatTabIcon() {
	return (
		<svg class="lens-tab-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<path fill="currentColor" d="M14 1H4L3 2v8l1 1h1v3.1L8.1 11H14l1-1V2l-1-1Zm0 9H7.9L6 11.9V10H4V2h10v8Z" />
		</svg>
	);
}

function ChevronDown() {
	return (
		<svg class="lens-picker-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
			<path fill="currentColor" d="M2.6 4.2a.6.6 0 0 1 .85-.05L6 6.5l2.55-2.35a.6.6 0 0 1 .8.9l-2.95 2.7a.6.6 0 0 1-.8 0L2.65 5.05a.6.6 0 0 1-.05-.85Z" />
		</svg>
	);
}

function ChevronRight() {
	return (
		<svg class="lens-picker-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
			<path fill="currentColor" d="M4.2 2.6a.6.6 0 0 1 .85-.05L7.7 5.2a.6.6 0 0 1 0 .8L5.05 9.35a.6.6 0 1 1-.8-.9L6.5 6 4.15 3.45a.6.6 0 0 1 .05-.85Z" />
		</svg>
	);
}

function ChevronLeft() {
	return (
		<svg class="lens-picker-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
			<path fill="currentColor" d="M7.8 2.6a.6.6 0 0 1 .05.85L5.5 6l2.35 2.55a.6.6 0 1 1-.9.8L4.3 6.4a.6.6 0 0 1 0-.8l2.65-2.95a.6.6 0 0 1 .85-.05Z" />
		</svg>
	);
}

function agentDisplayName(name: string): string {
	if (name === 'plan') {
		return 'Plan';
	}
	if (name === 'build') {
		return 'Agent';
	}
	return name;
}

function titleCaseEffort(value: string): string {
	if (value === 'xhigh') {
		return 'Extra high';
	}
	return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function parseModelRef(value: string): { providerID: string; modelID: string } | undefined {
	const slash = value.indexOf('/');
	if (slash <= 0) {
		return undefined;
	}
	const providerID = value.slice(0, slash).trim();
	const modelID = value.slice(slash + 1).trim();
	if (!providerID || !modelID || /^\d+$/.test(providerID)) {
		return undefined;
	}
	return { providerID, modelID };
}

function readableError(message: unknown): string {
	const text = String(message ?? 'Something went wrong.');
	if (text.includes('{"_tag"') || text.includes('BadRequest')) {
		if (text.includes('/session') && !text.includes('/message')) {
			return 'Could not start a chat session. Pick a valid model and try again.';
		}
		return 'The engine rejected that request.';
	}
	return text;
}

function mergeMentions(current: MentionItem[], next: MentionItem[]): MentionItem[] {
	const seen = new Set(current.map(item => `${item.kind}:${item.insert}`));
	const merged = [...current];
	for (const item of next) {
		const key = `${item.kind}:${item.insert}`;
		if (!item.insert || seen.has(key)) {
			continue;
		}
		seen.add(key);
		merged.push(item);
	}
	return merged.slice(0, 12);
}

function basenameOf(uri: string): string {
	try {
		const path = uri.replace(/^file:\/\//, '');
		const parts = path.split(/[/\\]/);
		return parts[parts.length - 1] || uri;
	} catch {
		return uri;
	}
}

interface SpeechRecognition {
	lang: string;
	start(): void;
	onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
}
