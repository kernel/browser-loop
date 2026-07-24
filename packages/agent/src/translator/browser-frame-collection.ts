import { CdpProtocolError } from "./cdp";

/**
 * Wraps unexpected iframe collection failures with context about which frame
 * and collection stage failed.
 */
export class FrameCollectionError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "FrameCollectionError";
	}
}

/**
 * True when a CDP error is one of the known transient "frame disappeared"
 * variants that should mark the frame as incomplete instead of failing the
 * whole observation.
 */
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

/**
 * Build a contextual {@link FrameCollectionError} for an unexpected iframe
 * collection failure.
 */
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
