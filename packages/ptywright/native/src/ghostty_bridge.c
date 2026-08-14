#include "ghostty_bridge.h"

#include <ghostty/vt.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

static const uint32_t kCellWidthPx = 8;
static const uint32_t kCellHeightPx = 16;

enum {
	PTYWRIGHT_OSC_STATE_NONE = 0,
	PTYWRIGHT_OSC_STATE_ESC = 1,
	PTYWRIGHT_OSC_STATE_BODY = 2,
	PTYWRIGHT_OSC_STATE_ESC_IN_BODY = 3,
};

struct PtywrightGhosttyTerminal {
	GhosttyTerminal handle;
	GhosttyKeyEncoder encoder;
	uint8_t *reply_buf;
	size_t reply_len;
	size_t reply_cap;
	uint8_t *osc_buf;
	size_t osc_len;
	size_t osc_cap;
	int osc_state;
	int reply_error;
};

static int ptywright_ghostty_special_key(const char *name, GhosttyKey *out_key,
					 GhosttyMods *out_mods) {
	if (name == NULL || out_key == NULL || out_mods == NULL) {
		return GHOSTTY_INVALID_VALUE;
	}

	*out_mods = 0;
	if (strcmp(name, "arrow_up") == 0) {
		*out_key = GHOSTTY_KEY_ARROW_UP;
	} else if (strcmp(name, "arrow_down") == 0) {
		*out_key = GHOSTTY_KEY_ARROW_DOWN;
	} else if (strcmp(name, "arrow_left") == 0) {
		*out_key = GHOSTTY_KEY_ARROW_LEFT;
	} else if (strcmp(name, "arrow_right") == 0) {
		*out_key = GHOSTTY_KEY_ARROW_RIGHT;
	} else if (strcmp(name, "home") == 0) {
		*out_key = GHOSTTY_KEY_HOME;
	} else if (strcmp(name, "end") == 0) {
		*out_key = GHOSTTY_KEY_END;
	} else if (strcmp(name, "page_up") == 0) {
		*out_key = GHOSTTY_KEY_PAGE_UP;
	} else if (strcmp(name, "page_down") == 0) {
		*out_key = GHOSTTY_KEY_PAGE_DOWN;
	} else if (strcmp(name, "insert") == 0) {
		*out_key = GHOSTTY_KEY_INSERT;
	} else if (strcmp(name, "delete") == 0) {
		*out_key = GHOSTTY_KEY_DELETE;
	} else if (strcmp(name, "escape") == 0) {
		*out_key = GHOSTTY_KEY_ESCAPE;
	} else if (strcmp(name, "backtab") == 0) {
		*out_key = GHOSTTY_KEY_TAB;
		*out_mods = GHOSTTY_MODS_SHIFT;
	} else {
		return GHOSTTY_INVALID_VALUE;
	}
	return GHOSTTY_SUCCESS;
}

static int ptywright_ghostty_reserve_buffer(uint8_t **buf,
					    size_t *cap,
					    size_t needed) {
	if (needed <= *cap) {
		return GHOSTTY_SUCCESS;
	}

	size_t next_cap = *cap > 0 ? *cap : 64;
	while (next_cap < needed) {
		next_cap *= 2;
	}

	uint8_t *next = realloc(*buf, next_cap);
	if (next == NULL) {
		return GHOSTTY_OUT_OF_MEMORY;
	}

	*buf = next;
	*cap = next_cap;
	return GHOSTTY_SUCCESS;
}

static void ptywright_ghostty_on_write_pty(GhosttyTerminal ghostty_terminal,
					   void *userdata,
					   const uint8_t *data,
					   size_t len) {
	(void)ghostty_terminal;
	if (userdata == NULL || data == NULL || len == 0) {
		return;
	}

	PtywrightGhosttyTerminal *terminal = userdata;
	if (terminal->reply_error != GHOSTTY_SUCCESS) {
		return;
	}

	int result = ptywright_ghostty_reserve_buffer(&terminal->reply_buf,
						      &terminal->reply_cap,
						      terminal->reply_len + len);
	if (result != GHOSTTY_SUCCESS) {
		terminal->reply_error = result;
		return;
	}

	memcpy(terminal->reply_buf + terminal->reply_len, data, len);
	terminal->reply_len += len;
}

