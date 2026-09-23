export type ProviderErrorLink = { label: string; url: string };

export type ProviderError = {
	heading: string;
	message: string;
	code?: string;
	status?: string;
	retryIn?: string;
	links: ProviderErrorLink[];
};

type ErrorDetail = { '@type'?: string; retryDelay?: string; links?: { description?: string; url?: string }[] };
type ErrorBody = { message?: string; code?: number | string; status?: string; type?: string; details?: ErrorDetail[]; error?: ErrorBody };

/**
 * Turns a provider error string into something readable. Providers return JSON bodies
 * (often wrapped in an array or prefixed with the HTTP reason, e.g. `Not Found: [{"error": …}]`);
 * plain-text errors pass through as the message.
 */
export function parseProviderError(text: string): ProviderError {
	const raw = text.trim();
	const start = raw.search(/[[{]/);
	const prefix = (start > 0 ? raw.slice(0, start) : start === 0 ? '' : raw).trim().replace(/[:\s]+$/, '');
	const body = start >= 0 ? parseJsonBody(raw.slice(start)) : undefined;
	if (!body) {
		return { heading: headingFor(undefined, undefined, raw, 'Something went wrong'), message: raw, links: [], retryIn: retryFromText(raw) };
	}
	const error = body.error ?? body;
	const code = error.code !== undefined ? String(error.code) : undefined;
	const status = error.status ?? error.type;
	const message = (error.message ?? prefix ?? raw).trim();
	const details = Array.isArray(error.details) ? error.details : [];
	const retryDelay = details.find(detail => detail.retryDelay)?.retryDelay;
	const links = details.flatMap(detail => detail.links ?? [])
		.filter((link): link is { description?: string; url: string } => typeof link.url === 'string' && /^https?:\/\//i.test(link.url))
		.map(link => ({ label: link.description || link.url, url: link.url }));
	return {
		heading: headingFor(code, status, `${prefix} ${message}`),
		message: message.replace(/\s*Please retry in [\d.]+s\.?\s*$/i, '').trim() || message,
		code,
		status,
		retryIn: retryDelay ? roundSeconds(retryDelay) : retryFromText(message),
		links,
	};
}

function parseJsonBody(text: string): ErrorBody | undefined {
	for (const candidate of [text, text.slice(0, Math.max(text.lastIndexOf('}'), text.lastIndexOf(']')) + 1)]) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			const value = Array.isArray(parsed) ? parsed[0] : parsed;
			if (value && typeof value === 'object') {
				return value as ErrorBody;
			}
		} catch {
			// Not JSON (or trailing text); try the next candidate.
		}
	}
	return undefined;
}

function headingFor(code: string | undefined, status: string | undefined, text: string, fallback = 'The model returned an error'): string {
	const signal = `${code ?? ''} ${status ?? ''} ${text}`.toLowerCase();
	if (/\b429\b|resource_exhausted|rate.?limit|quota|too many requests/.test(signal)) {
		return 'Rate limit or quota reached';
	}
	if (/\b40[13]\b|unauthorized|permission_denied|invalid.{0,10}(api.)?key|authentication/.test(signal)) {
		return 'The provider rejected the API key';
	}
	// A bare "not found" is too broad (e.g. an unknown command); require a status code or a model reference.
	if (/\b404\b|not_found|model\b.{0,80}\b(not found|no longer available|does not exist)/.test(signal)) {
		return 'Model not available';
	}
	if (/\b50[234]\b|unavailable|overloaded|service unavailable|bad gateway|timeout/.test(signal)) {
		return 'The provider is unavailable right now';
	}
	if (/\b400\b|invalid_argument|bad request|must be/.test(signal)) {
		return 'The provider rejected the request';
	}
	return fallback;
}

function retryFromText(text: string): string | undefined {
	const match = /retry in ([\d.]+)\s*s/i.exec(text);
	return match ? roundSeconds(`${match[1]}s`) : undefined;
}

function roundSeconds(value: string): string {
	const seconds = Number.parseFloat(value);
	return Number.isFinite(seconds) ? `${Math.ceil(seconds)}s` : value;
}
