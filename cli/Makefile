ZIGCC ?= zig cc
# Version from git tag (v0.1.0 → 0.1.0); falls back to a sane default off-tree.
BROWSER_VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null | sed 's/^v//' || echo dev)
OPTFLAGS ?= -Oz -ffunction-sections -fdata-sections -fomit-frame-pointer -fno-unwind-tables -fno-asynchronous-unwind-tables -fno-ident
LDFLAGS ?= -Wl,--gc-sections -Wl,--build-id=none
WARNFLAGS ?= -Wall -Wextra -Wpedantic -Wshadow -Wformat=2 -Wno-unused-function
CFLAGS ?= $(OPTFLAGS) $(WARNFLAGS) -DBROWSER_VERSION=\"$(BROWSER_VERSION)\" -I../../todoforai-c-core/noise -I../../todoforai-c-core/cli -I../../todoforai-c-core/login
SRCS = main.c ../../todoforai-c-core/noise/noise.c ../../todoforai-c-core/noise/vendor/monocypher.c
HDRS = ../../todoforai-c-core/noise/noise.h
STRIP ?= strip --strip-all -R .comment -R .note -R .eh_frame

# Installed/published binary name. Matches the tool_catalog `binName` so the
# command on PATH is `browser-manager-cli` (distinct from `agent-browser`).
BIN = browser-manager-cli

TARGETS = \
	build/$(BIN)-linux-x86_64 \
	build/$(BIN)-linux-aarch64 \
	build/$(BIN)-darwin-x86_64 \
	build/$(BIN)-darwin-aarch64 \
	build/$(BIN)-windows-x86_64.exe

.PHONY: all linux macos windows clean

all: $(TARGETS)

linux: build/$(BIN)-linux-x86_64 build/$(BIN)-linux-aarch64
macos: build/$(BIN)-darwin-x86_64 build/$(BIN)-darwin-aarch64
windows: build/$(BIN)-windows-x86_64.exe

build/$(BIN)-linux-x86_64: $(SRCS) $(HDRS) | build
	$(ZIGCC) $(CFLAGS) $(LDFLAGS) -target x86_64-linux-musl -o $@ $(SRCS)
	$(STRIP) $@ 2>/dev/null || true

build/$(BIN)-linux-aarch64: $(SRCS) $(HDRS) | build
	$(ZIGCC) $(CFLAGS) $(LDFLAGS) -target aarch64-linux-musl -o $@ $(SRCS)
	$(STRIP) $@ 2>/dev/null || true

build/$(BIN)-darwin-x86_64: $(SRCS) $(HDRS) | build
	$(ZIGCC) $(CFLAGS) $(LDFLAGS) -target x86_64-macos -o $@ $(SRCS)
	$(STRIP) $@ 2>/dev/null || true

build/$(BIN)-darwin-aarch64: $(SRCS) $(HDRS) | build
	$(ZIGCC) $(CFLAGS) $(LDFLAGS) -target aarch64-macos -o $@ $(SRCS)
	$(STRIP) $@ 2>/dev/null || true

build/$(BIN)-windows-x86_64.exe: $(SRCS) $(HDRS) | build
	$(ZIGCC) $(CFLAGS) $(LDFLAGS) -target x86_64-windows-gnu -lws2_32 -ladvapi32 -o $@ $(SRCS)
	$(STRIP) $@ 2>/dev/null || true

build:
	mkdir -p build

clean:
	rm -rf build
