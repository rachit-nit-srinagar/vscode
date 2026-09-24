export const BTW_COMMAND = 'btw';
export const BTW_DESCRIPTION = 'Ask a side question that skips this chat’s context';

export type AsideNote = {
	id: string;
	question: string;
	answer?: string;
	error?: string;
	loading: boolean;
};
