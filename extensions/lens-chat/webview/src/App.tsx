import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { ChatRow } from './chat/ChatRow';
import { createCheckpoints, RewindBanner, RewindMenu } from './chat/Checkpoints';
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
import { ContextMeter } from './chat/ContextMeter';
import { autoCompactDecision, COMPACT_COMMAND, COMPACT_DESCRIPTION, contextUsage, normalizeThreshold } from './chat/contextMeter';
import { EXPORT_COMMAND, EXPORT_DESCRIPTION, transcriptToMarkdown } from './chat/exportChat';
import { FollowUpQueue } from './chat/FollowUpQueue';
import {
	createTurnBoundaryWatcher,
	dropFollowUps,
	editFollowUp,
	enqueueFollowUp,
	holdFollowUps,
	newFollowUpId,
	queuedFor,
	releaseFollowUps,
	removeFollowUp,
	restoreFollowUps,
	takeFollowUp,
	type FollowUpState,
} from './chat/followUps';
import { ExtensionsView } from './settings/ExtensionsView';
import { ProvidersView } from './settings/ProvidersView';
import { ProviderErrorView } from './chat/ProviderError';
import { appendMention, createEditorContext, EditorContextChip } from './chat/EditorContextChip';
import { readSavedState, saveState, vscode } from './vscode';

type Tab = { id: string; title: string };
type SlashItem = { kind: 'command' | 'skill'; name: string; description?: string };
type Attachment = { type: 'file'; mime: string; url: string; filename?: string };
type PendingPrompt = { text: string; parts: Array<{ type: 'text'; text: string } | Attachment>; imageWarning?: string };
type PendingCommand = { command: string; arguments: string };
type PermissionRequest = { id: string; sessionID?: string; permission?: string; patterns?: string[] };
type AgentInfo = { name?: string; mode?: string; hidden?: boolean };
type HistoryItem = { id: string; title?: string; time?: { updated?: number; archived?: number } };
type MentionItem = { kind: 'file' | 'symbol'; label: string; insert: string; detail?: string };
type FileDiff = { path: string; status?: string; additions?: number; deletions?: number };

