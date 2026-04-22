/// browser-manager CLI — manages browser sessions via Noise_NX TCP to browser-manager
///
/// Config (env):
///   NOISE_ADDR              host:port of browser-manager Noise server (default: 127.0.0.1:8087)
///   NOISE_REMOTE_PUBLIC_KEY 32-byte hex — browser-manager public key
///
/// Or run `browser login` to authenticate via browser and save credentials.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "noise.h"
#include "args.h"

#define LOGIN_IMPLEMENTATION
#include "login.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET sock_t;
#define SOCK_INVALID INVALID_SOCKET
static void sock_init(void) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        fprintf(stderr, "error: WSAStartup failed\n");
        exit(1);
    }
}
static void sock_close(sock_t s) { closesocket(s); }
#else
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netdb.h>
typedef int sock_t;
#define SOCK_INVALID (-1)
#define sock_init() ((void)0)
static void sock_close(sock_t s) { close(s); }
#endif

#define MAX_FRAME (1024 * 1024)

static void fatal(const char *msg) {
    fprintf(stderr, "error: %s\n", msg);
    exit(1);
}

static int parse_positive_int(const char *s) {
    if (!s || !*s) return -1;
    char *end = NULL;
    long value = strtol(s, &end, 10);
    if (!end || *end || value <= 0 || value > 1000000) return -1;
    return (int)value;
}

static int hex_decode(uint8_t *out, size_t out_len, const char *hex) {
    size_t hex_len = strlen(hex);
    if (hex_len != out_len * 2) return -1;
    for (size_t i = 0; i < out_len; i++) {
        unsigned int byte;
        if (sscanf(hex + i * 2, "%2x", &byte) != 1) return -1;
        out[i] = (uint8_t)byte;
    }
    return 0;
}

static void hex_encode(char *out, const uint8_t *data, size_t len) {
    for (size_t i = 0; i < len; i++) sprintf(out + i * 2, "%02x", data[i]);
}

typedef struct {
    char *buf;
    size_t len, cap;
    int overflow;
} json_buf_t;

static void jb_init(json_buf_t *jb, char *buf, size_t cap) {
    jb->buf = buf; jb->len = 0; jb->cap = cap; jb->overflow = 0;
}

static void jb_raw(json_buf_t *jb, const char *s) {
    size_t n = strlen(s);
    if (jb->len + n >= jb->cap) { jb->overflow = 1; return; }
    memcpy(jb->buf + jb->len, s, n);
    jb->len += n;
}

static void jb_char(json_buf_t *jb, char c) {
    if (jb->len + 1 >= jb->cap) { jb->overflow = 1; return; }
    jb->buf[jb->len++] = c;
}

static void jb_escaped(json_buf_t *jb, const char *s) {
    jb_char(jb, '"');
    for (; *s; s++) {
        switch (*s) {
        case '"': jb_raw(jb, "\\\""); break;
        case '\\': jb_raw(jb, "\\\\"); break;
        case '\n': jb_raw(jb, "\\n"); break;
        case '\r': jb_raw(jb, "\\r"); break;
        case '\t': jb_raw(jb, "\\t"); break;
        default:
            if ((unsigned char)*s < 0x20) {
                char esc[7];
                snprintf(esc, sizeof(esc), "\\u%04x", (unsigned char)*s);
                jb_raw(jb, esc);
            } else jb_char(jb, *s);
        }
    }
    jb_char(jb, '"');
}

static void jb_str(json_buf_t *jb, const char *key, const char *val) {
    if (!val) return;
    jb_escaped(jb, key);
    jb_char(jb, ':');
    jb_escaped(jb, val);
    jb_char(jb, ',');
}

static void jb_int(json_buf_t *jb, const char *key, int val) {
    char num[32];
    snprintf(num, sizeof(num), "%d", val);
    jb_escaped(jb, key);
    jb_char(jb, ':');
    jb_raw(jb, num);
    jb_char(jb, ',');
}

static void jb_obj_open(json_buf_t *jb) { jb_char(jb, '{'); }
static void jb_obj_close(json_buf_t *jb) {
    if (jb->len > 0 && jb->buf[jb->len - 1] == ',') jb->len--;
    jb_char(jb, '}');
}

static int sock_recv_exact(sock_t fd, uint8_t *buf, size_t len) {
    size_t done = 0;
    while (done < len) {
        int n = recv(fd, (char *)buf + done, (int)(len - done), 0);
        if (n <= 0) return -1;
        done += (size_t)n;
    }
    return 0;
}

