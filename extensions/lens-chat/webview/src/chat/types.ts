export type ToolStatus = 'pending' | 'running' | 'completed' | 'error' | string;

export type ChatPart = {
	id?: string;
	type: string;
	text?: string;
	tool?: string;
	callID?: string;
	filename?: string;
	mime?: string;
	url?: string;
	name?: string;
	prompt?: string;
	description?: string;
	state?: {
		status?: ToolStatus;
		input?: Record<string, unknown>;
		output?: string;
		title?: string;
		error?: string;
		metadata?: Record<string, unknown>;
		time?: { start?: number; end?: number };
	};
};

export type QuestionOption = {
	label: string;
	description?: string;
};

export type QuestionPrompt = {
	question: string;
	header?: string;
	options?: QuestionOption[];
	multiple?: boolean;
	custom?: boolean;
};

export type QuestionRequest = {
	id: string;
	sessionID?: string;
	questions: QuestionPrompt[];
	tool?: { messageID?: string; callID?: string };
};

export type ChatMessage = {
	info?: { role?: string; id?: string; time?: { created?: number; completed?: number }; error?: { name?: string; message?: string; data?: { message?: string } } };
	parts?: ChatPart[];
	role?: string;
};

export type TodoItem = {
	id?: string;
	content: string;
	status?: 'pending' | 'in_progress' | 'completed' | string;
};
