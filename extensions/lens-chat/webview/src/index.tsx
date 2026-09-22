import { render } from 'solid-js/web';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (root) {
	try {
		render(() => <App />, root);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		root.innerHTML = `<div class="lens-loading" style="padding:16px;color:var(--vscode-errorForeground);">Lens failed to start: ${message}</div>`;
	}
}