static int sock_send_all(sock_t fd, const uint8_t *buf, size_t len) {
    size_t done = 0;
    while (done < len) {
        int n = send(fd, (const char *)buf + done, (int)(len - done), 0);
        if (n <= 0) return -1;
        done += (size_t)n;
    }
    return 0;
}

static int write_frame(sock_t fd, const uint8_t *data, size_t len) {
    uint8_t hdr[4] = {
        (uint8_t)(len >> 24), (uint8_t)(len >> 16),
        (uint8_t)(len >> 8),  (uint8_t)len
    };
    if (sock_send_all(fd, hdr, 4) < 0) return -1;
    return sock_send_all(fd, data, len);
}

static int read_frame(sock_t fd, uint8_t **out, size_t *out_len) {
    uint8_t hdr[4];
    if (sock_recv_exact(fd, hdr, 4) < 0) return -1;
    uint32_t len = ((uint32_t)hdr[0] << 24) | ((uint32_t)hdr[1] << 16) |
                   ((uint32_t)hdr[2] << 8) | (uint32_t)hdr[3];
    if (len == 0 || len > MAX_FRAME) return -1;
    *out = malloc(len);
    if (!*out) return -1;
    if (sock_recv_exact(fd, *out, len) < 0) { free(*out); return -1; }
    *out_len = len;
    return 0;
}

static sock_t tcp_connect(const char *host, const char *port) {
    struct addrinfo hints = {0}, *res, *rp;
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, port, &hints, &res) != 0) return SOCK_INVALID;
    sock_t fd = SOCK_INVALID;
    for (rp = res; rp; rp = rp->ai_next) {
        fd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
        if (fd == SOCK_INVALID) continue;
        if (connect(fd, rp->ai_addr, (int)rp->ai_addrlen) == 0) break;
        sock_close(fd);
        fd = SOCK_INVALID;
    }
    freeaddrinfo(res);
    return fd;
}

static void print_response(const uint8_t *resp, size_t len) {
    fwrite(resp, 1, len, stdout);
    if (len == 0 || resp[len - 1] != '\n') putchar('\n');
}

static void run_cmd(const char *json_request, size_t req_len) {
    sock_init();

    const char *pub_hex = getenv("NOISE_REMOTE_PUBLIC_KEY");
    const char *addr_str = getenv("NOISE_ADDR");

    // Fall back to saved credentials from `browser login`
    login_credentials_t saved_creds;
    if ((!pub_hex || !addr_str) && login_load_credentials(&saved_creds) == 0) {
        if (!pub_hex && saved_creds.browser_manager_noise_public_key[0])
            pub_hex = saved_creds.browser_manager_noise_public_key;
        if (!addr_str && saved_creds.browser_manager_noise_addr[0])
            addr_str = saved_creds.browser_manager_noise_addr;
    }

    if (!pub_hex) fatal("NOISE_REMOTE_PUBLIC_KEY not set (run `browser login` or set env)");

    uint8_t remote_pub[32];
    if (hex_decode(remote_pub, 32, pub_hex) < 0) fatal("NOISE_REMOTE_PUBLIC_KEY: invalid hex");

    if (!addr_str) addr_str = "127.0.0.1:8087";
    char host[256], port_str[16];
    const char *colon = strrchr(addr_str, ':');
    if (!colon) fatal("NOISE_ADDR: missing port");
    size_t hlen = (size_t)(colon - addr_str);
    if (hlen >= sizeof(host)) fatal("NOISE_ADDR: host too long");
    memcpy(host, addr_str, hlen);
    host[hlen] = '\0';
    snprintf(port_str, sizeof(port_str), "%s", colon + 1);

    sock_t fd = tcp_connect(host, port_str);
    if (fd == SOCK_INVALID) fatal("connect failed");

    noise_handshake_t hs;
    noise_handshake_init(&hs, remote_pub);

    uint8_t m1_buf[256];
    int m1_len = noise_handshake_write(&hs, (const uint8_t *)"", 0, m1_buf, sizeof(m1_buf));
    if (m1_len < 0) fatal("handshake write failed");
    if (write_frame(fd, m1_buf, (size_t)m1_len) < 0) fatal("send handshake failed");

    uint8_t *m2_data;
    size_t m2_len;
    if (read_frame(fd, &m2_data, &m2_len) < 0) fatal("recv handshake failed");
    uint8_t p2_buf[64];
    if (noise_handshake_read(&hs, m2_data, m2_len, p2_buf, sizeof(p2_buf)) < 0) {
        free(m2_data);
        fatal("handshake read failed");
    }
    free(m2_data);

    noise_transport_t transport;
    if (noise_handshake_split(&hs, &transport) < 0) fatal("handshake split failed");

    uint8_t *enc_buf = malloc(req_len + 64);
    if (!enc_buf) fatal("malloc");
    int enc_len = noise_transport_write(&transport, enc_buf, req_len + 64,
        (const uint8_t *)json_request, req_len);
    if (enc_len < 0) { free(enc_buf); fatal("encrypt failed"); }
    if (write_frame(fd, enc_buf, (size_t)enc_len) < 0) { free(enc_buf); fatal("send failed"); }
    free(enc_buf);

    uint8_t *resp_enc;
    size_t resp_enc_len;
    if (read_frame(fd, &resp_enc, &resp_enc_len) < 0) fatal("recv failed");
    uint8_t *resp_dec = malloc(resp_enc_len);
    if (!resp_dec) { free(resp_enc); fatal("malloc"); }
    int resp_len = noise_transport_read(&transport, resp_dec, resp_enc_len, resp_enc, resp_enc_len);
    free(resp_enc);
    if (resp_len < 0) { free(resp_dec); fatal("decrypt failed"); }

    sock_close(fd);
    print_response(resp_dec, (size_t)resp_len);
    free(resp_dec);
}

