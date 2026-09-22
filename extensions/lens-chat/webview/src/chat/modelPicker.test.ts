import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MODEL,
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
});
