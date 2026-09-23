export const LENS_PROVIDER_ID = 'lens';
export const PREFERRED_MODEL_ID = 'gcp/claude-5-sonnet';
export const DEFAULT_MODEL = `${LENS_PROVIDER_ID}/${PREFERRED_MODEL_ID}`;

export type ModelChoice = {
	value: string;
	label: string;
	modelId: string;
	group?: string;
	supportsImage?: boolean;
	/** The model's context window in tokens (`limit.context`), when the provider reports one. */
	contextLimit?: number;
};

export type ModelGroup = {
	key: string;
	label: string;
	choices: ModelChoice[];
};

const GROUP_LABELS: Record<string, string> = {
	azure: 'Azure',
	gcp: 'GCP',
	aws: 'AWS',
	google: 'Google',
	other: 'Other',
};

const GROUP_ORDER = ['azure', 'gcp', 'aws', 'google', 'other'];
const CLOUD_PREFIXES = new Set(['azure', 'gcp', 'aws']);
// Route segments that name Google's Gemini API: the AI Providers `gemini` type, LiteLLM's `gemini/` and
// OpenRouter's `google/` namespaces.
const GOOGLE_SEGMENTS = new Set(['gemini', 'google']);
const GOOGLE_MODEL = /^(gemini|gemma)(-|$)/;

// Agent products (e.g. "Antigravity Agent Preview") that a provider lists next to its chat models but that
// cannot run as a chat model. The provider data carries no capability that tells them apart (only name,
// vision and limits reach the webview), so they are recognised by name; the main-process model listing
// already drops the other agent-only families (deep-research, computer-use).
const AGENT_ONLY_MODEL = /\bantigravity\b/i;

/**
 * Picks the picker group for a model id such as `gcp/claude-5-sonnet`, `gemini/gemini-2.5-pro`,
 * `openrouter/google/gemini-2.5-pro` or `litellm/vertex_ai/gemini-2.5-flash`.
 * A leading cloud prefix wins; otherwise Gemini and Gemma models go to Google.
 */
export function deriveModelGroup(modelId: string): string {
	const segments = modelId.toLowerCase().split('/').filter(Boolean);
	const prefix = segments.length > 1 ? segments[0] : undefined;
	if (prefix && CLOUD_PREFIXES.has(prefix)) {
		return prefix;
	}
	const name = segments[segments.length - 1] ?? '';
	if (GOOGLE_MODEL.test(name) || segments.slice(0, -1).some(segment => GOOGLE_SEGMENTS.has(segment))) {
		return 'google';
	}
	return 'other';
}

export function isAgentOnlyModel(modelId: string, name?: string): boolean {
	return AGENT_ONLY_MODEL.test(modelId) || (!!name && AGENT_ONLY_MODEL.test(name));
}

export function parseModelChoices(data: unknown): ModelChoice[] {
	const providers = extractProviders(data);
	const out: ModelChoice[] = [];
	for (const provider of providers) {
		const models = provider.models ?? {};
		for (const [modelID, info] of Object.entries(models)) {
			const id = (info && typeof info === 'object' && 'id' in info && typeof info.id === 'string' && info.id) || modelID;
			const name = (info && typeof info === 'object' && 'name' in info && typeof info.name === 'string' && info.name) || shortModelLabel(id);
			if (isAgentOnlyModel(id, name)) {
				continue;
			}
			const capabilities = info && typeof info === 'object' && 'capabilities' in info ? info.capabilities : undefined;
			const supportsImage = !!(capabilities && typeof capabilities === 'object' && 'input' in capabilities
				&& capabilities.input && typeof capabilities.input === 'object' && 'image' in capabilities.input
				&& capabilities.input.image);
			const limit = info && typeof info === 'object' && 'limit' in info ? info.limit : undefined;
			const context = limit && typeof limit === 'object' && 'context' in limit ? Number(limit.context) : NaN;
			out.push({
				value: `${provider.id}/${id}`,
				label: name,
				modelId: id,
				group: deriveModelGroup(id),
				supportsImage,
				...(context > 0 ? { contextLimit: context } : {}),
			});
		}
	}
	return out;
}

export function groupModelChoices(choices: ModelChoice[]): ModelGroup[] {
	const grouped = new Map<string, ModelChoice[]>();
	for (const choice of choices) {
		const key = choice.group ?? deriveModelGroup(choice.modelId);
		const bucket = grouped.get(key) ?? [];
		bucket.push(choice);
		grouped.set(key, bucket);
	}

	return GROUP_ORDER
		.filter(key => grouped.has(key))
		.map(key => ({
			key,
			label: GROUP_LABELS[key] ?? key,
			choices: grouped.get(key) ?? [],
		}));
}

export function filterModelChoices(choices: ModelChoice[], query: string): ModelChoice[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return choices;
	}
	return choices.filter(choice =>
		choice.label.toLowerCase().includes(q)
		|| choice.modelId.toLowerCase().includes(q)
		|| choice.value.toLowerCase().includes(q),
	);
}

export function resolvePreferredModel(
	choices: ModelChoice[],
	current: string,
	preferredModelId: string = PREFERRED_MODEL_ID,
): string | undefined {
	if (choices.some(choice => choice.value === current)) {
		return current;
	}
	const preferred = choices.find(choice => choice.modelId === preferredModelId);
	if (preferred) {
		return preferred.value;
	}
	const lensChoice = choices.find(choice => choice.value.startsWith(`${LENS_PROVIDER_ID}/`));
	return lensChoice?.value ?? choices[0]?.value;
}

function extractProviders(data: unknown): Array<{ id: string; models?: Record<string, { id?: string; name?: string; capabilities?: unknown }> }> {
	if (!data || typeof data !== 'object') {
		return [];
	}
	const raw = data as { all?: unknown; providers?: unknown };
	const all = raw.all ?? raw.providers ?? data;
	if (Array.isArray(all)) {
		return all
			.filter((item): item is { id?: string; models?: Record<string, { id?: string; name?: string; capabilities?: unknown }> } => !!item && typeof item === 'object')
			.map(item => ({ id: String(item.id ?? ''), models: item.models }))
			.filter(item => item.id && !/^\d+$/.test(item.id));
	}
	if (all && typeof all === 'object') {
		return Object.entries(all as Record<string, { id?: string; models?: Record<string, { id?: string; name?: string; capabilities?: unknown }> }>)
			.filter(([key, value]) => value && typeof value === 'object' && !!value.models)
			.map(([key, value]) => ({ id: String(value.id ?? key), models: value.models }))
			.filter(item => item.id && !/^\d+$/.test(item.id));
	}
	return [];
}

export function shortModelLabel(id: string): string {
	const parts = id.split('/');
	return parts[parts.length - 1] || id;
}
