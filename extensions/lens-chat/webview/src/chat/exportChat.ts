import { isVisiblePart, messageRole, toolLabel } from './format';
import type { ChatMessage } from './types';

/** The client-side `/export` command: turns the visible transcript into Markdown, sent to the host to save. */
export const EXPORT_COMMAND = 'export';
export const EXPORT_DESCRIPTION = 'Export this chat to Markdown';

/** Renders a chat transcript as Markdown. Pure and independent of the engine's wire format, so it is unit-testable. */
export function transcriptToMarkdown(title: string, messages: ChatMessage[]): string {
	const lines: string[] = [`# ${title || 'Lens Chat'}`, ''];
	for (const message of messages) {
		const parts = (message.parts ?? []).filter(isVisiblePart).filter(part => !(part.type === 'text' && part.synthetic));
		if (!parts.length) {
			continue;
		}
		const role = messageRole(message);
		lines.push(`## ${role === 'user' ? 'You' : 'Lens'}`, '');
		for (const part of parts) {
			if (part.type === 'text' && part.text?.trim()) {
				lines.push(part.text.trim(), '');
			} else if (part.type === 'tool') {
				lines.push(`_${toolLabel(part.tool || 'tool', part.state?.status)}_`, '');
			}
		}
	}
	return lines.join('\n').trim() + '\n';
}