const view = document.getElementById('root')?.dataset.view ?? 'chat';
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
// Speech recognition is missing in the Electron webview, so the Voice button is only shown where it can work.
const SpeechRecognitionCtor = (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition
	?? (window as unknown as { SpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition;
type PickerKind = 'agent' | 'model';

export function App() {
	if (view === 'providers') {
		return <ProvidersView />;
	}
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
	const [focusMode, setFocusMode] = createSignal(readSavedState().focusMode ?? false);
	const [history, setHistory] = createSignal<HistoryItem[]>([]);
	const [historyQuery, setHistoryQuery] = createSignal('');
	const [agents, setAgents] = createSignal<AgentInfo[]>([]);
	const [providers, setProviders] = createSignal<unknown>({});
	const [agent, setAgent] = createSignal('build');
	// Start from the model the user last picked, so a reload does not silently switch to the provider's first model.
	const [model, setModel] = createSignal(readSavedState().model ?? DEFAULT_MODEL);
	// The engine's pick (its newest model) for when the user has not chosen one yet.
	const [engineDefault, setEngineDefault] = createSignal<string | undefined>();
	// A failed reply already shows its error card; the banner would repeat it. Retries have no card, so they stay.
	const errorShownInConversation = createMemo(() => !error().startsWith('Retrying') && !!messages().at(-1)?.info?.error);
	const [effort, setEffort] = createSignal(readSavedState().effort ?? 'high');
	const [picker, setPicker] = createSignal<PickerKind | null>(null);
	const [modelPanelView, setModelPanelView] = createSignal<'main' | 'effort' | 'model'>('main');
	const [modelQuery, setModelQuery] = createSignal('');
	const [mentions, setMentions] = createSignal<MentionItem[]>([]);
	const [reviewDiffs, setReviewDiffs] = createSignal<FileDiff[]>([]);
	const [reviewOpen, setReviewOpen] = createSignal(false);
	const [deleteConfirm, setDeleteConfirm] = createSignal<{ id: string; title: string } | null>(null);
	const [slash, setSlash] = createSignal<SlashItem[]>([]);
	const [slashOpen, setSlashOpen] = createSignal(false);
	const [attachments, setAttachments] = createSignal<Attachment[]>([]);
	// The active file or selection offered by the extension host (already checked against the exclusion rules).
	const editorContext = createEditorContext();
	const [permissions, setPermissions] = createSignal<PermissionRequest[]>([]);
	const [questions, setQuestions] = createSignal<QuestionRequest[]>([]);
	const checkpoints = createCheckpoints({
		active,
		messages,
		openSession: (id, title) => {
			setTabs(current => current.some(tab => tab.id === id) ? current : [...current, { id, title }]);
			selectTab(id);
		},
		setError: message => setError(message),
		restoreDraft: text => {
			if (!draft().trim()) {
				setDraft(text);
			}
		},
	});
	let fileInput: HTMLInputElement | undefined;
	let pendingPrompt: PendingPrompt | undefined;
	let pendingCommand: PendingCommand | undefined;
	// Restoring open tabs happens once, off the first session.list reply after boot.
	let restoreTabsOnBoot = false;
	// Counts turns the user starts, so a status reply requested before a new turn began cannot mark it idle.
	let turnSeq = 0;
	let statusSeq = -1;
	// `/compact` is Lens's own: it runs through the engine's summarize route, not as a prompt or engine command.
	const slashCatalog: SlashItem[] = [
		{ kind: 'command', name: COMPACT_COMMAND, description: COMPACT_DESCRIPTION },
		{ kind: 'command', name: EXPORT_COMMAND, description: EXPORT_DESCRIPTION },
	];
	// Messages sent while a turn runs, per session; each goes out when its session's run ends.
	const [followUps, setFollowUps] = createSignal<FollowUpState>(restoreFollowUps(readSavedState().followUps));
	const activeFollowUps = createMemo(() => queuedFor(followUps(), active()));
	const turnBoundaries = createTurnBoundaryWatcher(sessionID => sendNextFollowUp(sessionID));
	onCleanup(() => turnBoundaries.dispose());
	createEffect(() => saveState({ followUps: followUps().queued }));

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
	// Undefined (model list not loaded yet, or model unrecognized) means "don't warn"; only an explicit false blocks images.
	const currentModelSupportsImage = createMemo(() => modelChoices().find(choice => choice.value === model())?.supportsImage);
	// Context meter: the last reply's tokens against its model's context window (from the provider list).
	const [autoCompactThreshold, setAutoCompactThreshold] = createSignal(0);
	const contextLimitFor = (providerID: string, modelID: string) => modelChoices().find(choice => choice.value === `${providerID}/${modelID}`
		|| (choice.value.startsWith(`${providerID}/`) && choice.modelId === modelID))?.contextLimit;
	const currentContextUsage = createMemo(() => active() ? contextUsage(messages(), contextLimitFor) : undefined);
	const currentModelLabel = createMemo(() => pickerModels().find(choice => choice.value === model())?.label ?? shortModelLabel(model()));
	const agentTriggerLabel = createMemo(() => agentDisplayName(agent()));

	createEffect(() => {
		const choices = modelChoices();
		if (!choices.length) {
			return;
		}
		const next = resolvePreferredModel(choices, model(), engineDefault()?.replace(/^lens\//, ''));
		if (next && next !== model()) {
			setModel(next);
		}
	});

	// Remember which tabs are open so a reload can bring them back instead of leaving an empty "New chat".
	// Held off until the boot-time restore has run (or was never needed), so a fresh webview's initial
	// empty tab list does not overwrite the saved one before it gets a chance to be read back.
	const [readyToPersistTabs, setReadyToPersistTabs] = createSignal(false);
	createEffect(() => {
		if (!readyToPersistTabs()) {
			return;
		}
		saveState({ openTabs: tabs().map(tab => tab.id), activeTab: active() });
	});

	onMount(() => {
		const onMessage = (event: MessageEvent) => {
			const data = event.data;
			if (!data || typeof data !== 'object') return;
			if (data.type === 'boot') {
				setBooted(true);
				setEngine(!!data.runtime);
				setEngineDefault(typeof data.runtime?.defaultModel === 'string' ? data.runtime.defaultModel : undefined);
				if (data.runtime) {
					restoreTabsOnBoot = true;
					vscode.postMessage({ type: 'agent.list' });
					vscode.postMessage({ type: 'provider.list' });
					vscode.postMessage({ type: 'session.list' });
					vscode.postMessage({ type: 'command.list' });
					vscode.postMessage({ type: 'skill.list' });
					vscode.postMessage({ type: 'permission.list' });
					vscode.postMessage({ type: 'question.list' });
				} else {
					setReadyToPersistTabs(true);
				}
			} else if (data.type === 'error') {
				pendingPrompt = undefined;
				if (active()) {
					setFollowUps(state => holdFollowUps(state, active()!));
				}
				setBusy(false);
				setError(readableError(data.message));
			} else if (data.type === 'result') {
				handleResult(data.requestType, data.data);
			} else if (data.type === 'event') {
				handleEvent(data.payload);
			} else if (data.type === 'editorContext') {
				editorContext.update(data.context);
			} else if (data.type === 'insertMention' && typeof data.text === 'string') {
				setDraft(current => appendMention(current, data.text));
				const input = document.querySelector<HTMLTextAreaElement>('textarea.lens-input');
				input?.focus();
				input?.setSelectionRange(draft().length, draft().length);
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
		vscode.postMessage({ type: 'chat.settings' });
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
				if (deleteConfirm()) {
					setDeleteConfirm(null);
					return;
				}
				if (picker()) {
					closePicker();
					return;
				}
				if (historyOpen()) {
					setHistoryOpen(false);
					return;
				}
				if (slashOpen() || mentions().length) {
					setSlashOpen(false);
					setMentions([]);
					return;
				}
				// Last fallback: Escape in the composer stops the running turn, as the Stop button does.
				if (busy() && active() && (event.target as HTMLElement | null)?.closest?.('.lens-input')) {
					event.preventDefault();
					stopTurn();
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
		if (requestType === 'chat.settings') {
			setAutoCompactThreshold(normalizeThreshold((data as { autoCompactThreshold?: unknown } | undefined)?.autoCompactThreshold));
			return;
		}
		if (requestType === 'session.summarize') {
			const sessionID = (data as { sessionID?: string } | undefined)?.sessionID;
			if (sessionID && sessionID === active()) {
				syncBusy();
				vscode.postMessage({ type: 'session.messages', sessionID });
			}
			return;
		}
		if (checkpoints.handleResult(requestType, data)) {
			return;
		}
		if (requestType === 'session.create') {
			const session = data as { id?: string; title?: string };
			if (!session?.id) {
				pendingPrompt = undefined;
				pendingCommand = undefined;
				setBusy(false);
				setError('Could not start a chat session.');
				return;
			}
			setError('');
			setTabs(current => current.some(tab => tab.id === session.id) ? current : [...current, { id: session.id!, title: session.title || 'New chat' }]);
			setActive(session.id);
			setMessages([]);
			setReviewDiffs([]);
			const queuedPrompt = pendingPrompt;
			pendingPrompt = undefined;
			if (queuedPrompt) {
				promptSession(session.id!, queuedPrompt.text, queuedPrompt.parts);
				if (queuedPrompt.imageWarning) {
					setError(queuedPrompt.imageWarning);
				}
			}
			const queuedCommand = pendingCommand;
			pendingCommand = undefined;
			if (queuedCommand) {
				runCommand(session.id!, queuedCommand.command, queuedCommand.arguments);
			}
		} else if (requestType === 'session.status') {
			if (statusSeq !== turnSeq) {
				return;
			}
			const status = active() ? (data as Record<string, { type?: string }> | undefined)?.[active()!] : undefined;
			setBusy(!!status && status.type !== 'idle');
		} else if (requestType === 'session.list') {
			const list = Array.isArray(data) ? data as HistoryItem[] : [];
			setHistory(list);
			if (restoreTabsOnBoot) {
				restoreTabsOnBoot = false;
				const saved = readSavedState();
				const restored = (saved.openTabs ?? [])
					.map(id => list.find(item => item.id === id))
					.filter((item): item is HistoryItem => !!item)
					.map(item => ({ id: item.id, title: item.title || 'New chat' }));
				if (restored.length) {
					setTabs(restored);
					const activeId = saved.activeTab && restored.some(tab => tab.id === saved.activeTab) ? saved.activeTab : restored[0].id;
					setActive(activeId);
					syncBusy();
					vscode.postMessage({ type: 'session.messages', sessionID: activeId });
					vscode.postMessage({ type: 'session.diff', sessionID: activeId });
				}
				setReadyToPersistTabs(true);
			}
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
			if (id) {
				setFollowUps(state => dropFollowUps(state, id));
			}
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
		const event = payload as { type?: string; properties?: { part?: ChatPart; sessionID?: string; info?: { id?: string; title?: string }; error?: { name?: string; message?: string; data?: { message?: string } }; status?: { type?: string; attempt?: number; message?: string; next?: number } } };
		const eventType = String(event?.type ?? '');
		const sessionID = eventSessionID(payload);
		checkpoints.handleEvent(payload);
		// A failed run keeps its queued follow-ups for the user rather than sending them into the failure.
		if (eventType === 'session.error' && sessionID) {
			setFollowUps(state => holdFollowUps(state, sessionID));
		}
		turnBoundaries.observe(eventType, sessionID, event?.properties?.status?.type);
		if (eventType === 'session.updated') {
			// The engine names a session once it has enough of the conversation to summarize it; reflect
			// that in the tab regardless of which tab is currently active.
			const info = event.properties?.info;
			if (info?.id && info.title) {
				setTabs(current => current.map(tab => tab.id === info.id ? { ...tab, title: info.title! } : tab));
			}
		}
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
		if (eventType === 'session.error') {
			const failure = event?.properties?.error;
			const sessionID = event?.properties?.sessionID;
			if (!sessionID || sessionID === active()) {
				// A user-initiated Stop surfaces the same event as a real failure; the button already
				// shows the change, so this is not an error worth a card.
				if (failure?.name !== 'MessageAbortedError') {
					setError(String(failure?.data?.message ?? failure?.message ?? failure?.name ?? 'The model returned an error'));
				}
				// The engine keeps running after some errors (a context overflow is followed by compaction),
				// so ask for its status instead of assuming the run ended.
				syncBusy();
				if (active()) {
					vscode.postMessage({ type: 'session.messages', sessionID: active() });
				}
			}
		}
		if (eventType.startsWith('message.part') && error().startsWith('Retrying')) {
			setError('');
		}
		const status = event?.properties?.status;
		const ownSession = !event?.properties?.sessionID || event.properties.sessionID === active();
		if (eventType === 'session.status' && status?.type === 'retry' && ownSession) {
			// The provider refused the request and opencode is waiting to try again; say so instead of looking idle.
			const wait = status.next ? Math.max(0, Math.round((status.next - Date.now()) / 1000)) : undefined;
			setError(`Retrying (attempt ${status.attempt ?? 1}): ${status.message ?? 'the model provider returned an error'}${wait !== undefined ? ` Next try in ${wait}s.` : ''}`);
			setBusy(true);
			return;
		}
		if (eventType === 'session.status' && status?.type === 'busy' && ownSession) {
			setBusy(true);
			return;
		}
		if (eventType === 'permission.asked') {
			// A run waiting on the user is still running, and Stop must stay available.
			setBusy(true);
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
		// The active tab is already an unsent chat; reuse it instead of piling up empty sessions in History.
		if (active() && messages().length === 0 && tabs().some(tab => tab.id === active())) {
			return;
		}
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
		// The chat being opened may still be running (for example, waiting on a permission).
		syncBusy();
		setMessages([]);
		setReviewDiffs([]);
		vscode.postMessage({ type: 'session.messages', sessionID: id });
		vscode.postMessage({ type: 'session.diff', sessionID: id });
		vscode.postMessage({ type: 'question.list' });
	}

	function closeTab(id: string) {
		setHistoryOpen(false);
		setFollowUps(state => dropFollowUps(state, id));
		if (busy() && active() === id) {
			vscode.postMessage({ type: 'session.abort', sessionID: id });
			setBusy(false);
		}
		vscode.postMessage({ type: 'session.close', sessionID: id });
	}

	function syncBusy() {
		statusSeq = turnSeq;
		vscode.postMessage({ type: 'session.status' });
	}

	/** Stops the running turn. Its queued follow-ups stay on screen instead of starting a new run. */
	function stopTurn() {
		const sessionID = active();
		if (!sessionID) {
			return;
		}
		setFollowUps(state => holdFollowUps(state, sessionID));
		vscode.postMessage({ type: 'session.abort', sessionID });
	}

	/** Sends a session's oldest queued follow-up, at a turn boundary or when the user asks for it. */
	function sendNextFollowUp(sessionID: string, byUser = false) {
		const state = followUps();
		if (!byUser && state.held[sessionID]) {
			return;
		}
		if (sessionID === active() && busy()) {
			return;
		}
		if (!tabs().some(tab => tab.id === sessionID)) {
			setFollowUps(current => dropFollowUps(current, sessionID));
			return;
		}
		const { item, state: next } = takeFollowUp(releaseFollowUps(state, sessionID), sessionID);
		if (!item) {
			return;
		}
		setFollowUps(next);
		if (sessionID === active()) {
			setError(item.imageWarning ?? '');
			promptSession(sessionID, item.text, item.parts);
			return;
		}
		// A chat in another tab: nothing of it is on screen, so only the engine hears about it.
		const ref = parseModelRef(model());
		vscode.postMessage({
			type: 'session.prompt',
			sessionID,
			text: item.text,
			agent: agent(),
			variant: effort(),
			model: ref ? { providerID: ref.providerID, modelID: ref.modelID } : undefined,
			parts: item.parts,
		});
	}

	/** `/compact` (and auto-compaction): the engine replaces the conversation so far with a summary. */
	function compactSession(auto = false) {
		const sessionID = active();
		if (!sessionID || !messages().some(message => message.info?.role === 'assistant')) {
			setError('There is nothing to compact yet. Compacting summarizes a chat once it has replies.');
			return;
		}
		if (busy()) {
			setError('Wait for the current reply to finish, then run /compact.');
			return;
		}
		const ref = parseModelRef(model());
		if (!ref) {
			setError('Pick a model before compacting this chat.');
			return;
		}
		setError('');
		turnSeq++;
		setBusy(true);
		vscode.postMessage({ type: 'session.summarize', sessionID, model: ref, auto });
	}

	/** `/export`: the transcript is already loaded client-side, so it renders to Markdown here and hands it to the host to save. */
	function exportSession() {
		const sessionID = active();
		if (!sessionID || !messages().length) {
			setError('There is nothing to export yet.');
			return;
		}
		const title = tabs().find(tab => tab.id === sessionID)?.title;
		const markdown = transcriptToMarkdown(title ? formatSessionTitle(title) : 'Lens Chat', messages());
		vscode.postMessage({ type: 'chat.export', markdown, title: title ? formatSessionTitle(title) : 'lens-chat' });
	}

	// Auto-compaction: once a turn this view watched has settled, compact if the context is over the
	// threshold. The engine still compacts on its own mid-turn when the window is completely full.
	const watchedTurns = new Set<string>();
	const autoCompactedReplies = new Set<string>();
	createEffect(() => {
		const sessionID = active();
		if (!sessionID) {
			return;
		}
		if (busy()) {
			watchedTurns.add(sessionID);
			return;
		}
		if (!watchedTurns.has(sessionID)) {
			return;
		}
		const decision = autoCompactDecision(messages(), autoCompactThreshold(), contextLimitFor);
		if (decision === 'wait') {
			return;
		}
		watchedTurns.delete(sessionID);
		const replyID = messages().at(-1)?.info?.id;
		// A queued follow-up starts the next turn instead; that turn's end is checked again.
		if (decision !== 'compact' || activeFollowUps().length || (replyID && autoCompactedReplies.has(replyID))) {
			return;
		}
		if (replyID) {
			autoCompactedReplies.add(replyID);
		}
		compactSession(true);
	});

	function promptSession(sessionID: string, text: string, parts: PendingPrompt['parts']) {
		const ref = parseModelRef(model());
		turnSeq++;
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
		if (text === `/${COMPACT_COMMAND}` && !attachments().length) {
			setDraft('');
			setSlashOpen(false);
			compactSession();
			return;
		}
		if (text === `/${EXPORT_COMMAND}` && !attachments().length) {
			setDraft('');
			setSlashOpen(false);
			exportSession();
			return;
		}
		// The engine still strips unsupported images and tells the model, but the user should learn that too.
		// Set after createSession() below, since that clears the error banner on its own.
		const imageWarning = attachments().length && currentModelSupportsImage() === false
			? 'This model does not support image input; your images will be described to it as text instead.'
			: '';
		const contextPart = editorContext.take();
		const parts = [
			...(text ? [{ type: 'text' as const, text }] : []),
			...(contextPart ? [contextPart] : []),
			...attachments(),
		];
		setDraft('');
		setAttachments([]);
		setSlashOpen(false);
		closePicker();
		const sessionID = active();
		if (!sessionID) {
			// createSession() below clears the error banner; re-applied once its session.create reply lands.
			pendingPrompt = { text, parts, imageWarning };
			setBusy(true);
			createSession();
			return;
		}
		if (busy()) {
			// The agent is still working: queue this as a follow-up for when the turn ends.
			setFollowUps(state => enqueueFollowUp(state, sessionID, { id: newFollowUpId(), text, parts, imageWarning: imageWarning || undefined }));
			return;
		}
		setFollowUps(state => releaseFollowUps(state, sessionID));
		setError(imageWarning);
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

	function runCommand(sessionID: string, command: string, args: string) {
		turnSeq++;
		setBusy(true);
		vscode.postMessage({
			type: 'session.command',
			sessionID,
			command,
			arguments: args,
			agent: agent(),
			variant: effort(),
		});
		setMessages(current => [...current, { info: { role: 'user' }, parts: [{ type: 'text', text: `/${command} ${args}`.trim() }] }]);
	}

	function applySlash(item: SlashItem) {
		if (item.kind === 'command' && item.name === COMPACT_COMMAND) {
			setDraft('');
			setSlashOpen(false);
			closePicker();
			compactSession();
			return;
		}
		if (item.kind === 'command' && item.name === EXPORT_COMMAND) {
			setDraft('');
			setSlashOpen(false);
			closePicker();
			exportSession();
			return;
		}
		const rest = draft().replace(/(^|\s)\/([^\s]*)$/, ' ').trim();
		setDraft('');
		setSlashOpen(false);
		closePicker();
		const sessionID = active();
		if (!sessionID) {
			// A new, unsaved chat has no session yet: queue the command and create one first,
			// the same way send() queues a plain message.
			pendingCommand = { command: item.name, arguments: rest };
			setBusy(true);
			createSession();
			return;
		}
		runCommand(sessionID, item.name, rest);
	}

	function dictate() {
		if (!SpeechRecognitionCtor) {
			return;
		}
		const rec = new SpeechRecognitionCtor();
		rec.lang = 'en-US';
		rec.onresult = event => {
			const said = Array.from(event.results).map(result => result[0]?.transcript ?? '').join(' ');
			setDraft(current => `${current}${current ? ' ' : ''}${said}`);
		};
		rec.onerror = event => setError(`Voice input failed: ${event.error}`);
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

	const historyEmpty = createMemo(() => {
		const groups = groupedHistory();
		return !groups.recent.length && !groups.older.length && !groups.archived.length;
	});

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
				<div class="lens-status">
					<p>Lens isn't connected to a model yet.</p>
					<button class="lens-conn-primary" onClick={() => vscode.postMessage({ type: 'providers.open' })}>Set Up AI Providers</button>
				</div>
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
						<button
							type="button"
							class={`lens-icon-btn ${focusMode() ? 'active' : ''}`}
							title={focusMode() ? 'Show tool calls' : 'Focus view: hide tool calls'}
							aria-pressed={focusMode()}
							onClick={() => {
								const next = !focusMode();
								setFocusMode(next);
								saveState({ focusMode: next });
							}}
						>
							<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 3.5c-3.5 0-5.9 3-6.8 4.2a.6.6 0 0 0 0 .6C2.1 9.5 4.5 12.5 8 12.5s5.9-3 6.8-4.2a.6.6 0 0 0 0-.6C13.9 6.5 11.5 3.5 8 3.5Zm0 7.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" /></svg>
						</button>
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
													<button class="lens-text-btn" onClick={() => setDeleteConfirm({ id: item.id, title: item.title ? formatSessionTitle(item.title) : item.id })}>Delete</button>
												</span>
											</div>
										)}
									</For>
								</Show>
							)}
						</For>
						<Show when={historyEmpty()}>
							<div class="lens-history-empty">{historyQuery().trim() ? 'No chats match your search.' : 'No chats yet.'}</div>
						</Show>
					</div>
				</Show>
				<Show when={deleteConfirm()}>
					{item => (
						<div class="lens-modal">
							<div class="lens-dialog">
								<strong>Delete chat?</strong>
								<div class="lens-muted">"{item().title}" will be permanently deleted.</div>
								<div class="lens-input-row">
									<button class="lens-icon" onClick={() => setDeleteConfirm(null)}>Cancel</button>
									<button class="lens-send" onClick={() => {
										vscode.postMessage({ type: 'session.delete', sessionID: item().id });
										setDeleteConfirm(null);
									}}>Delete</button>
								</div>
							</div>
						</div>
					)}
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
							<ChatRow
								busy={busy()}
								isLast={index() === messages().length - 1}
								message={message}
								focusMode={focusMode()}
								questions={sessionQuestions()}
								rewound={checkpoints.firstRewound() >= 0 && index() >= checkpoints.firstRewound()}
								userActions={message.info?.id ? <RewindMenu disabled={busy() || !!checkpoints.pending()} onPick={action => checkpoints.run(action, message)} /> : undefined}
							/>
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
				<Show when={checkpoints.revert()}>
					{revert => <RewindBanner revert={revert()} pending={!!checkpoints.pending()} onUndo={checkpoints.undo} />}
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
				<Show when={error() && !errorShownInConversation()}>
					<div class="lens-error"><ProviderErrorView text={error()} /></div>
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
					<FollowUpQueue
						items={activeFollowUps()}
						busy={busy()}
						held={!!active() && !!followUps().held[active()!]}
						onEdit={(id, text) => active() && setFollowUps(state => editFollowUp(state, active()!, id, text))}
						onRemove={id => active() && setFollowUps(state => removeFollowUp(state, active()!, id))}
						onSendNow={() => active() && sendNextFollowUp(active()!, true)}
					/>
					<div
						class="lens-composer-box"
						onClick={handleImageThumbClick}
						onPaste={handleComposerPaste}
						onDragOver={handleComposerDragOver}
						onDrop={handleComposerDrop}
					>
						<EditorContextChip context={editorContext.current()} onRemove={() => editorContext.dismiss()} />
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
							placeholder={busy() && active() ? 'Ask Lens a follow-up; it is sent when this reply ends (Esc to stop)' : 'Ask Lens to plan or build…'}
							rows={2}
							value={draft()}
							onInput={event => onDraftInput(event.currentTarget.value)}
							onKeyDown={event => {
								if (event.key === 'Enter' && !event.shiftKey) {
									event.preventDefault();
									// While a turn runs, send() queues the message; only a chat still being created blocks it.
									if (busy() && !active()) return;
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
													saveState({ effort: value });
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
																	saveState({ model: choice.value });
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
								class={`lens-picker-trigger lens-picker-trigger-agent ${picker() === 'agent' ? 'open' : ''}`}
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
							<ContextMeter usage={currentContextUsage()} threshold={autoCompactThreshold()} />
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
							<Show when={SpeechRecognitionCtor}>
								<button class="lens-icon-btn" title="Voice" onClick={dictate}>
									<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 1 0 4 0v-4a2 2 0 0 0-2-2Zm-3.5 6a.75.75 0 0 0-1.5 0 5 5 0 0 0 4.25 4.94V14H5.75a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5H8.75v-1.56A5 5 0 0 0 13 7.5a.75.75 0 0 0-1.5 0 3.5 3.5 0 1 1-7 0Z" /></svg>
								</button>
							</Show>
							<button
								class={`lens-send-btn ${busy() ? 'stop' : ''}`}
								title={busy() ? 'Stop' : 'Send'}
								disabled={!busy() && !draft().trim() && !attachments().length}
								onClick={() => busy() ? stopTurn() : send()}
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
	onerror: ((event: { error: string }) => void) | null;
}
