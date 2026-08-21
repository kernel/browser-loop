export * from "./core/actions/index";
export * from "./core/menu";
export * from "./core/model-info";
export * from "./core/tool-catalog";
export * from "./core/tools";
export { normalizeGotoUrl } from "./core/url";

// pi-flavored entry points: these shadow the star exports above, keeping
// provider-qualified model refs ("openai:gpt-5.5") and pi-supplied model
// availability working on this surface while src/core stays free of both.
export { compileLoopToolCatalog, loopToolMenu } from "./pi/catalog";
export { loop, type LoopNamespace } from "./pi/loop";
export { modelSupportsDeferredTools } from "./pi/models";

export type { LoopAgentTool, LoopHarnessTool } from "./pi/tool-manager";
export { LoopExecutionResources } from "./core/resources";
export type {
	LoopExecutableTool,
	LoopExecutionDetails,
	LoopToolExecutionResult,
	LoopToolResultContent,
} from "./core/resources";
export { formatBrowserActResult } from "./core/browser-result-format";
export type { KernelBrowser } from "./core/translator/translator";
export { InternalComputerTranslator } from "./core/translator/translator";
export { CdpConnection } from "./core/translator/cdp";
export { BrowserExecutor } from "./core/translator/browser";
export type { BrowserFindCandidate } from "./core/translator/browser";
export type { BrowserRefState } from "./core/translator/browser-ref-lifecycle";
export type {
	BatchExecutionResult,
	BatchReadResult,
	BrowserActExpectationEvidence,
	BrowserActExpectationStatus,
	BrowserActObservedSuccessor,
	BrowserActOutcome,
	BrowserActResult,
	BrowserActStepResult,
	BrowserActStopReason,
	BrowserActSuccessor,
	BrowserActUnavailableSuccessor,
	BrowserExpectationEvidence,
	BrowserExpectationState,
	BrowserObservationDiff,
	BrowserObservationDiffEntry,
	BrowserState,
	BrowserTabState,
	BrowserWaitForResult,
	BrowserWaitReason,
} from "./core/translator/types";
