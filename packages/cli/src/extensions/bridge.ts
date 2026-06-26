import type { AgentHarness } from "@onkernel/cua-agent";
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";

/**
 * State the bridge mutates while forwarding harness events into the runner.
 * `turnIndex` is host-owned because the harness `turn_start`/`turn_end` events
 * do not carry one, while the extension `TurnStartEvent`/`TurnEndEvent` require
 * it. `isIdle` is derived from `agent_start`/`agent_end` because the harness has
 * no synchronous idle predicate.
 */
export interface BridgeState {
	turnIndex: number;
	isIdle: boolean;
}

/**
 * Wire harness events into the runner's extension-event emitters and return a
 * single teardown function that detaches every listener.
 *
 * Two channels are used, matching how the harness dispatches:
 * - `subscribe()` (catch-all) for loop events and own observe-only events.
 *   This is also where tool persistence runs, gated on `model_update`.
 * - `on(type)` for the participating own events whose reduced result the
 *   harness applies (context, before_provider_payload, tool_call, tool_result).
 */
export function installBridge(
	harness: AgentHarness,
	runner: ExtensionRunner,
	state: BridgeState,
	reapplyTools: () => Promise<void>,
): () => void {
	const unsubscribes: Array<() => void> = [];

	unsubscribes.push(
		harness.subscribe(async (event) => {
			switch (event.type) {
				case "agent_start":
					state.turnIndex = 0;
					state.isIdle = false;
					await runner.emit({ type: "agent_start" });
					break;
				case "agent_end":
					state.isIdle = true;
					await runner.emit({ type: "agent_end", messages: event.messages });
					break;
				case "turn_start":
					await runner.emit({ type: "turn_start", turnIndex: state.turnIndex, timestamp: Date.now() });
					break;
				case "turn_end":
					await runner.emit({
						type: "turn_end",
						turnIndex: state.turnIndex,
						message: event.message,
						toolResults: event.toolResults,
					});
					state.turnIndex += 1;
					break;
				case "message_start":
					await runner.emit({ type: "message_start", message: event.message });
					break;
				case "message_update":
					await runner.emit({
						type: "message_update",
						message: event.message,
						assistantMessageEvent: event.assistantMessageEvent,
					});
					break;
				case "tool_execution_start":
					await runner.emit({
						type: "tool_execution_start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					});
					break;
				case "tool_execution_update":
					await runner.emit({
						type: "tool_execution_update",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						partialResult: event.partialResult,
					});
					break;
				case "tool_execution_end":
					await runner.emit({
						type: "tool_execution_end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result,
						isError: event.isError,
					});
					break;
				case "model_update":
					await runner.emit({
						type: "model_select",
						model: event.model,
						previousModel: event.previousModel,
						source: event.source,
					});
					// CuaAgentHarness.setModel rebuilds the tool list from
					// construction-time tools, dropping runtime-registered extension
					// tools. Re-apply the union after the rebuild has emitted
					// model_update. setModel emits only model_update (never
					// tools_update), so this triggers exactly one tools_update.
					await reapplyTools();
					break;
				case "thinking_level_update":
					await runner.emit({
						type: "thinking_level_select",
						level: event.level,
						previousLevel: event.previousLevel,
					});
					break;
				case "after_provider_response":
					await runner.emit({
						type: "after_provider_response",
						status: event.status,
						headers: event.headers,
					});
					break;
				default:
					break;
			}
		}),
	);

	unsubscribes.push(
		harness.on("context", async (event) => {
			const messages = await runner.emitContext(event.messages);
			return { messages };
		}),
	);

	unsubscribes.push(
		harness.on("before_provider_payload", async (event) => {
			const payload = await runner.emitBeforeProviderRequest(event.payload);
			return { payload };
		}),
	);

	unsubscribes.push(
		harness.on("tool_call", async (event) => {
			if (!runner.hasHandlers("tool_call")) return undefined;
			// Pass event.input by reference: tool_call handlers mutate it in place
			// to patch arguments, and the harness re-reads the same object.
			const result = await runner.emitToolCall({
				type: "tool_call",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				input: event.input,
			});
			return result ? { block: result.block, reason: result.reason } : undefined;
		}),
	);

	unsubscribes.push(
		harness.on("tool_result", async (event) => {
			if (!runner.hasHandlers("tool_result")) return undefined;
			const result = await runner.emitToolResult({
				type: "tool_result",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				input: event.input,
				content: event.content,
				details: event.details,
				isError: event.isError,
			});
			if (!result) return undefined;
			return {
				content: result.content,
				details: result.details,
				isError: result.isError ?? event.isError,
			};
		}),
	);

	return () => {
		for (const unsubscribe of unsubscribes) unsubscribe();
	};
}
