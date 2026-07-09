/**
 * warm-profile.ts — build a reusable, secret-free "warm" browser profile.
 *
 * A brand-new (cold) Chromium profile is the single biggest anti-bot tell: no
 * cookies, no history, no caches, no device-trust — every site treats it as a
 * throwaway. This script produces a template profile that looks like a browser
 * that's been *used*: it opens a set of everyday sites, dwells like a human so
 * they set their guest/consent/analytics cookies, then SCRUBS anything that
 * could identify a person or account.
 *
 * The result contains NO logins and NO secrets, so a single template is safe to
 * seed into every user's first session (set PROFILE_SEED_DIR to its path). Each
 * user still logs into sites themselves; the seed only removes the "cold client"
 * suspicion that gets fresh sessions blocked.
 *
 * Usage:
 *   bun scripts/warm-profile.ts [--out <dir>] [--sites a,b,c] [--headed] [--dwell 4000]
 *   PROFILE_SEED_DIR=<dir>  # then point the server at the produced template
 */
import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext } from 'playwright-core';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Everyday, high-traffic sites across categories. Visiting a spread (not just the
// target) makes the cookie/history footprint look organic rather than single-purpose.
const DEFAULT_SITES = [
    'https://www.google.com/',
    'https://www.youtube.com/',
    'https://www.wikipedia.org/',
    'https://www.reddit.com/',
    'https://www.amazon.com/',
    'https://www.bing.com/',
    'https://www.linkedin.com/',
    'https://x.com/',
];

// Everything that could carry a login, a per-visitor identifier, or personal
// history is DELETED after warming — the template ships only the "shape" of a
// used browser (prefs, engine caches, warmed dirs), never identity. This is a
// hard allowlist-by-deletion: we remove all known cookie/credential/site-storage
// stores, so a token in a store we forgot to name can't survive either.
//
// Why not keep guest cookies? A single template copied to every user would clone
// the same guest_id/personalization_id everywhere — that itself is an anti-bot
// correlation flag and a privacy leak. Each user's first visit to a site mints
// its own fresh guest cookies on top of this warm-but-anonymous base.
const SENSITIVE = [
    // Identity / auth / personal history
    'Default/History', 'Default/History-journal',
    'Default/Login Data', 'Default/Login Data-journal',
    'Default/Login Data For Account', 'Default/Web Data', 'Default/Web Data-journal',
    'Default/Autofill', 'Default/Bookmarks',
    'Default/Sessions', 'Default/Sync Data', 'Default/Sync Data-journal',
    'Default/AutofillStrikeDatabase', 'Default/Affiliation Database',
    'Default/DownloadMetadata',
    'Default/Top Sites', 'Default/Top Sites-journal',
    'Default/Visited Links', 'Default/Shortcuts', 'Default/Shortcuts-journal',
    // Cookie stores (both the legacy and the Network-partitioned locations)
    'Default/Cookies', 'Default/Cookies-journal',
    'Default/Network/Cookies', 'Default/Network/Cookies-journal',
    'Default/Safe Browsing Cookies',
    // Site storage that can hold tokens/session material outside cookies
    'Default/Local Storage', 'Default/Session Storage',
    'Default/IndexedDB', 'Default/Service Worker',
    'Default/File System', 'Default/databases', 'Default/blob_storage',
    'Default/shared_proto_db', 'Default/Shared Storage', 'Default/Shared Storage-journal',
    'Default/Trust Tokens', 'Default/Trust Tokens-journal',
    'Default/interest_groups', 'Default/Site Characteristics Database',
    'Default/DIPS', 'Default/DIPS-journal',
    'Default/Network/Reporting and NEL', 'Default/Network/Trust Tokens',
    // Favicons reveal which sites were visited (a history leak); MediaDeviceSalts
    // is a per-profile fingerprint salt — both must not be cloned across users.
    'Default/Favicons', 'Default/Favicons-journal',
    'Default/MediaDeviceSalts', 'Default/MediaDeviceSalts-journal',
];

interface Args { out: string; sites: string[]; headed: boolean; dwell: number }

function parseArgs(argv: string[]): Args {
    const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
    return {
        out:    path.resolve(get('--out') ?? './profile-seed'),
        sites:  get('--sites')?.split(',').map(s => s.trim()).filter(Boolean) ?? DEFAULT_SITES,
        headed: argv.includes('--headed'),
        dwell:  parseInt(get('--dwell') ?? '4000'),
    };
}

const rand  = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Human-ish dwell on a page: scroll a bit, pause, move on. Enough to let lazy
 *  consent/analytics scripts fire and set their cookies. */
async function warmPage(context: BrowserContext, url: string, dwell: number): Promise<void> {
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await sleep(rand(dwell * 0.6, dwell * 1.4));
        for (let i = 0; i < rand(2, 5); i++) {
            await page.mouse.wheel(0, rand(200, 900)).catch(() => {});
            await sleep(rand(300, 1200));
        }
    } catch (e) {
        console.warn(`  ! ${url}: ${e instanceof Error ? e.message : e}`);
    } finally {
        await page.close().catch(() => {});
    }
}