static int ptywright_ghostty_copy_string(GhosttyString source,
					 char **out_string,
					 size_t *out_len) {
	*out_string = NULL;
	*out_len = 0;

	if (source.ptr == NULL || source.len == 0) {
		return GHOSTTY_SUCCESS;
	}

	char *copy = malloc(source.len + 1);
	if (copy == NULL) {
		return GHOSTTY_OUT_OF_MEMORY;
	}

	memcpy(copy, source.ptr, source.len);
	copy[source.len] = '\0';
	*out_string = copy;
	*out_len = source.len;
	return GHOSTTY_SUCCESS;
}

static void ptywright_ghostty_finalize_osc(PtywrightGhosttyTerminal *terminal) {
	if (terminal->reply_error != GHOSTTY_SUCCESS) {
		terminal->osc_len = 0;
		return;
	}

	if (terminal->osc_len >= 2 &&
	    terminal->osc_buf[0] == '7' &&
	    terminal->osc_buf[1] == ';') {
		GhosttyString pwd = {
			.ptr = terminal->osc_buf + 2,
			.len = terminal->osc_len - 2,
		};
		int result = ghostty_terminal_set(terminal->handle,
						  GHOSTTY_TERMINAL_OPT_PWD,
						  &pwd);
		if (result != GHOSTTY_SUCCESS) {
			terminal->reply_error = result;
		}
	}

	terminal->osc_len = 0;
}

static void ptywright_ghostty_scan_for_pwd(PtywrightGhosttyTerminal *terminal,
					   const uint8_t *data,
					   size_t len) {
	for (size_t i = 0; i < len; i++) {
		if (terminal->reply_error != GHOSTTY_SUCCESS) {
			return;
		}

		const uint8_t byte = data[i];
		switch (terminal->osc_state) {
		case PTYWRIGHT_OSC_STATE_NONE:
			terminal->osc_state = byte == 0x1B ? PTYWRIGHT_OSC_STATE_ESC : PTYWRIGHT_OSC_STATE_NONE;
			break;
		case PTYWRIGHT_OSC_STATE_ESC:
			if (byte == ']') {
				terminal->osc_state = PTYWRIGHT_OSC_STATE_BODY;
				terminal->osc_len = 0;
			} else {
				terminal->osc_state = byte == 0x1B ? PTYWRIGHT_OSC_STATE_ESC : PTYWRIGHT_OSC_STATE_NONE;
			}
			break;
		case PTYWRIGHT_OSC_STATE_BODY:
			if (byte == 0x07) {
				ptywright_ghostty_finalize_osc(terminal);
				terminal->osc_state = PTYWRIGHT_OSC_STATE_NONE;
				break;
			}
			if (byte == 0x1B) {
				terminal->osc_state = PTYWRIGHT_OSC_STATE_ESC_IN_BODY;
				break;
			}
			if (ptywright_ghostty_reserve_buffer(&terminal->osc_buf,
							     &terminal->osc_cap,
							     terminal->osc_len + 1) != GHOSTTY_SUCCESS) {
				terminal->reply_error = GHOSTTY_OUT_OF_MEMORY;
				return;
			}
			terminal->osc_buf[terminal->osc_len++] = byte;
			break;
		case PTYWRIGHT_OSC_STATE_ESC_IN_BODY:
			if (byte == '\\') {
				ptywright_ghostty_finalize_osc(terminal);
				terminal->osc_state = PTYWRIGHT_OSC_STATE_NONE;
			} else {
				terminal->osc_len = 0;
				terminal->osc_state = byte == 0x1B ? PTYWRIGHT_OSC_STATE_ESC : PTYWRIGHT_OSC_STATE_NONE;
			}
			break;
		default:
			terminal->osc_state = PTYWRIGHT_OSC_STATE_NONE;
			terminal->osc_len = 0;
			break;
		}
	}
}

