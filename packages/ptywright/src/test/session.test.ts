import assert from "node:assert/strict";
import test from "node:test";
import { KeyArrowUp, KeyCtrlD, SpecialArrowUp, spawnSession } from "../index";

test("session captures transcript and visible screen", async (t) => {
	const session = spawnSession({
		command: "/bin/sh",
		args: ["-lc", "printf 'ready\\n'; cat"],
		cols: 80,
		rows: 12,
	});
	t.after(() => session.close());

	await session.waitForVisible("ready", { timeoutMs: 5_000 });
	session.line("ping");
	await session.waitForTranscript("ping", { timeoutMs: 5_000 });

	const snapshot = session.snapshot();
	assert.match(snapshot.transcript, /ready/);
	assert.match(snapshot.transcript, /ping/);
	assert.match(snapshot.visible, /ping/);

	session.press(KeyCtrlD);
	const status = await session.waitForExit({ timeoutMs: 5_000 });
	assert.equal(status.exitCode, 0);
});

test("session resize updates the virtual terminal dimensions", async (t) => {
	const session = spawnSession({
		command: "/bin/sh",
		args: ["-lc", "printf 'resize-me\\n'; cat"],
		cols: 40,
		rows: 8,
	});
	t.after(() => session.close());

	await session.waitForVisible("resize-me", { timeoutMs: 5_000 });
	session.resize(100, 30);

	const snapshot = session.snapshot();
	assert.equal(snapshot.width, 100);
	assert.equal(snapshot.height, 30);
});

test("press leaves raw key strings unchanged", async (t) => {
	const script = [
		"import os, sys, termios, tty",
		"fd = sys.stdin.fileno()",
		"old = termios.tcgetattr(fd)",
		"try:",
		"    tty.setraw(fd)",
		"    os.write(sys.stdout.fileno(), b'\\nready\\n')",
		"    key = os.read(fd, 16)",
		"    os.write(sys.stdout.fileno(), b'\\nraw:' + key.hex().encode() + b'\\n')",
		"finally:",
		"    termios.tcsetattr(fd, termios.TCSANOW, old)",
	].join("\n");
	const session = spawnSession({
		command: "python3",
		args: ["-c", script],
		cols: 80,
		rows: 12,
	});
	t.after(() => session.close());

	await session.waitForVisible("ready", { timeoutMs: 5_000 });
	session.press(KeyArrowUp);
	await session.waitForTranscript("raw:", { timeoutMs: 5_000 });
	assert.match(session.snapshot().transcript, /raw:1b5b41/);
});

test("pressKey encodes arrows from live DECCKM state", async (t) => {
	const script = [
		"import os, sys, termios, tty",
		"fd = sys.stdin.fileno()",
		"old = termios.tcgetattr(fd)",
		"try:",
		"    tty.setraw(fd)",
		"    os.write(sys.stdout.fileno(), b'\\x1b[?1h')",
		"    os.write(sys.stdout.fileno(), b'\\nready-app\\n')",
		"    app = os.read(fd, 16)",
		"    os.write(sys.stdout.fileno(), b'\\napp:' + app.hex().encode() + b'\\n')",
		"    os.write(sys.stdout.fileno(), b'\\x1b[?1l')",
		"    os.write(sys.stdout.fileno(), b'\\nready-norm\\n')",
		"    norm = os.read(fd, 16)",
		"    os.write(sys.stdout.fileno(), b'\\nnorm:' + norm.hex().encode() + b'\\n')",
		"finally:",
		"    termios.tcsetattr(fd, termios.TCSANOW, old)",
	].join("\n");
	const session = spawnSession({
		command: "python3",
		args: ["-c", script],
		cols: 80,
		rows: 12,
	});
	t.after(() => session.close());

	await session.waitForVisible("ready-app", { timeoutMs: 5_000 });
	session.pressKey(SpecialArrowUp);
	await session.waitForTranscript("ready-norm", { timeoutMs: 5_000 });
	session.pressKey(SpecialArrowUp);
	await session.waitForTranscript("norm:", { timeoutMs: 5_000 });

	const transcript = session.snapshot().transcript;
	assert.match(transcript, /app:1b4f41/);
	assert.match(transcript, /norm:1b5b41/);
});

test("session writes terminal query replies back to the child PTY", async (t) => {
	const script = [
		"import os, sys, termios, tty",
		"fd = sys.stdin.fileno()",
		"old = termios.tcgetattr(fd)",
		"try:",
		"    tty.setraw(fd)",
		"    os.write(sys.stdout.fileno(), b'\\x1b[?7$p')",
		"    reply = os.read(fd, 64)",
		"    os.write(sys.stdout.fileno(), b'\\nreply:' + reply.hex().encode() + b'\\n')",
		"finally:",
		"    termios.tcsetattr(fd, termios.TCSANOW, old)",
	].join("\n");
	const session = spawnSession({
		command: "python3",
		args: ["-c", script],
		cols: 80,
		rows: 12,
	});
	t.after(() => session.close());

	await session.waitForTranscript("reply:", { timeoutMs: 5_000 });
	const snapshot = session.snapshot();
	assert.match(snapshot.transcript, /reply:1b5b3f373b[0-9a-f]+2479/);

	const status = await session.waitForExit({ timeoutMs: 5_000 });
	assert.equal(status.exitCode, 0);
});