static void build_and_run(const char *type, const char *payload_json, const char *token) {
    // Fall back to saved API key from `browser login`
    login_credentials_t saved_creds;
    if (!token && login_load_credentials(&saved_creds) == 0 && saved_creds.api_key[0])
        token = saved_creds.api_key;

    uint8_t id_bytes[4];
    if (noise_random(id_bytes, 4) < 0) fatal("RNG failed");
    char id_hex[9];
    hex_encode(id_hex, id_bytes, 4);
    id_hex[8] = '\0';

    char req[4096];
    json_buf_t jb;
    jb_init(&jb, req, sizeof(req));
    jb_obj_open(&jb);
    jb_str(&jb, "id", id_hex);
    jb_str(&jb, "type", type);
    jb_str(&jb, "token", token);
    jb_escaped(&jb, "payload");
    jb_char(&jb, ':');
    jb_raw(&jb, payload_json && payload_json[0] ? payload_json : "{}");
    jb_obj_close(&jb);
    if (jb.overflow) fatal("request too large");
    jb.buf[jb.len] = '\0';

    run_cmd(req, jb.len);
}

static void cmd_login(int argc, char **argv) {
    ketopt_t opt = KETOPT_INIT;
    ko_longopt_t longopts[] = {{ "help", ko_no_argument, 'h' }, { 0, 0, 0 }};
    int c;
    while ((c = ketopt(&opt, argc, argv, 1, "h", longopts)) >= 0) {
        if (c == 'h') { cli_usage(stdout, "browser", "login"); exit(0); }
        cli_parse_error("browser", "login", argc, argv, &opt, c);
    }

    const char *addr = getenv("NOISE_BACKEND_ADDR");
    const char *pub  = getenv("NOISE_BACKEND_PUBLIC_KEY");
    if (!addr) addr = "api.todofor.ai:4100";
    if (!pub)  pub  = "88e38a377ee697b448ec2779b625049110e05f77587a135df45994062b6bb76a";

    if (login_device_flow(addr, pub, "browser", NULL) != 0) exit(1);
}

static void usage(void) {
    fprintf(stdout,
        "Usage: browser <command> [options]\n"
        "\n"
        "Commands:\n"
        "  login\n"
        "  health\n"
        "  create --user <id> [--width <px> --height <px>] [--token <api-key>]\n"
        "  list [--user <id>] [--token <api-key>]\n"
        "  get <id> [--token <api-key>]\n"
        "  delete <id> [--token <api-key>]\n"
        "  delete-all --user <id> [--token <api-key>]\n"
        "  hibernate <id> [--token <api-key>]\n"
        "  restore <id> [--token <api-key>]\n"
        "  hibernated-list [--user <id>] [--token <api-key>]\n"
        "\n"
        "Global options:\n"
        "  -h, --help  Show help\n"
        "\n"
        "Env:\n"
        "  NOISE_ADDR              browser-manager Noise address (default: 127.0.0.1:8087)\n"
        "  NOISE_REMOTE_PUBLIC_KEY 32-byte hex server public key\n");
}

static void usage_health(void) { cli_usage(stdout, "browser", "health"); }
static void usage_list(const char *cmd) {
    char usage_buf[96];
    snprintf(usage_buf, sizeof(usage_buf), "%s [--user <id>] [--token <api-key>]", cmd);
    cli_usage(stdout, "browser", usage_buf);
}
static void usage_id(const char *cmd) {
    char usage_buf[96];
    snprintf(usage_buf, sizeof(usage_buf), "%s <id> [--token <api-key>]", cmd);
    cli_usage(stdout, "browser", usage_buf);
}
static void usage_delete_all(void) { cli_usage(stdout, "browser", "delete-all --user <id> [--token <api-key>]"); }
static void usage_create(void) { cli_usage(stdout, "browser", "create --user <id> [--width <px> --height <px>] [--token <api-key>]"); }

