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
#include <unistd.h>
#include "noise.h"
#include "args.h"

#define LOGIN_IMPLEMENTATION
#include "login.h"

#define DEFAULT_BROWSER_HOST     "bm.todofor.ai"
#define DEFAULT_BROWSER_PORT     "4120"
#define DEV_BROWSER_PORT         "8630"

static void fatal(const char *msg) { fprintf(stderr, "error: %s\n", msg); exit(1); }

static int g_json_output = 0;  // --json: print raw RPC responses instead of formatting

// Checked JSON builders: each fatals on overflow so a too-long argument can
// never push the write pointer past `end`. `end` points one past the last
// writable byte; helpers require the bytes they write to fit before `end`,
// leaving the caller room for a trailing NUL.
static void append_bytes(char **out, char *end, const char *s, size_t n) {
    if (n > (size_t)(end - *out)) fatal("proxy arguments too long");
    memcpy(*out, s, n);
    *out += n;
}

static void append_str(char **out, char *end, const char *s) {
    append_bytes(out, end, s, strlen(s));
}

// Append s as a JSON string body (no surrounding quotes), escaping the
// characters JSON forbids in a string. Fatals rather than truncate.
static void json_escape_into(char **out, char *end, const char *s) {
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if      (c == '"' || c == '\\') { char e[2] = { '\\', (char)c }; append_bytes(out, end, e, 2); }
        else if (c == '\n')             { append_bytes(out, end, "\\n", 2); }
        else if (c == '\r')             { append_bytes(out, end, "\\r", 2); }
        else if (c == '\t')             { append_bytes(out, end, "\\t", 2); }
        else if (c < 0x20)              { char e[7]; int n = snprintf(e, sizeof(e), "\\u%04x", c); append_bytes(out, end, e, (size_t)n); }
        else                            { append_bytes(out, end, (const char *)&c, 1); }
    }
}

static int parse_positive_int(const char *s) {
    if (!s || !*s) return -1;
    char *end = NULL;
    long v = strtol(s, &end, 10);
    if (!end || *end || v <= 0 || v > 1000000) return -1;
    return (int)v;
}

