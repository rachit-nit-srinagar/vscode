import { describe, expect, it } from 'vitest';
import {
	groupAssistantParts,
	parseMcpToolName,
	toolCardStatus,
	toolCallHeading,
	toolOutputPreview,
} from './mcpTool';
import type { ChatPart } from './types';

describe('parseMcpToolName', () => {
	it('splits Example Docs MCP tool ids into server and tool', () => {
		expect(parseMcpToolName('Example_Docs_search_example_docs')).toEqual({
			raw: 'Example_Docs_search_example_docs',
			server: 'Example Docs',
			tool: 'search_example_docs',
			isMcp: true,
		});
		expect(parseMcpToolName('Example_Docs_query_docs_filesystem_example_docs')).toEqual({
			raw: 'Example_Docs_query_docs_filesystem_example_docs',
			server: 'Example Docs',
			tool: 'query_docs_filesystem_example_docs',
			isMcp: true,
		});
	});

	it('humanizes Title_Case server prefixes and keeps snake_case tools', () => {
		expect(parseMcpToolName('Linear_create_issue')).toEqual({
			raw: 'Linear_create_issue',
			server: 'Linear',
			tool: 'create_issue',
			isMcp: true,
		});
	});

	it('does not treat built-in tools as MCP', () => {
		expect(parseMcpToolName('bash')).toMatchObject({ tool: 'bash', isMcp: false });
		expect(parseMcpToolName('read')).toMatchObject({ isMcp: false });
		expect(parseMcpToolName('webfetch')).toMatchObject({ isMcp: false });
		expect(parseMcpToolName('list_mcp_resources')).toMatchObject({ isMcp: false, tool: 'list_mcp_resources' });
	});

	it('falls back to first segment for lowercase server prefixes', () => {
		expect(parseMcpToolName('cache-server_test_tool')).toEqual({
			raw: 'cache-server_test_tool',
			server: 'cache-server',
			tool: 'test_tool',
			isMcp: true,
		});
	});
});

describe('toolCallHeading', () => {
	it('renders Cursor-like MCP labels', () => {
		expect(toolCallHeading('Example_Docs_search_example_docs')).toEqual({
			server: 'Example Docs',
			tool: 'search_example_docs',
			isMcp: true,
			label: 'Example Docs → search_example_docs',
		});
	});
});

describe('toolCardStatus', () => {
	it('maps tool part status to card kind and label', () => {
		expect(toolCardStatus('pending')).toEqual({ kind: 'pending', label: 'Pending' });
		expect(toolCardStatus('running')).toEqual({ kind: 'running', label: 'Running' });
		expect(toolCardStatus('completed')).toEqual({ kind: 'completed', label: 'Completed' });
		expect(toolCardStatus('error')).toEqual({ kind: 'error', label: 'Error' });
		expect(toolCardStatus('aborted')).toEqual({ kind: 'error', label: 'Error' });
		expect(toolCardStatus(undefined)).toEqual({ kind: 'completed', label: 'Completed' });
	});
});

describe('toolOutputPreview', () => {
	it('extracts MCP text content and truncates huge blobs', () => {
		const preview = toolOutputPreview(JSON.stringify({
			content: [{ type: 'text', text: 'dm_guides/dm_designing_scalable_models.mdx' }],
		}));
		expect(preview.text).toBe('dm_guides/dm_designing_scalable_models.mdx');
		expect(preview.truncated).toBe(false);

		const long = toolOutputPreview('x'.repeat(2000), 100);
		expect(long.truncated).toBe(true);
		expect(long.text.length).toBeLessThan(2000);
	});
});

describe('groupAssistantParts', () => {
	it('groups consecutive tool calls', () => {
		const parts: ChatPart[] = [
			{ type: 'tool', tool: 'Example_Docs_search_example_docs' },
			{ type: 'tool', tool: 'Example_Docs_query_docs_filesystem_example_docs' },
			{ type: 'text', text: '## Best practices' },
		];
		const groups = groupAssistantParts(parts);
		expect(groups).toHaveLength(2);
		expect(groups[0]).toMatchObject({ kind: 'tools' });
		expect((groups[0] as { parts: ChatPart[] }).parts).toHaveLength(2);
		expect(groups[1]).toMatchObject({ kind: 'part', part: { type: 'text' } });
	});
});
