export type BrowserReplTextChannel = "write" | "stdout" | "stderr";

export interface BrowserReplTextContent {
	type: "text";
	channel: BrowserReplTextChannel;
	text: string;
}

export interface BrowserReplImageContent {
	type: "image";
	mime_type: string;
	data_b64: string;
}

export type BrowserReplContent = BrowserReplTextContent | BrowserReplImageContent;

export interface BrowserReplRequest {
	code: string;
	timeout_sec?: number;
	reset?: boolean;
}

export interface BrowserReplResult {
	success: boolean;
	repl_id: string;
	error?: string;
	stack?: string;
	content?: BrowserReplContent[];
	content_truncated?: boolean;
	repl_terminated?: boolean;
	duration_ms?: number;
}

export interface BrowserReplEndpoint {
	base_url?: string;
	cdp_ws_url?: string;
}

export interface ExecuteBrowserReplOptions {
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

/** Execute one cell through the Browser REPL owned by a Kernel browser VM. */
export async function executeBrowserRepl(
	browser: BrowserReplEndpoint,
	request: BrowserReplRequest,
	options: ExecuteBrowserReplOptions = {},
): Promise<BrowserReplResult> {
	validateRequest(request);
	const endpoint = authenticatedReplUrl(browser);
	const response = await (options.fetch ?? fetch)(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
		signal: options.signal,
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Browser REPL request failed (${response.status}): ${responseError(body)}`);
	}
	const result: unknown = await response.json();
	if (!isBrowserReplResult(result)) throw new Error("Browser REPL returned an invalid response");
	return result;
}

function authenticatedReplUrl(browser: BrowserReplEndpoint): URL {
	if (!browser.base_url) throw new Error("browser has no base_url; Browser REPL is unavailable");
	if (!browser.cdp_ws_url) throw new Error("browser has no cdp_ws_url; Browser REPL authentication is unavailable");
	const cdpUrl = new URL(browser.cdp_ws_url);
	const jwt = cdpUrl.searchParams.get("jwt");
	if (!jwt) throw new Error("browser cdp_ws_url has no jwt; Browser REPL authentication is unavailable");
	const endpoint = new URL(`${browser.base_url.replace(/\/+$/, "")}/repl`);
	endpoint.searchParams.set("jwt", jwt);
	return endpoint;
}

function validateRequest(request: BrowserReplRequest): void {
	if (typeof request.code !== "string") throw new TypeError("Browser REPL code must be a string");
	if (request.code.length === 0 && request.reset !== true) throw new Error("Browser REPL code may be empty only when reset is true");
	if (request.timeout_sec !== undefined && (!Number.isInteger(request.timeout_sec) || request.timeout_sec < 1 || request.timeout_sec > 300)) {
		throw new RangeError("Browser REPL timeout_sec must be an integer between 1 and 300");
	}
	if (request.reset !== undefined && typeof request.reset !== "boolean") throw new TypeError("Browser REPL reset must be a boolean");
}

function isBrowserReplResult(value: unknown): value is BrowserReplResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const result = value as Record<string, unknown>;
	return typeof result.success === "boolean"
		&& typeof result.repl_id === "string"
		&& optionalType(result.error, "string")
		&& optionalType(result.stack, "string")
		&& optionalType(result.content_truncated, "boolean")
		&& optionalType(result.repl_terminated, "boolean")
		&& optionalType(result.duration_ms, "number")
		&& (result.content === undefined || (Array.isArray(result.content) && result.content.every(isBrowserReplContent)));
}

function isBrowserReplContent(value: unknown): value is BrowserReplContent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	if (item.type === "text") {
		return (item.channel === "write" || item.channel === "stdout" || item.channel === "stderr")
			&& typeof item.text === "string";
	}
	return item.type === "image"
		&& typeof item.mime_type === "string"
		&& item.mime_type.startsWith("image/")
		&& typeof item.data_b64 === "string";
}

function optionalType(value: unknown, type: "boolean" | "number" | "string"): boolean {
	return value === undefined || typeof value === type;
}

function responseError(body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
			return (parsed as { message: string }).message;
		}
	} catch {
		// Use the bounded response body below.
	}
	return body.slice(0, 8_192) || "empty response";
}
