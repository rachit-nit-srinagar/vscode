import type { CheckpointRequest } from './checkpoints';
import type { EditorContextInfo } from './editorContext';

export interface ILensEngineRuntime {
	readonly opencodeUrl: string;
	readonly opencodeUsername: string;
	readonly opencodePassword: string;
	readonly defaultModel?: string;
}

export interface ILensUserConfig {
	readonly mcp?: Record<string, unknown>;
	readonly plugin?: unknown;
	readonly skills?: unknown;
	readonly command?: unknown;
	readonly agent?: unknown;
	readonly instructions?: unknown;
	readonly pluginsAllowed?: boolean;
	readonly hooksAllowed?: boolean;
}

export type PromptPart =
	| { type: 'text'; text: string }
	| { type: 'file'; mime: string; url: string; filename?: string };

export type McpConfig =
	| { type: 'remote'; url: string; enabled?: boolean; headers?: Record<string, string> }
	| { type: 'local'; command: string[]; environment?: Record<string, string>; cwd?: string; enabled?: boolean };

/** Session.create expects `{ id, providerID, variant? }` — not `{ modelID }`. */
export type SessionCreateModel = { id: string; providerID: string; variant?: string };

/** Session.prompt expects `{ providerID, modelID }`. */
export type SessionPromptModel = { providerID: string; modelID: string };

export type WebviewToHost =
	| { type: 'ready' }
	| { type: 'session.create'; agent?: string; model?: SessionCreateModel }
	| { type: 'session.list'; search?: string }
	| { type: 'session.select'; sessionID: string }
	| { type: 'session.close'; sessionID: string }
	| { type: 'session.delete'; sessionID: string }
	| { type: 'session.update'; sessionID: string; title?: string; archived?: boolean }
	| { type: 'session.prompt'; sessionID: string; text: string; agent?: string; variant?: string; model?: SessionPromptModel; parts?: PromptPart[] }
	| { type: 'session.abort'; sessionID: string }
	| { type: 'session.status' }
	| { type: 'session.messages'; sessionID: string }
	| { type: 'session.command'; sessionID: string; command: string; arguments?: string; agent?: string; variant?: string }
	/** `/compact` and auto-compaction: the engine summarizes the chat with this model. */
	| { type: 'session.summarize'; sessionID: string; model: SessionPromptModel; auto?: boolean }
	/** Lens Chat's own settings (for example `lens.chat.autoCompactThreshold`); also pushed as a result when they change. */
	| { type: 'chat.settings' }
	| { type: 'find.files'; query: string }
	| { type: 'find.symbols'; query: string }
	| { type: 'session.diff'; sessionID: string }
	| { type: 'command.list' }
	| { type: 'skill.list' }
	| { type: 'agent.list' }
	| { type: 'provider.list' }
	| { type: 'permission.list' }
	| { type: 'permission.reply'; requestID: string; reply: 'once' | 'always' | 'reject' }
	| { type: 'question.list' }
	| { type: 'question.reply'; requestID: string; answers: string[][] }
	| { type: 'question.reject'; requestID: string }
	| { type: 'mcp.status' }
	| { type: 'mcp.add'; name: string; config: McpConfig }
	| { type: 'mcp.connect'; name: string }
	| { type: 'mcp.disconnect'; name: string }
	| { type: 'config.get' }
	| { type: 'config.patch'; partial: ILensUserConfig }
	| { type: 'file.open'; path: string; addedLines?: number[]; isNew?: boolean }
	| { type: 'providers.open' }
	| { type: 'providers.get' }
	| { type: 'providers.save'; config: Record<string, unknown>; apiKey?: string; clearApiKey?: boolean }
	| { type: 'providers.remove'; provider: string }
	| { type: 'providers.fetchModels'; provider: string }
	| CheckpointRequest;

export type HostToWebview =
	| { type: 'boot'; runtime?: ILensEngineRuntime; workspace?: string; userConfig?: ILensUserConfig }
	| { type: 'error'; message: string }
	| { type: 'event'; payload: unknown }
	| { type: 'result'; requestType: string; data: unknown }
	| { type: 'command'; action: 'new' | 'history' }
	/** The active file or selection the composer may attach; undefined when there is none or it is excluded. */
	| { type: 'editorContext'; context?: EditorContextInfo }
	/** Alt+K: insert this `@path#L5-10` mention into the composer and focus it. */
	| { type: 'insertMention'; text: string };