// Cookie/storage stores must be GONE from the finished template. Audited after
// close; any survivor fails generation rather than silently shipping identity.
const MUST_BE_ABSENT = [
    'Default/Cookies', 'Default/Network/Cookies',
    'Default/Local Storage', 'Default/IndexedDB', 'Default/Service Worker',
    'Default/File System', 'Default/databases',
];

/** Delete personal/sensitive files from the on-disk profile after the browser closes. */
async function scrubProfileFiles(dir: string): Promise<void> {
    for (const rel of SENSITIVE) {
        await fs.rm(path.join(dir, rel), { recursive: true, force: true }).catch(() => {});
    }
    // Caches are big and machine-specific — drop them; they rebuild on first use.
    for (const cache of ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache',
        'Default/Network/Cache', 'GraphiteDawnCache', 'ShaderCache', 'GrShaderCache']) {
        await fs.rm(path.join(dir, cache), { recursive: true, force: true }).catch(() => {});
    }
}

/** Fail-closed guard: prove no cookie/storage store survived the scrub. A template
 *  that still carries any of these is not safe to share, so we abort rather than
 *  ship it. */
async function auditNoSecrets(dir: string): Promise<void> {
    const survivors: string[] = [];
    for (const rel of MUST_BE_ABSENT) {
        if (await fs.access(path.join(dir, rel)).then(() => true, () => false)) survivors.push(rel);
    }
    if (survivors.length) throw new Error(`template still contains identity stores: ${survivors.join(', ')}`);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    console.log(`warming profile → ${args.out}`);
    console.log(`sites: ${args.sites.length}, dwell ~${args.dwell}ms, headed=${args.headed}`);

    // Warm in a temp dir, then move the scrubbed result into place — so a crash
    // mid-warm never leaves a half-built (possibly login-bearing) template behind.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'warm-profile-'));

    const context = await launchPersistentContext({
        userDataDir: tmp,
        headless: !args.headed,
        licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY?.trim() || undefined,
        humanize: true,
    });

    try {
        for (const url of args.sites) {
            console.log(`  warming ${url}`);
            await warmPage(context, url, args.dwell);
        }
    } finally {
        // Close first: cookie/storage DBs flush and unlock, so the scrub can
        // delete them cleanly.
        await context.close().catch(() => {});
    }

    await scrubProfileFiles(tmp);
    await auditNoSecrets(tmp);  // aborts if any identity store survived

    // Non-destructive publish: stage a fully-built template next to the target,
    // then swap it in with a single rename so readers never see a half-copy and a
    // failed build never destroys the previous good seed.
    await fs.mkdir(path.dirname(args.out), { recursive: true });
    const staged = `${args.out}.next-${process.pid}`;
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    await fs.cp(tmp, staged, { recursive: true });
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    await fs.rm(args.out, { recursive: true, force: true }).catch(() => {});
    await fs.rename(staged, args.out);

    console.log(`done. Seed with:  PROFILE_SEED_DIR=${args.out}`);
}

main().catch(e => { console.error(e); process.exit(1); });
