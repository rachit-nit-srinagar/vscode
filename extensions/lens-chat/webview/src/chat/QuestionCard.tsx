import { createMemo, createSignal, For, Show } from 'solid-js';
import { isActiveStatus, isCancelledStatus } from './format';
import type { ChatPart, QuestionPrompt, QuestionRequest } from './types';
import { vscode } from '../vscode';

export function QuestionCard(props: {
	request?: QuestionRequest;
	questions?: QuestionPrompt[];
	status?: string;
	disabled?: boolean;
	answers?: string[];
}) {
	const questions = createMemo(() => props.request?.questions?.length ? props.request.questions : (props.questions ?? []));
	const cancelled = () => isCancelledStatus(props.status);
	const completed = () => props.status === 'completed' || (!!props.answers?.length && !isActiveStatus(props.status));
	const running = () => !cancelled() && !completed() && (isActiveStatus(props.status) || !props.status);
	const canReply = () => !!props.request?.id && running() && !props.disabled;
	const chosen = () => (props.answers ?? []).map(value => value.trim()).filter(Boolean);
	const [picked, setPicked] = createSignal<string[][]>([]);
	const [custom, setCustom] = createSignal<string[]>([]);
	const [sent, setSent] = createSignal(false);

	function answersFor(index: number): string[] {
		return picked()[index] ?? [];
	}

	function reply(answers: string[][]) {
		if (!canReply() || sent()) {
			return;
		}
		setSent(true);
		vscode.postMessage({
			type: 'question.reply',
			requestID: props.request!.id,
			answers,
		});
	}

	function pick(index: number, label: string) {
		const item = questions()[index];
		if (!item) {
			return;
		}
		if (item.multiple) {
			const current = answersFor(index);
			const next = current.includes(label) ? current.filter(value => value !== label) : [...current, label];
			const all = questions().map((_, i) => (i === index ? next : answersFor(i)));
			setPicked(all);
			return;
		}
		const all = questions().map((_, i) => (i === index ? [label] : answersFor(i)));
		setPicked(all);
		if (questions().length === 1) {
			reply([[label]]);
		}
	}

	function submit() {
		const extras = questions().map((item, index) => {
			const typed = (custom()[index] ?? '').trim();
			if (!typed || item.custom === false) {
				return answersFor(index);
			}
			const current = answersFor(index);
			return current.includes(typed) ? current : [...current, typed];
		});
		reply(extras);
	}

	function dismiss() {
		if (!canReply() || sent()) {
			return;
		}
		setSent(true);
		vscode.postMessage({ type: 'question.reject', requestID: props.request!.id });
	}

	return (
		<Show when={!cancelled() && questions().length > 0}>
			<Show when={!completed()} fallback={
				<div class="lens-muted-row">{chosen().length ? `You chose: ${chosen().join(', ')}` : 'Asked a question'}</div>
			}>
			<div class="lens-question">
				<For each={questions()}>
					{(item, index) => (
						<div class="lens-question-item">
							<div class="lens-question-text">{item.question}</div>
							<Show when={item.multiple}>
								<div class="lens-question-hint">Select all that apply</div>
							</Show>
							<div class="lens-question-options">
								<For each={item.options ?? []}>
									{option => (
										<button
											type="button"
											class={`lens-question-option${answersFor(index()).includes(option.label) ? ' picked' : ''}`}
											disabled={!canReply() || sent()}
											onClick={() => pick(index(), option.label)}
										>
											<span class="lens-question-option-label">{option.label}</span>
											<Show when={option.description}>
												<span class="lens-question-option-desc">{option.description}</span>
											</Show>
										</button>
									)}
								</For>
							</div>
							<Show when={item.custom !== false && canReply()}>
								<input
									class="lens-question-custom"
									placeholder="Type your own answer"
									value={custom()[index()] ?? ''}
									disabled={sent()}
									onInput={event => {
										const value = event.currentTarget.value;
										setCustom(current => {
											const next = [...current];
											next[index()] = value;
											return next;
										});
									}}
									onKeyDown={event => {
										if (event.key === 'Enter' && !event.shiftKey) {
											event.preventDefault();
											const value = (custom()[index()] ?? '').trim();
											if (value) {
												pick(index(), value);
											}
										}
									}}
								/>
							</Show>
						</div>
					)}
				</For>
				<Show when={canReply() && (questions().length > 1 || questions().some(item => item.multiple))}>
					<div class="lens-question-actions">
						<button type="button" class="lens-question-submit" disabled={sent()} onClick={submit}>Continue</button>
						<button type="button" class="lens-text-btn" disabled={sent()} onClick={dismiss}>Skip</button>
					</div>
				</Show>
			</div>
			</Show>
		</Show>
	);
}

export function chosenAnswersFromPart(part: ChatPart): string[] {
	const raw = part.state?.metadata?.answers;
	if (Array.isArray(raw)) {
		return raw.flatMap(item => {
			if (Array.isArray(item)) {
				return item.filter((value): value is string => typeof value === 'string' && value.trim() !== '' && value !== 'Unanswered');
			}
			if (typeof item === 'string' && item.trim() && item !== 'Unanswered') {
				return [item];
			}
			return [];
		});
	}
	const output = String(part.state?.output ?? '');
	return [...output.matchAll(/"="([^"]*)"/g)]
		.map(match => match[1]?.trim() ?? '')
		.filter(value => value && value !== 'Unanswered');
}

export function questionsFromPart(input: Record<string, unknown> | undefined): QuestionPrompt[] {
	const raw = input?.questions;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.flatMap(item => {
		if (!item || typeof item !== 'object') {
			return [];
		}
		const record = item as Record<string, unknown>;
		if (typeof record.question !== 'string') {
			return [];
		}
		const options = Array.isArray(record.options)
			? record.options.flatMap(option => {
				if (!option || typeof option !== 'object') {
					return [];
				}
				const label = (option as { label?: unknown }).label;
				if (typeof label !== 'string') {
					return [];
				}
				const description = (option as { description?: unknown }).description;
				return [{ label, description: typeof description === 'string' ? description : undefined }];
			})
			: [];
		return [{
			question: record.question,
			header: typeof record.header === 'string' ? record.header : undefined,
			options,
			multiple: record.multiple === true,
			custom: record.custom !== false,
		}];
	});
}
