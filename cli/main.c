/// browser-manager CLI — manages browser sessions via Noise_NX TCP.
///
/// Login is shared with the rest of TODOforAI (`todoforai-c-core/login`).
/// First run with no credentials triggers the device-login flow automatically.
/// The browser-manager's Noise pubkey is learned (TOFU) on the first RPC after
/// login and pinned thereafter — same model as the bridge daemon.
///
/// Env overrides (rarely needed):
///   BROWSER_NOISE_HOST   browser-manager host (default: bm.todofor.ai)
///   BROWSER_NOISE_PORT   browser-manager port (default: 4120 prod, 8630 dev)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "noise.h"
#include "args.h"

#define LOGIN_IMPLEMENTATION
#include "login.h"

#define DEFAULT_BROWSER_HOST     "bm.todofor.ai"
#define DEFAULT_BROWSER_PORT     "4120"
#define DEV_BROWSER_PORT         "8630"

static void fatal(const char *msg) { fprintf(stderr, "error: %s\n", msg); exit(1); }

static int parse_positive_int(const char *s) {
    if (!s || !*s) return -1;
    char *end = NULL;
    long v = strtol(s, &end, 10);
    if (!end || *end || v <= 0 || v > 1000000) return -1;
    return (int)v;
}

// Resolve browser-manager addr. Precedence: env > saved creds > default.
static void resolve_browser_addr(char *addr_buf, size_t cap,
                                 const login_credentials_t *creds) {
    const char *host = getenv("BROWSER_NOISE_HOST");
    const char *port = getenv("BROWSER_NOISE_PORT");
    if (!host && creds->browser_host[0]) host = creds->browser_host;
    if (!host) host = DEFAULT_BROWSER_HOST;
    if (!port) port = login_is_local_host(host) ? DEV_BROWSER_PORT : DEFAULT_BROWSER_PORT;
    snprintf(addr_buf, cap, "%s:%s", host, port);
}

// Auto-login on first use, then send one RPC. Fills resp_out (NUL-terminated)
// with the JSON response and returns its length (>=0). Exits on hard failure.
static int send_rpc_capture(const char *type, const char *payload_json,
                            char *resp_out, size_t resp_cap) {
    login_credentials_t creds;
    if (login_load_credentials(&creds) < 0 || !creds.api_token[0]) {
        fprintf(stderr, "No credentials found. Starting login...\n\n");
        const char *bh = getenv("NOISE_BACKEND_HOST");
        const char *bp = getenv("NOISE_BACKEND_PORT");
        char backend_addr[280];
        snprintf(backend_addr, sizeof(backend_addr), "%s:%s",
                 bh ? bh : LOGIN_DEFAULT_BACKEND_HOST,
                 bp ? bp : LOGIN_DEFAULT_NOISE_PORT);
        if (login_device_flow(backend_addr, "browser", NULL, NULL) != 0) exit(1);
        if (login_load_credentials(&creds) < 0 || !creds.api_token[0])
            fatal("login completed but no credentials saved");
    }

    char addr[280];
    resolve_browser_addr(addr, sizeof(addr), &creds);

    uint8_t id_bytes[4];
    if (noise_random(id_bytes, 4) < 0) fatal("RNG failed");
    char id_hex[9];
    login_hex_encode(id_hex, id_bytes, 4);

    char req[2048];
    int n = snprintf(req, sizeof(req),
        "{\"id\":\"%s\",\"type\":\"%s\",\"token\":\"%s\",\"payload\":%s}",
        id_hex, type, creds.api_token, payload_json && *payload_json ? payload_json : "{}");
    if (n < 0 || (size_t)n >= sizeof(req)) fatal("request too large");

    // TOFU on first call after login; pin thereafter.
    char learned_pub[65] = {0};
    int rn = login_oneshot_rpc(addr,
                               creds.browser_pubkey[0] ? creds.browser_pubkey : NULL,
                               req, (size_t)n, resp_out, resp_cap,
                               creds.browser_pubkey[0] ? NULL : learned_pub);
    if (rn < 0) exit(1);
    if (rn >= (int)resp_cap) rn = (int)resp_cap - 1;
    resp_out[rn] = '\0';

    // Persist newly-learned browser pubkey + host.
    if (!creds.browser_pubkey[0] && learned_pub[0]) {
        login_credentials_t upd;
        memset(&upd, 0, sizeof(upd));
        const char *colon = strrchr(addr, ':');
        size_t hlen = colon ? (size_t)(colon - addr) : strlen(addr);
        if (hlen >= sizeof(upd.browser_host)) hlen = sizeof(upd.browser_host) - 1;
        memcpy(upd.browser_host, addr, hlen);
        upd.browser_host[hlen] = '\0';
        snprintf(upd.browser_pubkey, sizeof(upd.browser_pubkey), "%s", learned_pub);
        (void)login_save_credentials(&upd);
    }

    return rn;
}