int ptywright_ghostty_terminal_create(uint16_t cols, uint16_t rows, size_t scrollback,
				      PtywrightGhosttyTerminal **out_terminal) {
	if (out_terminal == NULL || cols == 0 || rows == 0) {
		return GHOSTTY_INVALID_VALUE;
	}

	PtywrightGhosttyTerminal *terminal = calloc(1, sizeof(PtywrightGhosttyTerminal));
	if (terminal == NULL) {
		return GHOSTTY_OUT_OF_MEMORY;
	}

	GhosttyTerminalOptions options = {
		.cols = cols,
		.rows = rows,
		.max_scrollback = scrollback,
	};
	GhosttyResult result = ghostty_terminal_new(NULL, &terminal->handle, options);
	if (result != GHOSTTY_SUCCESS) {
		free(terminal);
		return result;
	}

	result = ghostty_terminal_set(terminal->handle,
				      GHOSTTY_TERMINAL_OPT_USERDATA,
				      terminal);
	if (result != GHOSTTY_SUCCESS) {
		ghostty_terminal_free(terminal->handle);
		free(terminal);
		return result;
	}

	GhosttyTerminalWritePtyFn write_pty = ptywright_ghostty_on_write_pty;
	result = ghostty_terminal_set(terminal->handle,
				      GHOSTTY_TERMINAL_OPT_WRITE_PTY,
				      (const void *)write_pty);
	if (result != GHOSTTY_SUCCESS) {
		ghostty_terminal_free(terminal->handle);
		free(terminal);
		return result;
	}

	result = ghostty_key_encoder_new(NULL, &terminal->encoder);
	if (result != GHOSTTY_SUCCESS) {
		ghostty_terminal_free(terminal->handle);
		free(terminal);
		return result;
	}

	*out_terminal = terminal;
	return GHOSTTY_SUCCESS;
}

int ptywright_ghostty_terminal_feed(PtywrightGhosttyTerminal *terminal,
				    const uint8_t *data, size_t len,
				    uint8_t **out_reply, size_t *out_reply_len) {
	if (terminal == NULL || terminal->handle == NULL || out_reply == NULL ||
	    out_reply_len == NULL || (data == NULL && len > 0)) {
		return GHOSTTY_INVALID_VALUE;
	}

	*out_reply = NULL;
	*out_reply_len = 0;
	terminal->reply_len = 0;
	terminal->reply_error = GHOSTTY_SUCCESS;
	ghostty_terminal_vt_write(terminal->handle, data, len);
	ptywright_ghostty_scan_for_pwd(terminal, data, len);
	if (terminal->reply_error != GHOSTTY_SUCCESS) {
		return terminal->reply_error;
	}

	if (terminal->reply_len == 0) {
		return GHOSTTY_SUCCESS;
	}

	uint8_t *reply = malloc(terminal->reply_len);
	if (reply == NULL) {
		return GHOSTTY_OUT_OF_MEMORY;
	}
	memcpy(reply, terminal->reply_buf, terminal->reply_len);
	*out_reply = reply;
	*out_reply_len = terminal->reply_len;
	return GHOSTTY_SUCCESS;
}

int ptywright_ghostty_terminal_resize(PtywrightGhosttyTerminal *terminal,
				      uint16_t cols, uint16_t rows) {
	if (terminal == NULL || terminal->handle == NULL || cols == 0 || rows == 0) {
		return GHOSTTY_INVALID_VALUE;
	}

	return ghostty_terminal_resize(terminal->handle, cols, rows, kCellWidthPx, kCellHeightPx);
}