// Find a numeric field's value (e.g. `"width":1920`). Returns 1 and sets *out
// on success, 0 if the key is absent or not a plain number.
static int json_find_number(const char *json, const char *key, long *out) {
    char needle[128];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return 0;
    p += strlen(needle);
    while (*p == ' ' || *p == ':' || *p == '\t') p++;
    char *end = NULL;
    long v = strtol(p, &end, 10);
    if (end == p) return 0;
    *out = v;
    return 1;
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

// Send an RPC and print the raw JSON response verbatim (used for --json).
static void print_raw(const char *resp) {
    fputs(resp, stdout);
    size_t len = strlen(resp);
    if (len == 0 || resp[len - 1] != '\n') putchar('\n');
}

// One line per session, concise and script-friendly: status, cdpUrl, dims.
// Bounded to this object's span [obj, obj_end) so fields can't bleed across
// sessions in a list response.
static void print_session_line(const char *obj, const char *obj_end) {
    char tmp[4096];
    size_t span = obj_end ? (size_t)(obj_end - obj) : strlen(obj);
    if (span >= sizeof(tmp)) span = sizeof(tmp) - 1;
    memcpy(tmp, obj, span);
    tmp[span] = '\0';

    char status[32] = {0}, cdp[600] = {0};
    long w = 0, h = 0;
    json_find_string(tmp, "status", status, sizeof(status));
    json_find_string(tmp, "cdpUrl", cdp, sizeof(cdp));
    json_find_number(tmp, "width",  &w);
    json_find_number(tmp, "height", &h);

    printf("%s\t%s\t%ldx%ld\n", status[0] ? status : "?", cdp, w, h);
}

// Walk each session object in a browser.list-shaped response (array of objects
// keyed by "sessionId") and call fn(obj_start, obj_end) for each.
static void for_each_session(const char *resp, void (*fn)(const char *, const char *)) {
    const char *cur = resp;
    while ((cur = strstr(cur, "\"sessionId\"")) != NULL) {
        const char *next = strstr(cur + 1, "\"sessionId\"");
        fn(cur, next);
        if (!next) break;
        cur = next;
    }
}

// Hibernated sessions have no status/cdpUrl (browser process is gone) — just
// the last known url and viewport. One line: sessionId, url, WxH.
static void print_hibernated_line(const char *obj, const char *obj_end) {
    char tmp[4096];
    size_t span = obj_end ? (size_t)(obj_end - obj) : strlen(obj);
    if (span >= sizeof(tmp)) span = sizeof(tmp) - 1;
    memcpy(tmp, obj, span);
    tmp[span] = '\0';

    char sid[128] = {0}, url[512] = {0};
    long w = 0, h = 0;
    json_find_string(tmp, "sessionId", sid, sizeof(sid));
    json_find_string(tmp, "url", url, sizeof(url));
    json_find_number(tmp, "width",  &w);
    json_find_number(tmp, "height", &h);

    printf("%s\t%s\t%ldx%ld\n", sid, url, w, h);
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

// If the RPC response is an error envelope, print it (raw if --json, else a
// friendly "error: <message>" to stderr) and exit 1. Returns otherwise.
static void check_rpc_error(const char *resp) {
    if (!json_envelope_is_error(resp)) return;
    if (g_json_output) { print_raw(resp); exit(1); }
    char msg[512] = {0};
    json_find_string(resp, "message", msg, sizeof(msg));
    fprintf(stderr, "error: %s\n", msg[0] ? msg : resp);
    exit(1);
}

// browser status — whoami + every open session's ready-to-run connect command.
// Wired into the tool_catalog `statusCmd` so the agent's systemprompt lists
// live CDP endpoints it can use verbatim (the cdpUrl already carries the auth
// token in prod, so `agent-browser connect '<url>'` works out of the box).
static void cmd_status(int argc, char **argv) {
    ko_longopt_t lo[] = {{ "help", ko_no_argument, 'h' }, { 0, 0, 0 }};
    ketopt_t opt = KETOPT_INIT; int c;
    while ((c = ketopt(&opt, argc, argv, 1, "h", lo)) >= 0) {
        if (c == 'h') { fputs("Usage: browser status\n", stdout); exit(0); }
        cli_parse_error("browser", "status", argc, argv, &opt, c);
    }
    if (opt.ind != argc) cli_usage_error("browser", "status", "unexpected argument");

    if (g_json_output) {
        char resp[16384];
        send_rpc_capture("browser.list", "{}", resp, sizeof(resp));
        print_raw(resp);
        return;
    }

    // Auth signal first — exit non-zero (via login_print_whoami) marks the tool
    // unauthenticated in the catalog. Sessions are a best-effort add-on below.
    if (login_print_whoami("browser") != 0) exit(1);

    char resp[16384];
    send_rpc_capture("browser.list", "{}", resp, sizeof(resp));
    if (json_envelope_is_error(resp)) return;  // best-effort; whoami already succeeded

    if (!strstr(resp, "\"sessionId\"")) {
        printf("\nNo open browser sessions. Create one: browser-manager-cli create\n");
        return;
    }
    printf("\nOpen browser sessions (status / cdpUrl / dimensions):\n");
    for_each_session(resp, print_session_line);
}

static void cmd_simple(const char *type, const char *empty_msg, int argc, char **argv) {
    ko_longopt_t lo[] = {{ "help", ko_no_argument, 'h' }, { 0, 0, 0 }};
    ketopt_t opt = KETOPT_INIT; int c;
    while ((c = ketopt(&opt, argc, argv, 1, "h", lo)) >= 0) {
        if (c == 'h') { fprintf(stdout, "Usage: browser %s\n", type); exit(0); }
        cli_parse_error("browser", type, argc, argv, &opt, c);
    }
    if (opt.ind != argc) cli_usage_error("browser", type, "unexpected argument");

    char resp[16384];
    send_rpc_capture(type, "{}", resp, sizeof(resp));
    check_rpc_error(resp);
    if (g_json_output) { print_raw(resp); return; }

    if (!strcmp(type, "browser.list")) {
        if (!strstr(resp, "\"sessionId\"")) { puts(empty_msg); return; }
        for_each_session(resp, print_session_line);
    } else if (!strcmp(type, "browser.hibernated.list")) {
        if (!strstr(resp, "\"sessionId\"")) { puts(empty_msg); return; }
        for_each_session(resp, print_hibernated_line);
    } else if (!strcmp(type, "health.get")) {
        char status[32] = {0}, memory[32] = {0};
        long uptime = 0;
        json_find_string(resp, "status", status, sizeof(status));
        json_find_string(resp, "memory", memory, sizeof(memory));
        json_find_number(resp, "uptime", &uptime);
        printf("%s\tuptime=%lds\tmem=%s\n", status[0] ? status : "?", uptime, memory);
    } else if (!strcmp(type, "browser.delete_all")) {
        long deleted = 0;
        json_find_number(resp, "deleted", &deleted);
        printf("deleted %ld session%s\n", deleted, deleted == 1 ? "" : "s");
    } else {
        print_raw(resp);
    }
}

// What to print for a successful browser.<verb> response keyed by <id>.
typedef enum { RESULT_SESSION, RESULT_ACK } result_kind_t;

static void cmd_with_id(const char *type, result_kind_t kind, const char *ack_msg,
                        int argc, char **argv) {
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
    char resp[8192];
    send_rpc_capture(type, payload, resp, sizeof(resp));
    check_rpc_error(resp);
    if (g_json_output) { print_raw(resp); return; }

    if (kind == RESULT_SESSION) print_session_line(resp, NULL);
    else printf("%s %s\n", ack_msg, id);
}

static void cmd_create(int argc, char **argv) {
    static const char *USAGE =
        "create [--width <px> --height <px>] [--proxy <url>] [--proxy-user <u>] [--proxy-pass <p>]";
    const char *width_s = NULL, *height_s = NULL;
    const char *proxy = NULL, *proxy_user = NULL, *proxy_pass = NULL;
    ko_longopt_t lo[] = {
        { "help",       ko_no_argument,       'h' },
        { "width",      ko_required_argument, 'w' },
        { "height",     ko_required_argument, 'g' },
        { "proxy",      ko_required_argument, 'p' },
        { "proxy-user", ko_required_argument, 'u' },
        { "proxy-pass", ko_required_argument, 'x' },
        { 0, 0, 0 }
    };
    ketopt_t opt = KETOPT_INIT; int c;
    while ((c = ketopt(&opt, argc, argv, 1, "hw:g:p:u:x:", lo)) >= 0) {
        if (c == 'h') { cli_usage(stdout, "browser", USAGE); exit(0); }
        if (c == 'w') { width_s = opt.arg; continue; }
        if (c == 'g') { height_s = opt.arg; continue; }
        if (c == 'p') { proxy = opt.arg; continue; }
        if (c == 'u') { proxy_user = opt.arg; continue; }
        if (c == 'x') { proxy_pass = opt.arg; continue; }
        cli_parse_error("browser", "create", argc, argv, &opt, c);
    }
    if (opt.ind != argc) cli_usage_error("browser", "create", "unexpected argument");
    if ((width_s && !height_s) || (!width_s && height_s))
        cli_usage_error("browser", "create", "--width and --height must be provided together");
    if ((proxy_user || proxy_pass) && !proxy)
        cli_usage_error("browser", "create", "--proxy-user/--proxy-pass require --proxy");

    // Build the payload incrementally so viewport and stealth.proxy compose.
    // The server geoip-resolves locale/timezone from the proxy exit IP, so the
    // CLI only needs to pass the proxy itself. Every append is bounds-checked
    // (append_*/json_escape_into fatal on overflow); w_end reserves the last
    // byte for the trailing NUL written after the loop.
    char payload[1024];
    char *w_out = payload, *w_end = payload + sizeof(payload) - 1;
    append_str(&w_out, w_end, "{");
    if (width_s) {
        int w = parse_positive_int(width_s), h = parse_positive_int(height_s);
        if (w <= 0 || h <= 0) cli_usage_error("browser", "create", "--width/--height must be positive");
        char vp[64];
        snprintf(vp, sizeof(vp), "\"viewport\":{\"width\":%d,\"height\":%d}", w, h);
        append_str(&w_out, w_end, vp);
    }
    if (proxy) {
        if (w_out[-1] != '{') append_str(&w_out, w_end, ",");
        append_str(&w_out, w_end, "\"stealth\":{\"proxy\":{\"server\":\"");
        json_escape_into(&w_out, w_end, proxy);
        append_str(&w_out, w_end, "\"");
        if (proxy_user) {
            append_str(&w_out, w_end, ",\"username\":\"");
            json_escape_into(&w_out, w_end, proxy_user);
            append_str(&w_out, w_end, "\"");
        }
        if (proxy_pass) {
            append_str(&w_out, w_end, ",\"password\":\"");
            json_escape_into(&w_out, w_end, proxy_pass);
            append_str(&w_out, w_end, "\"");
        }
        append_str(&w_out, w_end, "}}");
    }
    append_str(&w_out, w_end, "}");
    *w_out = '\0';

    char resp[8192];
    send_rpc_capture("browser.create", payload, resp, sizeof(resp));
    check_rpc_error(resp);
    if (g_json_output) { print_raw(resp); return; }
    print_session_line(resp, NULL);
}

static void usage(void) {
    printf("browser-manager-cli " BROWSER_VERSION " — TODO for AI browser-manager CLI\n\n"
        "Usage: browser-manager-cli [--json] <command> [options]\n\n"
        "  login                       device login (auto-runs on first use)\n"
        "  logout                      remove credentials\n"
        "  whoami                      show the logged-in user\n"
        "  status                      whoami + one line per open session\n"
        "  version                     show version\n\n"
        "  health\n"
        "  create [--width <px> --height <px>] [--proxy <url> [--proxy-user <u>] [--proxy-pass <p>]]\n"
        "  list                        one line per session: status, cdpUrl, WxH\n"
        "  get <id>\n"
        "  delete <id>\n"
        "  delete-all\n"
        "  hibernate <id>\n"
        "  restore <id>\n"
        "  hibernated-list\n\n"
        "  --json         print raw JSON instead of human-readable output\n"
        "  -h, --help     show help\n"
        "  -v, --version  show version\n\n"
        "Env (rarely needed):\n"
        "  BROWSER_NOISE_HOST   browser-manager host (default: " DEFAULT_BROWSER_HOST ")\n"
        "  BROWSER_NOISE_PORT   browser-manager port (default: " DEFAULT_BROWSER_PORT ")\n");
}

// Strip a global `--json` flag from argv (it can appear anywhere), setting
// g_json_output and compacting the array in place. Returns the new argc.
static int strip_json_flag(int argc, char **argv) {
    int out = 0;
    for (int i = 0; i < argc; i++) {
        if (!strcmp(argv[i], "--json")) { g_json_output = 1; continue; }
        argv[out++] = argv[i];
    }
    return out;
}

int main(int argc, char **argv) {
    argc = strip_json_flag(argc, argv);
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
    else if (!strcmp(cmd, "status"))          cmd_status(sub_argc, sub_argv);
    else if (!strcmp(cmd, "health"))          cmd_simple("health.get", "status=unknown", sub_argc, sub_argv);
    else if (!strcmp(cmd, "create"))          cmd_create(sub_argc, sub_argv);
    else if (!strcmp(cmd, "list"))            cmd_simple("browser.list", "No open sessions. Create one: browser-manager-cli create", sub_argc, sub_argv);
    else if (!strcmp(cmd, "get"))             cmd_with_id("browser.get", RESULT_SESSION, NULL, sub_argc, sub_argv);
    else if (!strcmp(cmd, "delete"))          cmd_with_id("browser.delete", RESULT_ACK, "deleted", sub_argc, sub_argv);
    else if (!strcmp(cmd, "delete-all"))      cmd_simple("browser.delete_all", "deleted 0 sessions", sub_argc, sub_argv);
    else if (!strcmp(cmd, "hibernate"))       cmd_with_id("browser.hibernate", RESULT_ACK, "hibernated", sub_argc, sub_argv);
    else if (!strcmp(cmd, "restore"))         cmd_with_id("browser.restore", RESULT_SESSION, NULL, sub_argc, sub_argv);
    else if (!strcmp(cmd, "hibernated-list")) cmd_simple("browser.hibernated.list", "No hibernated sessions.", sub_argc, sub_argv);
    else { usage(); return 1; }
    return 0;
}