// Send an RPC and print the raw JSON response (legacy behavior for most cmds).
static void send_rpc(const char *type, const char *payload_json) {
    char resp[8192];
    send_rpc_capture(type, payload_json, resp, sizeof(resp));
    fputs(resp, stdout);
    size_t len = strlen(resp);
    if (len == 0 || resp[len - 1] != '\n') putchar('\n');
}

// ── Subcommands ──────────────────────────────────────────────────────────────

static void cmd_login(int argc, char **argv) {
    static const char *USAGE = "login";
    ko_longopt_t lo[] = {{ "help", ko_no_argument, 'h' }, { 0, 0, 0 }};
    ketopt_t opt = KETOPT_INIT; int c;
    while ((c = ketopt(&opt, argc, argv, 1, "h", lo)) >= 0) {
        if (c == 'h') { cli_usage(stdout, "browser", USAGE); exit(0); }
        cli_parse_error("browser", USAGE, argc, argv, &opt, c);
    }
    const char *bh = getenv("NOISE_BACKEND_HOST");
    const char *bp = getenv("NOISE_BACKEND_PORT");
    char addr[280];
    snprintf(addr, sizeof(addr), "%s:%s",
             bh ? bh : LOGIN_DEFAULT_BACKEND_HOST,
             bp ? bp : LOGIN_DEFAULT_NOISE_PORT);
    if (login_device_flow(addr, "browser", NULL, NULL) != 0) exit(1);
}

static void cmd_whoami(void) { if (login_print_whoami("browser") != 0) exit(1); }
static void cmd_logout(void) { if (login_logout("browser") != 0) exit(1); }

static void cmd_simple(const char *type, int argc, char **argv) {
    ko_longopt_t lo[] = {{ "help", ko_no_argument, 'h' }, { 0, 0, 0 }};
    ketopt_t opt = KETOPT_INIT; int c;
    while ((c = ketopt(&opt, argc, argv, 1, "h", lo)) >= 0) {
        if (c == 'h') { fprintf(stdout, "Usage: browser %s\n", type); exit(0); }
        cli_parse_error("browser", type, argc, argv, &opt, c);
    }
    if (opt.ind != argc) cli_usage_error("browser", type, "unexpected argument");
    send_rpc(type, "{}");
}

static void cmd_with_id(const char *type, int argc, char **argv) {
    ko_longopt_t lo[] = {{ "help", ko_no_argument, 'h' }, { 0, 0, 0 }};
    ketopt_t opt = KETOPT_INIT; int c;
    while ((c = ketopt(&opt, argc, argv, 1, "h", lo)) >= 0) {
        if (c == 'h') { fprintf(stdout, "Usage: browser %s <id>\n", type); exit(0); }
        cli_parse_error("browser", type, argc, argv, &opt, c);
    }
    if (opt.ind >= argc) cli_usage_error("browser", type, "missing <id>");
    const char *id = argv[opt.ind++];
    if (opt.ind != argc) cli_usage_error("browser", type, "unexpected argument");

    char payload[256];
    snprintf(payload, sizeof(payload), "{\"id\":\"%s\"}", id);
    send_rpc(type, payload);
}

static void cmd_create(int argc, char **argv) {
    const char *width_s = NULL, *height_s = NULL;
    ko_longopt_t lo[] = {
        { "help",   ko_no_argument,       'h' },
        { "width",  ko_required_argument, 'w' },
        { "height", ko_required_argument, 'g' },
        { 0, 0, 0 }
    };
    ketopt_t opt = KETOPT_INIT; int c;
    while ((c = ketopt(&opt, argc, argv, 1, "hw:g:", lo)) >= 0) {
        if (c == 'h') { fputs("Usage: browser create [--width <px> --height <px>]\n", stdout); exit(0); }
        if (c == 'w') { width_s = opt.arg; continue; }
        if (c == 'g') { height_s = opt.arg; continue; }
        cli_parse_error("browser", "create", argc, argv, &opt, c);
    }
    if (opt.ind != argc) cli_usage_error("browser", "create", "unexpected argument");
    if ((width_s && !height_s) || (!width_s && height_s))
        cli_usage_error("browser", "create", "--width and --height must be provided together");

    char payload[128];
    if (width_s) {
        int w = parse_positive_int(width_s), h = parse_positive_int(height_s);
        if (w <= 0 || h <= 0) cli_usage_error("browser", "create", "--width/--height must be positive");
        snprintf(payload, sizeof(payload), "{\"viewport\":{\"width\":%d,\"height\":%d}}", w, h);
    } else {
        snprintf(payload, sizeof(payload), "{}");
    }
    send_rpc("browser.create", payload);
}

