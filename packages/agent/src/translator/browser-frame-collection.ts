import { CdpProtocolError } from "./cdp";

/** Unexpected iframe collection failure with frame and collection-stage context. */
export class FrameCollectionError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "FrameCollectionError";
	}
}

/** Whether a CDP error is a known transient frame-disappearance race. */
export function isExpectedFrameCollectionError(
	error: unknown,
	method: "DOM.describeNode" | "Accessibility.getFullAXTree",
): error is CdpProtocolError {
	if (!(error instanceof CdpProtocolError) || error.method !== method) return false;
	const message = error.protocolMessage.trim();
	if (method === "DOM.describeNode") {
		return /^(?:Could not find node with given id|No node with given id found)\.?$/i.test(message);
	}
	return /^(?:Frame with the given id was not found|No frame for given id found|Session with given id not found|Target session terminated)\.?$/i.test(
		message,
	);
}

/** Wrap an unexpected iframe collection failure with actionable context. */
export function frameCollectionError(
	backendNodeId: number,
	frameId: string | undefined,
	stage: string,
	cause: unknown,
): FrameCollectionError {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return new FrameCollectionError(
		`Failed to collect iframe ${frameId ?? "with unknown frame id"} at backend node ${backendNodeId} during ${stage}: ${detail}`,
		cause,
	);
}
