import type { AgentHarness, AgentTool } from "@onkernel/cua-agent";
import {
	type ExtensionRunner,
	type RegisteredTool,
	wrapRegisteredTool,
	wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";

interface RegistrySnapshot {
	hostTool: AgentTool | undefined;
	extensionTools: AgentTool[];
	runtimeTools: Map<string, AgentTool>;
	inactiveExtensionTools: Set<string>;
}

/** Tool registry kept beside hooks, matching Pi's planned harness split. */
export class HarnessToolRegistry {
	private hostTool: AgentTool | undefined;
	private extensionTools: AgentTool[] = [];
	private runtimeTools = new Map<string, AgentTool>();
	private readonly inactiveExtensionTools = new Set<string>();
	private update = Promise.resolve();

	constructor(
		private readonly harness: AgentHarness,
		private readonly recordError: (path: string, error: string) => void,
	) {}

	setHostTool(tool: AgentTool | undefined): void {
		this.hostTool = tool;
	}

	hasToolName(name: string): boolean {
		return (
			this.harness.getTools().some((tool) => tool.name === name) ||
			this.runtimeTools.has(name)
		);
	}

	beginRunnerReplacement(hostTool: AgentTool | undefined): RegistrySnapshot {
		const snapshot = this.snapshot();
		this.hostTool = hostTool;
		this.extensionTools = [
			...this.extensionTools,
			...this.runtimeTools.values(),
		];
		this.runtimeTools.clear();
		this.inactiveExtensionTools.clear();
		return snapshot;
	}

	restore(snapshot: RegistrySnapshot): void {
		this.hostTool = snapshot.hostTool;
		this.extensionTools = snapshot.extensionTools;
		this.runtimeTools = new Map(snapshot.runtimeTools);
		this.inactiveExtensionTools.clear();
		for (const name of snapshot.inactiveExtensionTools) {
			this.inactiveExtensionTools.add(name);
		}
	}

	async installRuntimeTool(
		registration: RegisteredTool,
		runner: ExtensionRunner,
		isCurrent: () => boolean,
	): Promise<void> {
		const name = registration.definition.name;
		this.runtimeTools.set(name, wrapRegisteredTool(registration, runner));
		try {
			await this.reapply(runner, isCurrent);
		} catch (error) {
			this.runtimeTools.delete(name);
			await this.reapply(runner, isCurrent).catch(() => {});
			throw error;
		}
	}

	reapply(
		runner: ExtensionRunner,
		isCurrent: () => boolean,
	): Promise<void> {
		const next = this.update.then(() => this.applyNow(runner, isCurrent));
		this.update = next.catch(() => {});
		return next;
	}

	async waitForSettled(): Promise<void> {
		await this.update.catch(() => {});
	}

	async removeAll(): Promise<void> {
		const merged = new Set(this.ownedTools().map((tool) => tool.name));
		if (merged.size === 0) return;
		await this.mutateHarnessTools(async () => {
			const base = this.harness
				.getTools()
				.filter((tool) => !merged.has(tool.name));
			const active = this.harness
				.getActiveTools()
				.map((tool) => tool.name)
				.filter((name) => !merged.has(name));
			await this.harness.setTools(base, active);
		});
	}

	desiredActiveToolNames(runner: ExtensionRunner | undefined): string[] {
		const current = new Set(
			this.harness.getActiveTools().map((tool) => tool.name),
		);
		if (this.hostTool) current.add(this.hostTool.name);
		for (const tool of [...this.extensionTools, ...this.runtimeTools.values()]) {
			if (!this.inactiveExtensionTools.has(tool.name)) current.add(tool.name);
		}
		for (const registered of runner?.getAllRegisteredTools() ?? []) {
			if (!this.inactiveExtensionTools.has(registered.definition.name)) {
				current.add(registered.definition.name);
			}
		}
		return [...current];
	}

	async applyActiveTools(names: string[]): Promise<void> {
		await this.mutateHarnessTools(async () => {
			const active = new Set(names);
			for (const tool of [...this.extensionTools, ...this.runtimeTools.values()]) {
				if (active.has(tool.name)) this.inactiveExtensionTools.delete(tool.name);
				else this.inactiveExtensionTools.add(tool.name);
			}
			await this.harness.setActiveTools(names);
		});
	}

	private snapshot(): RegistrySnapshot {
		return {
			hostTool: this.hostTool,
			extensionTools: this.extensionTools,
			runtimeTools: new Map(this.runtimeTools),
			inactiveExtensionTools: new Set(this.inactiveExtensionTools),
		};
	}

	private ownedTools(): AgentTool[] {
		return [this.hostTool, ...this.extensionTools, ...this.runtimeTools.values()].filter(
			(tool): tool is AgentTool => tool !== undefined,
		);
	}

	private async applyNow(
		runner: ExtensionRunner,
		isCurrent: () => boolean,
	): Promise<void> {
		if (!isCurrent()) return;
		await this.mutateHarnessTools(async () => {
			if (!isCurrent()) return;
			const ownedBefore = new Set(this.ownedTools().map((tool) => tool.name));
			const base = this.harness
				.getTools()
				.filter((tool) => !ownedBefore.has(tool.name));
			const baseNames = new Set(base.map((tool) => tool.name));
			const reservedNames = new Set([
				...(this.hostTool ? [this.hostTool.name] : []),
				...this.runtimeTools.keys(),
			]);
			const diskTools = wrapRegisteredTools(
				runner.getAllRegisteredTools(),
				runner,
			).filter((tool) => {
				const collidesWith = reservedNames.has(tool.name)
					? "a host-provided tool"
					: baseNames.has(tool.name)
						? "a built-in tool"
						: undefined;
				if (!collidesWith) return true;
				this.recordError(
					tool.name,
					`extension tool "${tool.name}" collides with ${collidesWith} and was dropped`,
				);
				return false;
			});
			const runtimeTools = [...this.runtimeTools.values()];
			const final = [
				...base,
				...(this.hostTool ? [this.hostTool] : []),
				...diskTools,
				...runtimeTools,
			];
			const finalNames = new Set(final.map((tool) => tool.name));
			const activeNames = new Set(
				this.harness
					.getActiveTools()
					.map((tool) => tool.name)
					.filter((name) => finalNames.has(name)),
			);
			if (this.hostTool) activeNames.add(this.hostTool.name);
			for (const tool of [...diskTools, ...runtimeTools]) {
				if (!this.inactiveExtensionTools.has(tool.name)) {
					activeNames.add(tool.name);
				}
			}
			await this.harness.setTools(final, [...activeNames]);
			this.extensionTools = diskTools;
		});
	}

	private mutateHarnessTools<T>(mutation: () => Promise<T>): Promise<T> {
		const harness = this.harness as AgentHarness & {
			mutateTools?: <R>(callback: () => Promise<R>) => Promise<R>;
		};
		return harness.mutateTools ? harness.mutateTools(mutation) : mutation();
	}
}
