import { describe, expect, it } from "vitest";
import { createMutationQueue } from "../src/tui/mutation-queue";

/** A promise plus its resolve/reject handles, for driving interleavings. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("createMutationQueue", () => {
	it("does not start a queued mutation until the previous one settles", async () => {
		const queue = createMutationQueue();
		const first = deferred();
		const events: string[] = [];

		const a = queue.run(async () => {
			events.push("a:start");
			await first.promise;
			events.push("a:end");
		});
		const b = queue.run(async () => {
			events.push("b:start");
		});

		// `b` must not have begun while `a` is still suspended. This is the whole
		// point: a `/tools` apply's setTools() must never land inside a `/model`
		// switch's setModel()/setTools() pair.
		await Promise.resolve();
		expect(events).toEqual(["a:start"]);

		first.resolve();
		await Promise.all([a, b]);
		expect(events).toEqual(["a:start", "a:end", "b:start"]);
	});

	it("surfaces a mutation's rejection to its own caller only", async () => {
		const queue = createMutationQueue();
		const failure = new Error("compile rejected");

		const a = queue.run(async () => {
			throw failure;
		});
		const b = queue.run(async () => "ok");

		await expect(a).rejects.toThrow("compile rejected");
		// A failed mutation must not wedge the queue or poison its successor.
		await expect(b).resolves.toBe("ok");
	});

	it("keeps ordering after a failure", async () => {
		const queue = createMutationQueue();
		const events: string[] = [];
		const blocked = deferred();

		const a = queue.run(async () => {
			events.push("a:start");
			await blocked.promise;
			throw new Error("boom");
		});
		const b = queue.run(async () => {
			events.push("b:start");
		});

		await Promise.resolve();
		expect(events).toEqual(["a:start"]);
		blocked.resolve();
		await expect(a).rejects.toThrow("boom");
		await b;
		expect(events).toEqual(["a:start", "b:start"]);
	});

	it("returns each mutation's own resolved value", async () => {
		const queue = createMutationQueue();
		const results = await Promise.all([queue.run(async () => 1), queue.run(async () => 2), queue.run(async () => 3)]);
		expect(results).toEqual([1, 2, 3]);
	});

	it("drains to idle", async () => {
		const queue = createMutationQueue();
		const gate = deferred();
		let done = false;
		void queue.run(async () => {
			await gate.promise;
			done = true;
		});
		gate.resolve();
		await queue.drain();
		expect(done).toBe(true);
	});
});