// browser connect <id> [--exec]
// Resolves the session's CDP URL and prints (or runs) the agent-browser command.
static void cmd_connect(int argc, char **argv) {
    static const char *USAGE = "connect <id> [--exec]";
    int do_exec = 0;
    ko_longopt_t lo[] = {
        { "help", ko_no_argument, 'h' },
        { "exec", ko_no_argument, 'e' },
        { 0, 0, 0 }
    };
    ketopt_t opt = KETOPT_INIT; int c;
    while ((c = ketopt(&opt, argc, argv, 1, "he", lo)) >= 0) {
        if (c == 'h') { cli_usage(stdout, "browser", USAGE); exit(0); }
        if (c == 'e') { do_exec = 1; continue; }
        cli_parse_error("browser", "connect", argc, argv, &opt, c);
    }
    if (opt.ind >= argc) cli_usage_error("browser", "connect", "missing <id>");
    const char *id = argv[opt.ind++];
    if (opt.ind != argc) cli_usage_error("browser", "connect", "unexpected argument");

    char payload[256];
    snprintf(payload, sizeof(payload), "{\"id\":\"%s\"}", id);
    char resp[8192];
    send_rpc_capture("browser.get", payload, resp, sizeof(resp));

    char cdp_url[512] = {0};
    if (!json_find_string(resp, "cdpUrl", cdp_url, sizeof(cdp_url)) || !cdp_url[0]) {
        fputs(resp, stderr);
        if (resp[0] && resp[strlen(resp) - 1] != '\n') fputc('\n', stderr);
        fatal("no cdpUrl in response (session not found?)");
    }

    if (do_exec) {
        char cmd[640];
        snprintf(cmd, sizeof(cmd), "agent-browser connect '%s'", cdp_url);
        int rc = system(cmd);
        exit(rc == 0 ? 0 : 1);
    }
    printf("agent-browser connect '%s'\n", cdp_url);
}

static void usage(void) {
    printf("browser " BROWSER_VERSION " — TODO for AI browser CLI\n\n"
        "Usage: browser <command> [options]\n\n"
        "  login                       device login (auto-runs on first use)\n"
        "  logout                      remove credentials\n"
        "  whoami                      show the logged-in user\n"
        "  version                     show version\n\n"
        "  health\n"
        "  create [--width <px> --height <px>]\n"
        "  list\n"
        "  get <id>\n"
        "  connect <id> [--exec]       print (or run) the agent-browser connect command\n"
        "  delete <id>\n"
        "  delete-all\n"
        "  hibernate <id>\n"
        "  restore <id>\n"
        "  hibernated-list\n\n"
        "  -h, --help     show help\n"
        "  -v, --version  show version\n\n"
        "Env (rarely needed):\n"
        "  BROWSER_NOISE_HOST   browser-manager host (default: " DEFAULT_BROWSER_HOST ")\n"
        "  BROWSER_NOISE_PORT   browser-manager port (default: " DEFAULT_BROWSER_PORT ")\n");
}

int main(int argc, char **argv) {
    if (argc < 2)                              { usage(); return 1; }
    if (cli_is_help(argv[1]))                  { usage(); return 0; }
    if (!strcmp(argv[1], "--version") || !strcmp(argv[1], "-v") || !strcmp(argv[1], "version")) {
        printf("%s\n", BROWSER_VERSION); return 0;
    }

    const char *cmd = argv[1];
    int sub_argc = argc - 1;
    char **sub_argv = argv + 1;

    if      (!strcmp(cmd, "login"))           cmd_login(sub_argc, sub_argv);
    else if (!strcmp(cmd, "logout"))          cmd_logout();
    else if (!strcmp(cmd, "whoami"))          cmd_whoami();
    else if (!strcmp(cmd, "health"))          cmd_simple("health.get", sub_argc, sub_argv);
    else if (!strcmp(cmd, "create"))          cmd_create(sub_argc, sub_argv);
    else if (!strcmp(cmd, "list"))            cmd_simple("browser.list", sub_argc, sub_argv);
    else if (!strcmp(cmd, "get"))             cmd_with_id("browser.get", sub_argc, sub_argv);
    else if (!strcmp(cmd, "connect"))         cmd_connect(sub_argc, sub_argv);
    else if (!strcmp(cmd, "delete"))          cmd_with_id("browser.delete", sub_argc, sub_argv);
    else if (!strcmp(cmd, "delete-all"))      cmd_simple("browser.delete_all", sub_argc, sub_argv);
    else if (!strcmp(cmd, "hibernate"))       cmd_with_id("browser.hibernate", sub_argc, sub_argv);
    else if (!strcmp(cmd, "restore"))         cmd_with_id("browser.restore", sub_argc, sub_argv);
    else if (!strcmp(cmd, "hibernated-list")) cmd_simple("browser.hibernated.list", sub_argc, sub_argv);
    else { usage(); return 1; }
    return 0;
}
