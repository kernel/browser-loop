import type { CuaAgentHarness, Session } from "@onkernel/cua-agent";
import type { ImageContent } from "@onkernel/cua-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { HarnessExtensionHost } from "./host";

/**
 * Resolve extension directories and construct + load a {@link HarnessExtensionHost}.
 *
 * Global extensions (`<getAgentDir()>/extensions`) and project-local extensions
 * (`<cwd>/.agents/extensions` plus the loader's implicit `<cwd>/.pi/extensions`
 * scan) all load on every run; `--no-extensions` opts out entirely. This is the
 * substrate for the self-improve loop: an agent writes a learned tool into the
 * project extension dir and it loads on the next run.
 *
 * No browser/auth/provisioning happens here, so a test can drive the exact load
 * path the CLI uses with a `buildTestHarness` fixture and temp dirs.
 */
export async function loadHarnessExtensions(args: {
	harness: CuaAgentHarness;
	session: Session;
	cwd: string;
	noExtensions: boolean;
	agentDir?: string;
	configuredPaths?: string[];
	initialScreenshot?: () => Promise<ImageContent[] | undefined>;
	selfExtend?: boolean;
}): Promise<HarnessExtensionHost | undefined> {
	if (args.noExtensions) return undefined;
	const agentDir = args.agentDir ?? getAgentDir();
	const configuredPaths = args.configuredPaths ?? [join(args.cwd, ".agents", "extensions")];
	const host = new HarnessExtensionHost({
		harness: args.harness,
		session: args.session,
		cwd: args.cwd,
		configuredPaths,
		agentDir,
		initialScreenshot: args.initialScreenshot,
		selfExtend: args.selfExtend,
	});
	await host.load();
	return host;
}
