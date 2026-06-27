import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Meta-agent-authored learned tool: `fill_signup_form`.
 *
 * Stands in for what a self-improve meta-agent would write after watching an
 * agent fill the same signup form the slow way: one click+type pair per field
 * (name, email) followed by a submit click. The meta-agent notices the field
 * layout is fixed across runs and bakes those observed coordinates into a macro
 * that takes the field values in one object and emits the full ordered action
 * plan, so the next run issues a single tool call instead of N click/type steps.
 *
 * Why a plain JSON-Schema object literal and `import type` only: the file is
 * loaded from an isolated temp directory by the jiti loader, which resolves
 * imports relative to that directory, not the cua workspace. A runtime import of
 * a workspace package would be unresolvable there. Keeping the import type-only
 * (erased at load) and declaring parameters inline avoids any runtime resolution.
 *
 * Why pure JS rather than playwright_execute: this test harness is built without
 * `playwright: true` and its fake Kernel client has no daemon, so there is no
 * page to drive. The coordinates below are the layout the meta-agent learned by
 * observing the first run's clicks; building the action plan from the supplied
 * values is the real routine the learned tool would run before dispatching the
 * clicks/types to the page. The plan it returns is what the next run executes in
 * place of the per-field grind.
 */

// The form layout the meta-agent observed in the first run: each field's click
// target plus the submit button. Baked into the tool because the form is fixed
// across runs — this is exactly the knowledge a self-improve pass distills.
const FORM_LAYOUT = {
	fields: [
		{ key: "name", x: 220, y: 140 },
		{ key: "email", x: 220, y: 200 },
	],
	submit: { x: 220, y: 260 },
} as const;

type PlanAction =
	| { action: "click"; x: number; y: number }
	| { action: "type"; text: string };

export default function fillForm(pi: ExtensionAPI): void {
	let agentRuns = 0;

	pi.on("agent_start", () => {
		agentRuns += 1;
	});

	pi.on("agent_end", (_event, ctx) => {
		// Headless host: ctx.hasUI is false, so this notify never fires here. The
		// guard keeps the same extension usable under a TUI host unchanged.
		if (ctx.hasUI) ctx.ui.notify(`form fills: ${agentRuns}`, "info");
	});

	pi.registerTool({
		name: "fill_signup_form",
		label: "Fill signup form",
		description:
			"Fill the signup form's known fields from a values object in one call. " +
			"Replaces a per-field click/type sequence plus a submit click with a " +
			"single ordered action plan.",
		parameters: {
			type: "object",
			properties: {
				values: {
					type: "object",
					description: "Field values keyed by field name.",
					properties: {
						name: { type: "string", description: "Value for the name field" },
						email: { type: "string", description: "Value for the email field" },
					},
					required: ["name", "email"],
					additionalProperties: false,
				},
			},
			required: ["values"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const { values } = params as { values: Record<string, string> };
			const plan = buildFillPlan(values);
			return {
				content: [{ type: "text", text: `planned ${plan.length} actions` }],
				details: { plan, agentRuns },
			};
		},
	});
}

/**
 * Build the ordered action plan that fills the form. For each known field the
 * macro clicks the field's baked coordinate then types the supplied value;
 * after all fields it clicks submit. Fields whose value is absent are skipped so
 * a partial values object still produces a valid plan. The result is the exact
 * click/type sequence the slow run performed by hand, collapsed into one call.
 */
function buildFillPlan(values: Record<string, string>): PlanAction[] {
	const plan: PlanAction[] = [];
	for (const field of FORM_LAYOUT.fields) {
		const text = values[field.key];
		if (text === undefined) continue;
		plan.push({ action: "click", x: field.x, y: field.y });
		plan.push({ action: "type", text });
	}
	plan.push({ action: "click", x: FORM_LAYOUT.submit.x, y: FORM_LAYOUT.submit.y });
	return plan;
}
