import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MODEL,
	deriveModelGroup,
	filterModelChoices,
	groupModelChoices,
	parseModelChoices,
	resolvePreferredModel,
} from './modelPicker';

describe('modelPicker', () => {
	it('parseModelChoices reads lens provider models', () => {
		const choices = parseModelChoices({
			all: [{
				id: 'lens',
				models: {
					'gcp/claude-5-sonnet': { id: 'gcp/claude-5-sonnet', name: 'Claude 5 Sonnet' },
					'azure/gpt-5.4': { id: 'azure/gpt-5.4', name: 'GPT 5.4' },
				},
			}],
		});
		expect(choices).toHaveLength(2);
		expect(choices[0]?.value).toBe('lens/gcp/claude-5-sonnet');
		expect(choices[0]?.group).toBe('gcp');
	});

	it('groupModelChoices groups by cloud prefix', () => {
		const choices = parseModelChoices({
			all: [{
				id: 'lens',
				models: {
					'gcp/claude-5-sonnet': { id: 'gcp/claude-5-sonnet', name: 'Claude 5 Sonnet' },
					'azure/gpt-5.4': { id: 'azure/gpt-5.4', name: 'GPT 5.4' },
					'aws/claude-5-sonnet': { id: 'aws/claude-5-sonnet', name: 'Claude 5 Sonnet' },
				},
			}],
		});
		const groups = groupModelChoices(choices);
		expect(groups.map(group => group.key)).toEqual(['azure', 'gcp', 'aws']);
	});

	it('filterModelChoices matches label and id', () => {
		const choices = parseModelChoices({
			all: [{
				id: 'lens',
				models: {
					'gcp/claude-5-sonnet': { id: 'gcp/claude-5-sonnet', name: 'Claude 5 Sonnet' },
					'azure/gpt-5.4': { id: 'azure/gpt-5.4', name: 'GPT 5.4' },
				},
			}],
		});
		expect(filterModelChoices(choices, 'gpt')).toHaveLength(1);
		expect(filterModelChoices(choices, 'gcp/')).toHaveLength(1);
	});

	it('resolvePreferredModel keeps known refs and prefers default', () => {
		const choices = parseModelChoices({
			all: [{
				id: 'lens',
				models: {
					'gcp/claude-5-sonnet': { id: 'gcp/claude-5-sonnet', name: 'Claude 5 Sonnet' },
					'azure/gpt-5.4': { id: 'azure/gpt-5.4', name: 'GPT 5.4' },
				},
			}],
		});
		expect(resolvePreferredModel(choices, 'lens/azure/gpt-5.4')).toBe('lens/azure/gpt-5.4');
		expect(resolvePreferredModel(choices, 'missing/model')).toBe('lens/gcp/claude-5-sonnet');
		expect(DEFAULT_MODEL).toBe('lens/gcp/claude-5-sonnet');
	});

	it('deriveModelGroup puts Gemini and Gemma models under Google', () => {
		expect(deriveModelGroup('gemini/gemini-2.5-pro')).toBe('google');
		expect(deriveModelGroup('gemini/gemini-2.5-flash')).toBe('google');
		expect(deriveModelGroup('gemini-2.5-pro')).toBe('google');
		expect(deriveModelGroup('openrouter/google/gemini-2.5-pro')).toBe('google');
		expect(deriveModelGroup('litellm/gemini/gemini-2.5-pro')).toBe('google');
		expect(deriveModelGroup('litellm/vertex_ai/gemini-2.5-flash')).toBe('google');
		expect(deriveModelGroup('openai-compatible/gemma-3-27b-it')).toBe('google');
		expect(deriveModelGroup('Gemini/Gemini-2.5-Pro')).toBe('google');
	});

	it('deriveModelGroup keeps cloud prefixes and leaves other models in Other', () => {
		expect(deriveModelGroup('gcp/gemini-2.5-pro')).toBe('gcp');
		expect(deriveModelGroup('azure/gpt-5.4')).toBe('azure');
		expect(deriveModelGroup('openai/gpt-4o')).toBe('other');
		expect(deriveModelGroup('openai-compatible/mock-model')).toBe('other');
		expect(deriveModelGroup('gpt-4o')).toBe('other');
		expect(deriveModelGroup('openrouter/anthropic/claude-sonnet-4')).toBe('other');
		// Only a whole route segment or a model-name prefix counts, not a substring.
		expect(deriveModelGroup('openai-compatible/not-gemini-model')).toBe('other');
		expect(deriveModelGroup('googleish/model')).toBe('other');
	});

	it('groupModelChoices shows a Google group before Other', () => {
		const choices = parseModelChoices({
			all: [{
				id: 'lens',
				models: {
					'openai/gpt-4o': { id: 'openai/gpt-4o', name: 'GPT-4o' },
					'gemini/gemini-2.5-pro': { id: 'gemini/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
					'gcp/claude-5-sonnet': { id: 'gcp/claude-5-sonnet', name: 'Claude 5 Sonnet' },
				},
			}],
		});
		const groups = groupModelChoices(choices);
		expect(groups.map(group => [group.key, group.label])).toEqual([['gcp', 'GCP'], ['google', 'Google'], ['other', 'Other']]);
		expect(groups[1]?.choices.map(choice => choice.value)).toEqual(['lens/gemini/gemini-2.5-pro']);
	});

	it('parseModelChoices hides agent-only models', () => {
		const choices = parseModelChoices({
			all: [{
				id: 'lens',
				models: {
					'gemini/gemini-2.5-pro': { id: 'gemini/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
					'gemini/antigravity-preview': { id: 'gemini/antigravity-preview', name: 'Antigravity Agent Preview' },
					'gemini/agent-x': { id: 'gemini/agent-x', name: 'Antigravity Agent Preview' },
					'litellm/gemini-3-antigravity': { id: 'litellm/gemini-3-antigravity' },
				},
			}],
		});
		expect(choices.map(choice => choice.value)).toEqual(['lens/gemini/gemini-2.5-pro']);
	});

	it('parseModelChoices keeps models that only mention agents', () => {
		const choices = parseModelChoices({
			all: [{
				id: 'lens',
				models: {
					'openai/gpt-5-agent': { id: 'openai/gpt-5-agent', name: 'GPT-5 Agent' },
					'litellm/gravity-7b': { id: 'litellm/gravity-7b' },
				},
			}],
		});
		expect(choices).toHaveLength(2);
	});
});
