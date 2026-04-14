ZIGCC ?= zig cc
OPTFLAGS ?= -Oz -ffunction-sections -fdata-sections -fomit-frame-pointer -fno-unwind-tables -fno-asynchronous-unwind-tables -fno-ident
LDFLAGS ?= -Wl,--gc-sections -Wl,--build-id=none
WARNFLAGS ?= -Wall -Wextra -Wpedantic -Wshadow -Wformat=2 -Wno-unused-function
CFLAGS ?= $(OPTFLAGS) $(WARNFLAGS) -I../../common/noise -I../../common/cli
SRCS = main.c ../../common/noise/noise.c ../../common/noise/vendor/blake2s.c ../../common/noise/vendor/monocypher.c
STRIP ?= strip --strip-all -R .comment -R .note -R .eh_frame

TARGETS = \
	build/browser-linux-x86_64 \
	build/browser-linux-aarch64 \
	build/browser-macos-x86_64 \
	build/browser-macos-aarch64 \
	build/browser-windows-x86_64.exe

.PHONY: all linux macos windows clean

all: $(TARGETS)

linux: build/browser-linux-x86_64 build/browser-linux-aarch64
macos: build/browser-macos-x86_64 build/browser-macos-aarch64
windows: build/browser-windows-x86_64.exe

build/browser-linux-x86_64: $(SRCS) ../../common/noise/noise.h | build
	$(ZIGCC) $(CFLAGS) $(LDFLAGS) -target x86_64-linux-musl -o $@ $(SRCS)
	$(STRIP) $@ 2>/dev/null || true

build/browser-linux-aarch64: $(SRCS) ../../common/noise/noise.h | build
	$(ZIGCC) $(CFLAGS) $(LDFLAGS) -target aarch64-linux-musl -o $@ $(SRCS)
	$(STRIP) $@ 2>/dev/null || true

build/browser-macos-x86_64: $(SRCS) ../../common/noise/noise.h | build
	$(ZIGCC) $(CFLAGS) $(LDFLAGS) -target x86_64-macos -o $@ $(SRCS)
	$(STRIP) $@ 2>/dev/null || true

build/browser-macos-aarch64: $(SRCS) ../../common/noise/noise.h | build
	$(ZIGCC) $(CFLAGS) $(LDFLAGS) -target aarch64-macos -o $@ $(SRCS)
	$(STRIP) $@ 2>/dev/null || true

build/browser-windows-x86_64.exe: $(SRCS) ../../common/noise/noise.h | build
	$(ZIGCC) $(CFLAGS) $(LDFLAGS) -target x86_64-windows-gnu -lws2_32 -ladvapi32 -o $@ $(SRCS)
	$(STRIP) $@ 2>/dev/null || true

build:
	mkdir -p build

clean:
	rm -rf build
