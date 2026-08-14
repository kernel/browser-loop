#ifndef ONKERNEL_PTYWRIGHT_GHOSTTY_BRIDGE_H
#define ONKERNEL_PTYWRIGHT_GHOSTTY_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PtywrightGhosttyTerminal PtywrightGhosttyTerminal;

typedef struct PtywrightGhosttySnapshot {
	char *visible;
	size_t visible_len;
	char *title;
	size_t title_len;
	char *pwd;
	size_t pwd_len;
	uint16_t cols;
	uint16_t rows;
	uint16_t cursor_x;
	uint16_t cursor_y;
	int cursor_visible;
	size_t total_rows;
	size_t scrollback_rows;
} PtywrightGhosttySnapshot;

int ptywright_ghostty_terminal_create(uint16_t cols, uint16_t rows, size_t scrollback,
				      PtywrightGhosttyTerminal **out_terminal);

int ptywright_ghostty_terminal_feed(PtywrightGhosttyTerminal *terminal,
				    const uint8_t *data, size_t len,
				    uint8_t **out_reply, size_t *out_reply_len);

int ptywright_ghostty_terminal_resize(PtywrightGhosttyTerminal *terminal,
				      uint16_t cols, uint16_t rows);

int ptywright_ghostty_terminal_encode_special_key(PtywrightGhosttyTerminal *terminal,
						 const char *name,
						 uint8_t **out_bytes,
						 size_t *out_len);

int ptywright_ghostty_terminal_snapshot(PtywrightGhosttyTerminal *terminal,
					int trim, int unwrap,
					PtywrightGhosttySnapshot *out_snapshot);

void ptywright_ghostty_terminal_free_snapshot(PtywrightGhosttySnapshot *snapshot);
void ptywright_ghostty_free_bytes(uint8_t *data);
void ptywright_ghostty_terminal_destroy(PtywrightGhosttyTerminal *terminal);
const char *ptywright_ghostty_result_message(int result);

#ifdef __cplusplus
}
#endif

#endif