static void cmd_health(int argc, char **argv) {
    ketopt_t opt = KETOPT_INIT;
    ko_longopt_t longopts[] = {{ "help", ko_no_argument, 'h' }, { 0, 0, 0 }};
    int c;
    while ((c = ketopt(&opt, argc, argv, 1, "h", longopts)) >= 0) {
        if (c == 'h') { usage_health(); exit(0); }
        cli_parse_error("browser", "health", argc, argv, &opt, c);
    }
    if (opt.ind != argc) cli_usage_error("browser", "health", "unexpected argument");
    build_and_run("health.get", NULL, NULL);
}

static void cmd_list_like(const char *cmd, const char *type, int argc, char **argv) {
    const char *user = NULL, *token = NULL;
    char usage_buf[96], payload[256];
    ketopt_t opt = KETOPT_INIT;
    ko_longopt_t longopts[] = {
        { "help", ko_no_argument, 'h' },
        { "user", ko_required_argument, 'u' },
        { "token", ko_required_argument, 't' },
        { 0, 0, 0 }
    };
    int c;
    snprintf(usage_buf, sizeof(usage_buf), "%s [--user <id>] [--token <api-key>]", cmd);
    while ((c = ketopt(&opt, argc, argv, 1, "hu:t:", longopts)) >= 0) {
        if (c == 'h') { usage_list(cmd); exit(0); }
        if (c == 'u') { user = opt.arg; continue; }
        if (c == 't') { token = opt.arg; continue; }
        cli_parse_error("browser", usage_buf, argc, argv, &opt, c);
    }
    if (opt.ind != argc) cli_usage_error("browser", usage_buf, "unexpected argument");

    json_buf_t jb;
    jb_init(&jb, payload, sizeof(payload));
    jb_obj_open(&jb);
    jb_str(&jb, "user_id", user);
    jb_obj_close(&jb);
    if (jb.overflow) fatal("payload too large");
    payload[jb.len] = '\0';
    build_and_run(type, payload, token);
}

static void cmd_id_request(const char *cmd, const char *type, int argc, char **argv) {
    const char *id = NULL, *token = NULL;
    char usage_buf[96], payload[256];
    ketopt_t opt = KETOPT_INIT;
    ko_longopt_t longopts[] = {
        { "help", ko_no_argument, 'h' },
        { "token", ko_required_argument, 't' },
        { 0, 0, 0 }
    };
    int c;
    snprintf(usage_buf, sizeof(usage_buf), "%s <id> [--token <api-key>]", cmd);
    while ((c = ketopt(&opt, argc, argv, 1, "ht:", longopts)) >= 0) {
        if (c == 'h') { usage_id(cmd); exit(0); }
        if (c == 't') { token = opt.arg; continue; }
        cli_parse_error("browser", usage_buf, argc, argv, &opt, c);
    }
    if (opt.ind >= argc) cli_usage_error("browser", usage_buf, "missing <id>");
    id = argv[opt.ind++];
    if (opt.ind != argc) cli_usage_error("browser", usage_buf, "unexpected argument");

    json_buf_t jb;
    jb_init(&jb, payload, sizeof(payload));
    jb_obj_open(&jb);
    jb_str(&jb, "id", id);
    jb_obj_close(&jb);
    if (jb.overflow) fatal("payload too large");
    payload[jb.len] = '\0';
    build_and_run(type, payload, token);
}

static void cmd_delete_all(int argc, char **argv) {
    const char *user = NULL, *token = NULL;
    char payload[256];
    ketopt_t opt = KETOPT_INIT;
    ko_longopt_t longopts[] = {
        { "help", ko_no_argument, 'h' },
        { "user", ko_required_argument, 'u' },
        { "token", ko_required_argument, 't' },
        { 0, 0, 0 }
    };
    int c;
    while ((c = ketopt(&opt, argc, argv, 1, "hu:t:", longopts)) >= 0) {
        if (c == 'h') { usage_delete_all(); exit(0); }
        if (c == 'u') { user = opt.arg; continue; }
        if (c == 't') { token = opt.arg; continue; }
        cli_parse_error("browser", "delete-all --user <id> [--token <api-key>]", argc, argv, &opt, c);
    }
    if (opt.ind != argc) cli_usage_error("browser", "delete-all --user <id> [--token <api-key>]", "unexpected argument");
    if (!user) cli_usage_error("browser", "delete-all --user <id> [--token <api-key>]", "missing --user");

    json_buf_t jb;
    jb_init(&jb, payload, sizeof(payload));
    jb_obj_open(&jb);
    jb_str(&jb, "user_id", user);
    jb_obj_close(&jb);
    if (jb.overflow) fatal("payload too large");
    payload[jb.len] = '\0';
    build_and_run("browser.delete_all", payload, token);
}

