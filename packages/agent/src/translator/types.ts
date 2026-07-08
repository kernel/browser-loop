export type BatchReadResult =
	| { type: "screenshot"; data: Buffer; mimeType: string }
	| { type: "url"; url: string }
	| { type: "cursor_position"; x: number; y: number }
	| { type: "page_text"; label: string; text: string };

export interface BatchExecutionResult {
	readResults: BatchReadResult[];
}
