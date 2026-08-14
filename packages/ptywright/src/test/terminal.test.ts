import assert from "node:assert/strict";
import test from "node:test";
import { SpecialArrowUp, SpecialBacktab } from "../keys";
import { createTerminal } from "../terminal";

test("terminal snapshots formatted visible text", () => {
	const terminal = createTerminal({ cols: 40, rows: 6 });
	try {
		terminal.feed("hello\r\nworld");
		const snapshot = terminal.snapshot();
		assert.match(snapshot.visible, /hello/);
		assert.match(snapshot.visible, /world/);
		assert.equal(snapshot.width, 40);
		assert.equal(snapshot.height, 6);
	} finally {
		terminal.dispose();
	}
});

test("terminal snapshots include title and pwd metadata", () => {
	const terminal = createTerminal({ cols: 40, rows: 6 });
	try {
		terminal.feed("\x1b]2;hello title\x1b\\");
		terminal.feed("\x1b]7;file://localhost/tmp/ptywright\x1b\\");

		const snapshot = terminal.snapshot();
		assert.equal(snapshot.title, "hello title");
		assert.equal(snapshot.pwd, "file://localhost/tmp/ptywright");
		assert.ok(snapshot.totalRows >= snapshot.height);
		assert.ok(snapshot.scrollbackRows >= 0);
	} finally {
		terminal.dispose();
	}
});

test("encodeSpecialKey follows application cursor keys", () => {
	const terminal = createTerminal({ cols: 40, rows: 6 });
	try {
		const normal = Buffer.from(terminal.encodeSpecialKey(SpecialArrowUp)).toString("latin1");
		assert.equal(normal, "\x1b[A");

		terminal.feed("\x1b[?1h");
		const application = Buffer.from(terminal.encodeSpecialKey(SpecialArrowUp)).toString("latin1");
		assert.equal(application, "\x1bOA");

		terminal.feed("\x1b[?1l");
		const restored = Buffer.from(terminal.encodeSpecialKey(SpecialArrowUp)).toString("latin1");
		assert.equal(restored, "\x1b[A");

		const backtab = Buffer.from(terminal.encodeSpecialKey(SpecialBacktab)).toString("latin1");
		assert.equal(backtab, "\x1b[Z");
	} finally {
		terminal.dispose();
	}
});

test("terminal feed returns reply bytes for mode queries", () => {
	const terminal = createTerminal({ cols: 40, rows: 6 });
	try {
		const result = terminal.feed("\x1b[?7$p");
		assert.ok(result.replyBytes);
		const reply = Buffer.from(result.replyBytes).toString("latin1");
		assert.match(reply, /^\x1b\[\?7;[0-9]+\$y$/);
	} finally {
		terminal.dispose();
	}
});
