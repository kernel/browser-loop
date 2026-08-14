#include <algorithm>
#include <string>

#include <napi.h>

#include "ghostty_bridge.h"

namespace {

struct TerminalState {
	PtywrightGhosttyTerminal *terminal = nullptr;
};

void ThrowGhosttyError(Napi::Env env, const char *context, int result) {
	Napi::Error::New(env, std::string(context) + ": " + ptywright_ghostty_result_message(result))
		.ThrowAsJavaScriptException();
}

TerminalState *GetState(const Napi::CallbackInfo &info) {
	if (!info.Data()) {
		Napi::Error::New(info.Env(), "missing native terminal state").ThrowAsJavaScriptException();
		return nullptr;
	}
	return static_cast<TerminalState *>(info.Data());
}

bool EnsureOpen(Napi::Env env, TerminalState *state) {
	if (!state || !state->terminal) {
		Napi::Error::New(env, "terminal already disposed").ThrowAsJavaScriptException();
		return false;
	}
	return true;
}

void FinalizeState(Napi::Env, TerminalState *state) {
	if (!state) {
		return;
	}
	if (state->terminal) {
		ptywright_ghostty_terminal_destroy(state->terminal);
		state->terminal = nullptr;
	}
	delete state;
}

Napi::Value Feed(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	TerminalState *state = GetState(info);
	if (!EnsureOpen(env, state)) {
		return env.Undefined();
	}
	if (info.Length() < 1) {
		Napi::TypeError::New(env, "feed expects a string or Uint8Array").ThrowAsJavaScriptException();
		return env.Undefined();
	}

	int result = -1;
	uint8_t *reply = nullptr;
	size_t reply_len = 0;
	if (info[0].IsBuffer()) {
		Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
		result = ptywright_ghostty_terminal_feed(
			state->terminal,
			buffer.Data(),
			buffer.Length(),
			&reply,
			&reply_len);
	} else if (info[0].IsTypedArray()) {
		Napi::Uint8Array array = info[0].As<Napi::Uint8Array>();
		result = ptywright_ghostty_terminal_feed(
			state->terminal,
			array.Data(),
			array.ByteLength(),
			&reply,
			&reply_len);
	} else if (info[0].IsString()) {
		std::string text = info[0].As<Napi::String>().Utf8Value();
		result = ptywright_ghostty_terminal_feed(
			state->terminal,
			reinterpret_cast<const uint8_t *>(text.data()),
			text.size(),
			&reply,
			&reply_len);
	} else {
		Napi::TypeError::New(env, "feed expects a string or Uint8Array").ThrowAsJavaScriptException();
		return env.Undefined();
	}

	if (result != 0) {
		ThrowGhosttyError(env, "ptywright_ghostty_terminal_feed", result);
		ptywright_ghostty_free_bytes(reply);
		return env.Undefined();
	}

	if (reply == nullptr || reply_len == 0) {
		ptywright_ghostty_free_bytes(reply);
		return env.Undefined();
	}

	Napi::Buffer<uint8_t> output = Napi::Buffer<uint8_t>::Copy(env, reply, reply_len);
	ptywright_ghostty_free_bytes(reply);
	return output;
}

Napi::Value Resize(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	TerminalState *state = GetState(info);
	if (!EnsureOpen(env, state)) {
		return env.Undefined();
	}
	if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
		Napi::TypeError::New(env, "resize expects cols and rows").ThrowAsJavaScriptException();
		return env.Undefined();
	}

	uint16_t cols = static_cast<uint16_t>(std::max(1, info[0].As<Napi::Number>().Int32Value()));
	uint16_t rows = static_cast<uint16_t>(std::max(1, info[1].As<Napi::Number>().Int32Value()));
	int result = ptywright_ghostty_terminal_resize(state->terminal, cols, rows);
	if (result != 0) {
		ThrowGhosttyError(env, "ptywright_ghostty_terminal_resize", result);
	}
	return env.Undefined();
}

