declare function acquireVsCodeApi(): { postMessage(data: unknown): void; getState(): unknown; setState(state: unknown): void };

const VSCODE_API_KEY = '__lensVsCodeApi';

type VsCodeApi = ReturnType<typeof acquireVsCodeApi>;

function getVsCodeApi(): VsCodeApi {
	const global = globalThis as typeof globalThis & { [VSCODE_API_KEY]?: VsCodeApi };
	if (global[VSCODE_API_KEY]) {
		return global[VSCODE_API_KEY];
	}
	const api = acquireVsCodeApi();
	global[VSCODE_API_KEY] = api;
	return api;
}

export const vscode: VsCodeApi = {
	postMessage(data: unknown) {
		getVsCodeApi().postMessage(data);
	},
	getState() {
		return getVsCodeApi().getState();
	},
	setState(state: unknown) {
		getVsCodeApi().setState(state);
	},
};

type SavedState = { model?: string };

/** Webview state survives reloads of the panel and the window. */
export function readSavedState(): SavedState {
	const state = vscode.getState();
	return state && typeof state === 'object' ? state as SavedState : {};
}

export function saveState(patch: SavedState): void {
	vscode.setState({ ...readSavedState(), ...patch });
}
