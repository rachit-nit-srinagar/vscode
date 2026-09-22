import { describe, expect, it } from 'vitest';
import { parseProviderError } from './providerError';

describe('parseProviderError', () => {
	it('reads a wrapped Gemini quota error', () => {
		const text = `[{"error":{"code":429,"message":"You exceeded your current quota.\\n* Quota exceeded for metric: free_tier_requests, limit: 5\\nPlease retry in 17.403749562s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.Help","links":[{"description":"Learn more about Gemini API quotas","url":"https://ai.google.dev/gemini-api/docs/rate-limits"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"17s"}]}}]`;
		expect(parseProviderError(text)).toEqual({
			heading: 'Rate limit or quota reached',
			message: 'You exceeded your current quota.\n* Quota exceeded for metric: free_tier_requests, limit: 5',
			code: '429',
			status: 'RESOURCE_EXHAUSTED',
			retryIn: '17s',
			links: [{ label: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }],
		});
	});

	it('reads a JSON body behind an HTTP reason prefix', () => {
		const parsed = parseProviderError('Not Found: [{"error":{"code":404,"message":"This model models/old-flash is no longer available to new users.","status":"NOT_FOUND"}}]');
		expect([parsed.heading, parsed.message, parsed.code, parsed.status]).toEqual(['Model not available', 'This model models/old-flash is no longer available to new users.', '404', 'NOT_FOUND']);
	});

	it('keeps plain-text errors and drops non-http links', () => {
		expect(parseProviderError('`max_tokens` must be less than or equal to `16384`')).toEqual({
			heading: 'The provider rejected the request',
			message: '`max_tokens` must be less than or equal to `16384`',
			links: [],
			retryIn: undefined,
		});
		expect(parseProviderError('{"error":{"message":"x","details":[{"links":[{"url":"javascript:alert(1)"}]}]}}').links).toEqual([]);
	});
});
