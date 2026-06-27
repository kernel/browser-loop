import type { CuaAgentHarness, Session } from "@onkernel/cua-agent";
import type { ImageContent } from "@onkernel/cua-ai";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { HarnessExtensionHost } from "./host";

/**
 * Resolve extension directories + trust and construct+load a {@link HarnessExtensionHost}.
 *
 * Global extensions (`<getAgentDir()>/extensions`, i.e. `~/.pi/agent/extensions`)
 * load on every run: they are user-owned and trusted. Project-local extensions
 * are gated on trust because they execute arbitrary TypeScript in the CLI
 * process — both the implicit `<cwd>/.pi/extensions` (which the loader always
 * scans, suppressed via the host's `projectExtensionsTrusted` flag) and the
 * explicit `<cwd>/.agents/extensions` (added to `configuredPaths` only when
 * trusted, parallel to the project skills dir). Trust comes from an explicit
 * `--trust-extensions` opt-in or a persisted pi project-trust decision.
 *
 * No browser/auth/provisioning happens here, so a test can drive the exact load
 * path the CLI uses with a `buildTestHarness` fixture and temp dirs.
 */
export async function loadHarnessExtensions(args: {
	harness: CuaAgentHarness;
	session: Session;
	cwd: string;
	noExtensions: boolean;
	trustProject?: boolean;
	agentDir?: string;
	configuredPaths?: string[];
	initialScreenshot?: () => Promise<ImageContent[] | undefined>;
}): Promise<HarnessExtensionHost | undefined> {
	if (args.noExtensions) return undefined;
	const agentDir = args.agentDir ?? getAgentDir();
	const trusted = args.trustProject === true || new ProjectTrustStore(agentDir).get(args.cwd) === true;
	const configuredPaths =
		args.configuredPaths ?? (trusted ? [join(args.cwd, ".agents", "extensions")] : []);
	const host = new HarnessExtensionHost({
		harness: args.harness,
		session: args.session,
		cwd: args.cwd,
		configuredPaths,
		agentDir,
		projectExtensionsTrusted: trusted,
		initialScreenshot: args.initialScreenshot,
	});
	await host.load();
	return host;
}