int ptywright_ghostty_terminal_encode_special_key(PtywrightGhosttyTerminal *terminal,
						 const char *name,
						 uint8_t **out_bytes,
						 size_t *out_len) {
	if (terminal == NULL || terminal->handle == NULL || terminal->encoder == NULL ||
	    name == NULL || out_bytes == NULL || out_len == NULL) {
		return GHOSTTY_INVALID_VALUE;
	}

	*out_bytes = NULL;
	*out_len = 0;

	GhosttyKey key = GHOSTTY_KEY_UNIDENTIFIED;
	GhosttyMods mods = 0;
	int mapped = ptywright_ghostty_special_key(name, &key, &mods);
	if (mapped != GHOSTTY_SUCCESS) {
		return mapped;
	}

	GhosttyKeyEvent event = NULL;
	GhosttyResult result = ghostty_key_event_new(NULL, &event);
	if (result != GHOSTTY_SUCCESS) {
		return result;
	}

	ghostty_key_event_set_action(event, GHOSTTY_KEY_ACTION_PRESS);
	ghostty_key_event_set_key(event, key);
	ghostty_key_event_set_mods(event, mods);
	ghostty_key_encoder_setopt_from_terminal(terminal->encoder, terminal->handle);

	char stack[128];
	size_t written = 0;
	result = ghostty_key_encoder_encode(terminal->encoder, event, stack, sizeof(stack), &written);
	if (result == GHOSTTY_OUT_OF_SPACE) {
		char *dynamic = malloc(written > 0 ? written : 1);
		if (dynamic == NULL) {
			ghostty_key_event_free(event);
			return GHOSTTY_OUT_OF_MEMORY;
		}
		result = ghostty_key_encoder_encode(terminal->encoder, event, dynamic, written, &written);
		if (result != GHOSTTY_SUCCESS) {
			free(dynamic);
			ghostty_key_event_free(event);
			return result;
		}
		*out_bytes = (uint8_t *)dynamic;
		*out_len = written;
		ghostty_key_event_free(event);
		return GHOSTTY_SUCCESS;
	}
	if (result != GHOSTTY_SUCCESS) {
		ghostty_key_event_free(event);
		return result;
	}

	if (written == 0) {
		ghostty_key_event_free(event);
		return GHOSTTY_SUCCESS;
	}

	uint8_t *copy = malloc(written);
	if (copy == NULL) {
		ghostty_key_event_free(event);
		return GHOSTTY_OUT_OF_MEMORY;
	}
	memcpy(copy, stack, written);
	*out_bytes = copy;
	*out_len = written;
	ghostty_key_event_free(event);
	return GHOSTTY_SUCCESS;
}

