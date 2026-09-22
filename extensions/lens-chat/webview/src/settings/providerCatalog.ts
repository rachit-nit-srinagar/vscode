export type ProviderType =
	| 'openai'
	| 'anthropic'
	| 'gemini'
	| 'azure-openai'
	| 'openrouter'
	| 'cloudflare'
	| 'xai'
	| 'groq'
	| 'openai-compatible'
	| 'litellm'
	| 'ollama';

export type ProviderField = 'baseUrl' | 'resourceName' | 'accountId' | 'gatewayId' | 'headerName';

export type ProviderInfo = {
	type: ProviderType;
	name: string;
	logo: string;
	/** How the API key field behaves. */
	key: 'required' | 'optional' | 'none';
	keyLabel?: string;
	fields: { id: ProviderField; label: string; placeholder: string; optional?: boolean }[];
	/** Models must be typed in (deployments, gateway routes) instead of picked from a list. */
	manualModels?: { label: string; placeholder: string };
	instructions: string;
};

export const PROVIDERS: ProviderInfo[] = [
	{
		type: 'openai',
		name: 'OpenAI',
		logo: 'openai.png',
		key: 'required',
		fields: [],
		instructions: `1. Go to https://platform.openai.com/api-keys.
2. Create a secret key and paste it below.

Add billing details to your OpenAI account before creating the key to avoid rate-limit (429) errors.`,
	},
	{
		type: 'anthropic',
		name: 'Anthropic',
		logo: 'anthropic.png',
		key: 'required',
		fields: [],
		instructions: `1. Go to https://console.anthropic.com/settings/keys.
2. Create a key and paste it below.`,
	},
	{
		type: 'gemini',
		name: 'Google Gemini',
		logo: 'gemini.png',
		key: 'required',
		fields: [],
		instructions: `1. Go to https://aistudio.google.com/app/apikey (or https://console.cloud.google.com/apis/credentials).
2. Create an API key and paste it below.`,
	},
	{
		type: 'azure-openai',
		name: 'Azure OpenAI',
		logo: 'azure-openai.png',
		key: 'required',
		fields: [{ id: 'resourceName', label: 'Resource name', placeholder: 'my-openai-resource' }],
		manualModels: { label: 'Deployment names (one per line)', placeholder: 'gpt-4o\ngpt-4.1-mini' },
		instructions: `In the Azure Portal, open your Azure OpenAI resource:

1. The resource name is the first part of its endpoint, \`https://{resource-name}.openai.azure.com\`.
2. Copy an API key from **Keys and Endpoint**.
3. List the deployment names you want to use in Lens.`,
	},
	{
		type: 'openrouter',
		name: 'OpenRouter',
		logo: 'openrouter.jpg',
		key: 'required',
		fields: [],
		instructions: `1. Go to https://openrouter.ai/settings/keys.
2. Create a key and paste it below.`,
	},
	{
		type: 'cloudflare',
		name: 'Cloudflare AI Gateway',
		logo: 'cloudflare.png',
		key: 'optional',
		keyLabel: 'Gateway token',
		fields: [
			{ id: 'accountId', label: 'Account ID', placeholder: 'your Cloudflare account id' },
			{ id: 'gatewayId', label: 'Gateway ID', placeholder: 'my-gateway' },
		],
		manualModels: { label: 'Models (one per line, prefixed with the provider)', placeholder: 'openai/gpt-4o\nanthropic/claude-sonnet-4-5' },
		instructions: `1. Create a gateway at https://developers.cloudflare.com/ai-gateway/get-started/.
2. Your gateway URL looks like \`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/\`.
3. If the gateway is authenticated, create a gateway token and paste it below.
4. In the gateway's **Providers** tab, add your provider keys.
5. List models with their provider prefix, e.g. \`openai/gpt-4o\`.`,
	},
	{
		type: 'xai',
		name: 'xAI (Grok)',
		logo: 'xai.png',
		key: 'required',
		fields: [],
		instructions: `1. Go to https://console.x.ai/.
2. Open **API Keys**, create a key, and paste it below.`,
	},
	{
		type: 'groq',
		name: 'Groq',
		logo: 'groq.svg',
		key: 'required',
		fields: [],
		instructions: `1. Go to https://console.groq.com/keys.
2. Create an API key and paste it below.`,
	},
	{
		type: 'openai-compatible',
		name: 'OpenAI Compatible',
		logo: 'openai-compatible.png',
		key: 'optional',
		fields: [
			{ id: 'baseUrl', label: 'Base URL', placeholder: 'https://my-proxy.example.com/v1' },
			{ id: 'headerName', label: 'API key header', placeholder: 'Authorization', optional: true },
		],
		instructions: `For any server that speaks the OpenAI chat completions API:

1. Set the base URL, including \`/v1\` if your server uses it.
2. Leave the header as **Authorization** to send \`Bearer <key>\`, or name the header your server expects.`,
	},
	{
		type: 'litellm',
		name: 'LiteLLM',
		logo: 'litellm.png',
		key: 'optional',
		fields: [{ id: 'baseUrl', label: 'LiteLLM URL', placeholder: 'http://localhost:4000' }],
		instructions: `Point Lens at a LiteLLM proxy. Enter its master or virtual key if the proxy requires one.`,
	},
	{
		type: 'ollama',
		name: 'Ollama',
		logo: 'ollama.svg',
		key: 'none',
		fields: [{ id: 'baseUrl', label: 'Ollama URL', placeholder: 'http://localhost:11434', optional: true }],
		instructions: `Runs models on your machine. Install Ollama from https://ollama.com and pull a model, e.g. \`ollama pull llama3.2\`.`,
	},
];