Napi::Value Snapshot(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	TerminalState *state = GetState(info);
	if (!EnsureOpen(env, state)) {
		return env.Null();
	}

	bool trim = false;
	bool unwrap = false;
	if (info.Length() >= 1 && info[0].IsObject()) {
		Napi::Object options = info[0].As<Napi::Object>();
		if (options.Has("trim")) {
			trim = options.Get("trim").ToBoolean().Value();
		}
		if (options.Has("unwrap")) {
			unwrap = options.Get("unwrap").ToBoolean().Value();
		}
	}

	PtywrightGhosttySnapshot snapshot{};
	int result = ptywright_ghostty_terminal_snapshot(
		state->terminal,
		trim ? 1 : 0,
		unwrap ? 1 : 0,
		&snapshot);
	if (result != 0) {
		ThrowGhosttyError(env, "ptywright_ghostty_terminal_snapshot", result);
		return env.Null();
	}

	Napi::Object cursor = Napi::Object::New(env);
	cursor.Set("x", Napi::Number::New(env, snapshot.cursor_x));
	cursor.Set("y", Napi::Number::New(env, snapshot.cursor_y));
	cursor.Set("visible", Napi::Boolean::New(env, snapshot.cursor_visible != 0));

	Napi::Object output = Napi::Object::New(env);
	output.Set("visible", Napi::String::New(env, snapshot.visible, snapshot.visible_len));
	output.Set("width", Napi::Number::New(env, snapshot.cols));
	output.Set("height", Napi::Number::New(env, snapshot.rows));
	output.Set("cursor", cursor);
	output.Set("totalRows", Napi::Number::New(env, snapshot.total_rows));
	output.Set("scrollbackRows", Napi::Number::New(env, snapshot.scrollback_rows));
	if (snapshot.title != nullptr && snapshot.title_len > 0) {
		output.Set("title", Napi::String::New(env, snapshot.title, snapshot.title_len));
	}
	if (snapshot.pwd != nullptr && snapshot.pwd_len > 0) {
		output.Set("pwd", Napi::String::New(env, snapshot.pwd, snapshot.pwd_len));
	}

	ptywright_ghostty_terminal_free_snapshot(&snapshot);
	return output;
}

Napi::Value EncodeSpecialKey(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	TerminalState *state = GetState(info);
	if (!EnsureOpen(env, state)) {
		return env.Undefined();
	}
	if (info.Length() < 1 || !info[0].IsString()) {
		Napi::TypeError::New(env, "encodeSpecialKey expects a key name").ThrowAsJavaScriptException();
		return env.Undefined();
	}

	std::string name = info[0].As<Napi::String>().Utf8Value();
	uint8_t *bytes = nullptr;
	size_t len = 0;
	int result = ptywright_ghostty_terminal_encode_special_key(
		state->terminal,
		name.c_str(),
		&bytes,
		&len);
	if (result != 0) {
		ThrowGhosttyError(env, "ptywright_ghostty_terminal_encode_special_key", result);
		ptywright_ghostty_free_bytes(bytes);
		return env.Undefined();
	}
	if (bytes == nullptr || len == 0) {
		ptywright_ghostty_free_bytes(bytes);
		return env.Undefined();
	}

	Napi::Buffer<uint8_t> output = Napi::Buffer<uint8_t>::Copy(env, bytes, len);
	ptywright_ghostty_free_bytes(bytes);
	return output;
}

Napi::Value Dispose(const Napi::CallbackInfo &info) {
	TerminalState *state = GetState(info);
	if (state && state->terminal) {
		ptywright_ghostty_terminal_destroy(state->terminal);
		state->terminal = nullptr;
	}
	return info.Env().Undefined();
}

Napi::Value CreateTerminal(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	if (info.Length() < 1 || !info[0].IsObject()) {
		Napi::TypeError::New(env, "options object is required").ThrowAsJavaScriptException();
		return env.Null();
	}

	Napi::Object options = info[0].As<Napi::Object>();
	uint16_t cols = static_cast<uint16_t>(std::max(1, options.Get("cols").ToNumber().Int32Value()));
	uint16_t rows = static_cast<uint16_t>(std::max(1, options.Get("rows").ToNumber().Int32Value()));
	size_t scrollback = options.Has("scrollback")
		? static_cast<size_t>(std::max<int64_t>(0, options.Get("scrollback").ToNumber().Int64Value()))
		: 0;

	auto *state = new TerminalState();
	int result = ptywright_ghostty_terminal_create(cols, rows, scrollback, &state->terminal);
	if (result != 0) {
		delete state;
		ThrowGhosttyError(env, "ptywright_ghostty_terminal_create", result);
		return env.Null();
	}

	Napi::Object object = Napi::Object::New(env);
	object.Set("_native", Napi::External<TerminalState>::New(env, state, FinalizeState));
	object.Set("feed", Napi::Function::New(env, Feed, "feed", state));
	object.Set("resize", Napi::Function::New(env, Resize, "resize", state));
	object.Set("snapshot", Napi::Function::New(env, Snapshot, "snapshot", state));
	object.Set("encodeSpecialKey", Napi::Function::New(env, EncodeSpecialKey, "encodeSpecialKey", state));
	object.Set("dispose", Napi::Function::New(env, Dispose, "dispose", state));
	return object;
}

} // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
	exports.Set("createTerminal", Napi::Function::New(env, CreateTerminal));
	return exports;
}

NODE_API_MODULE(ptywright_native, Init)