int ptywright_ghostty_terminal_snapshot(PtywrightGhosttyTerminal *terminal,
					int trim, int unwrap,
					PtywrightGhosttySnapshot *out_snapshot) {
	if (terminal == NULL || terminal->handle == NULL || out_snapshot == NULL) {
		return GHOSTTY_INVALID_VALUE;
	}

	memset(out_snapshot, 0, sizeof(PtywrightGhosttySnapshot));

	GhosttyFormatterTerminalOptions options = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
	options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
	options.trim = trim != 0;
	options.unwrap = unwrap != 0;

	GhosttyFormatter formatter = NULL;
	GhosttyResult result = ghostty_formatter_terminal_new(NULL, &formatter, terminal->handle, options);
	if (result != GHOSTTY_SUCCESS) {
		return result;
	}

	size_t visible_len = 0;
	result = ghostty_formatter_format_buf(formatter, NULL, 0, &visible_len);
	if (result != GHOSTTY_SUCCESS && result != GHOSTTY_OUT_OF_SPACE) {
		ghostty_formatter_free(formatter);
		return result;
	}

	size_t alloc_len = visible_len > 0 ? visible_len : 1;
	uint8_t *visible = malloc(alloc_len);
	if (visible == NULL) {
		ghostty_formatter_free(formatter);
		return GHOSTTY_OUT_OF_MEMORY;
	}
	if (visible_len == 0) {
		visible[0] = '\0';
	}

	result = ghostty_formatter_format_buf(formatter, visible, visible_len, &visible_len);
	ghostty_formatter_free(formatter);
	if (result != GHOSTTY_SUCCESS) {
		free(visible);
		return result;
	}

	bool cursor_visible = false;
	uint16_t cols = 0;
	uint16_t rows = 0;
	uint16_t cursor_x = 0;
	uint16_t cursor_y = 0;
	size_t total_rows = 0;
	size_t scrollback_rows = 0;
	GhosttyString title = {0};
	GhosttyString pwd = {0};

	GhosttyTerminalData keys[] = {
		GHOSTTY_TERMINAL_DATA_COLS,
		GHOSTTY_TERMINAL_DATA_ROWS,
		GHOSTTY_TERMINAL_DATA_CURSOR_X,
		GHOSTTY_TERMINAL_DATA_CURSOR_Y,
		GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE,
		GHOSTTY_TERMINAL_DATA_TITLE,
		GHOSTTY_TERMINAL_DATA_PWD,
		GHOSTTY_TERMINAL_DATA_TOTAL_ROWS,
		GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS,
	};
	void *values[] = {
		&cols,
		&rows,
		&cursor_x,
		&cursor_y,
		&cursor_visible,
		&title,
		&pwd,
		&total_rows,
		&scrollback_rows,
	};
	size_t written = 0;
	result = ghostty_terminal_get_multi(terminal->handle,
					    sizeof(keys) / sizeof(keys[0]),
					    keys,
					    values,
					    &written);
	if (result != GHOSTTY_SUCCESS) {
		free(visible);
		return result;
	}

	result = ptywright_ghostty_copy_string(title,
					       &out_snapshot->title,
					       &out_snapshot->title_len);
	if (result != GHOSTTY_SUCCESS) {
		free(visible);
		return result;
	}

	result = ptywright_ghostty_copy_string(pwd,
					       &out_snapshot->pwd,
					       &out_snapshot->pwd_len);
	if (result != GHOSTTY_SUCCESS) {
		free(visible);
		free(out_snapshot->title);
		out_snapshot->title = NULL;
		out_snapshot->title_len = 0;
		return result;
	}

	out_snapshot->visible = (char *)visible;
	out_snapshot->visible_len = visible_len;
	out_snapshot->cols = cols;
	out_snapshot->rows = rows;
	out_snapshot->cursor_x = cursor_x;
	out_snapshot->cursor_y = cursor_y;
	out_snapshot->cursor_visible = cursor_visible ? 1 : 0;
	out_snapshot->total_rows = total_rows;
	out_snapshot->scrollback_rows = scrollback_rows;
	return GHOSTTY_SUCCESS;
}

void ptywright_ghostty_terminal_free_snapshot(PtywrightGhosttySnapshot *snapshot) {
	if (snapshot == NULL) {
		return;
	}

	if (snapshot->visible != NULL) {
		free(snapshot->visible);
		snapshot->visible = NULL;
	}
	snapshot->visible_len = 0;

	if (snapshot->title != NULL) {
		free(snapshot->title);
		snapshot->title = NULL;
	}
	snapshot->title_len = 0;

	if (snapshot->pwd != NULL) {
		free(snapshot->pwd);
		snapshot->pwd = NULL;
	}
	snapshot->pwd_len = 0;
}

void ptywright_ghostty_free_bytes(uint8_t *data) {
	if (data != NULL) {
		free(data);
	}
}

void ptywright_ghostty_terminal_destroy(PtywrightGhosttyTerminal *terminal) {
	if (terminal == NULL) {
		return;
	}

	if (terminal->encoder != NULL) {
		ghostty_key_encoder_free(terminal->encoder);
		terminal->encoder = NULL;
	}
	if (terminal->handle != NULL) {
		ghostty_terminal_free(terminal->handle);
		terminal->handle = NULL;
	}
	if (terminal->reply_buf != NULL) {
		free(terminal->reply_buf);
		terminal->reply_buf = NULL;
	}
	if (terminal->osc_buf != NULL) {
		free(terminal->osc_buf);
		terminal->osc_buf = NULL;
	}
	free(terminal);
}

const char *ptywright_ghostty_result_message(int result) {
	switch (result) {
	case GHOSTTY_SUCCESS:
		return "success";
	case GHOSTTY_OUT_OF_MEMORY:
		return "out of memory";
	case GHOSTTY_INVALID_VALUE:
		return "invalid value";
	case GHOSTTY_OUT_OF_SPACE:
		return "out of space";
	case GHOSTTY_NO_VALUE:
		return "no value";
	default:
		return "unknown error";
	}
}