static void cmd_create(int argc, char **argv) {
    const char *user = NULL, *token = NULL;
    const char *width_str = NULL, *height_str = NULL;
    int width = -1, height = -1;
    char payload[256];
    ketopt_t opt = KETOPT_INIT;
    ko_longopt_t longopts[] = {
        { "help", ko_no_argument, 'h' },
        { "user", ko_required_argument, 'u' },
        { "width", ko_required_argument, 'w' },
        { "height", ko_required_argument, 'g' },
        { "token", ko_required_argument, 't' },
        { 0, 0, 0 }
    };
    int c;
    while ((c = ketopt(&opt, argc, argv, 1, "hu:w:g:t:", longopts)) >= 0) {
        if (c == 'h') { usage_create(); exit(0); }
        if (c == 'u') { user = opt.arg; continue; }
        if (c == 'w') { width_str = opt.arg; continue; }
        if (c == 'g') { height_str = opt.arg; continue; }
        if (c == 't') { token = opt.arg; continue; }
        cli_parse_error("browser", "create --user <id> [--width <px> --height <px>] [--token <api-key>]", argc, argv, &opt, c);
    }
    if (opt.ind != argc) cli_usage_error("browser", "create --user <id> [--width <px> --height <px>] [--token <api-key>]", "unexpected argument");
    if (!user) cli_usage_error("browser", "create --user <id> [--width <px> --height <px>] [--token <api-key>]", "missing --user");
    if ((width_str && !height_str) || (!width_str && height_str)) {
        cli_usage_error("browser", "create --user <id> [--width <px> --height <px>] [--token <api-key>]", "--width and --height must be provided together");
    }
    if (width_str) {
        width = parse_positive_int(width_str);
        height = parse_positive_int(height_str);
        if (width <= 0 || height <= 0) {
            cli_usage_error("browser", "create --user <id> [--width <px> --height <px>] [--token <api-key>]", "--width and --height must be positive integers");
        }
    }

    json_buf_t jb;
    jb_init(&jb, payload, sizeof(payload));
    jb_obj_open(&jb);
    jb_str(&jb, "user_id", user);
    if (width_str) {
        jb_escaped(&jb, "viewport");
        jb_char(&jb, ':');
        jb_obj_open(&jb);
        jb_int(&jb, "width", width);
        jb_int(&jb, "height", height);
        jb_obj_close(&jb);
        jb_char(&jb, ',');
    }
    jb_obj_close(&jb);
    if (jb.overflow) fatal("payload too large");
    payload[jb.len] = '\0';
    build_and_run("browser.create", payload, token);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        usage();
        return 1;
    }
    if (cli_is_help(argv[1])) {
        usage();
        return 0;
    }

    if (!strcmp(argv[1], "login")) {
        cmd_login(argc - 1, argv + 1);
    } else if (!strcmp(argv[1], "health")) {
        cmd_health(argc - 1, argv + 1);
    } else if (!strcmp(argv[1], "create")) {
        cmd_create(argc - 1, argv + 1);
    } else if (!strcmp(argv[1], "list")) {
        cmd_list_like("list", "browser.list", argc - 1, argv + 1);
    } else if (!strcmp(argv[1], "get")) {
        cmd_id_request("get", "browser.get", argc - 1, argv + 1);
    } else if (!strcmp(argv[1], "delete")) {
        cmd_id_request("delete", "browser.delete", argc - 1, argv + 1);
    } else if (!strcmp(argv[1], "delete-all")) {
        cmd_delete_all(argc - 1, argv + 1);
    } else if (!strcmp(argv[1], "hibernate")) {
        cmd_id_request("hibernate", "browser.hibernate", argc - 1, argv + 1);
    } else if (!strcmp(argv[1], "restore")) {
        cmd_id_request("restore", "browser.restore", argc - 1, argv + 1);
    } else if (!strcmp(argv[1], "hibernated-list")) {
        cmd_list_like("hibernated-list", "browser.hibernated.list", argc - 1, argv + 1);
    } else {
        usage();
        return 1;
    }
    return 0;
}
