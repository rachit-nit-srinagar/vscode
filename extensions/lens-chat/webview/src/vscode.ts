declare function acquireVsCodeApi(): { postMessage(data: unknown): void };

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
};
