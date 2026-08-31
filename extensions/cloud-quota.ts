/**
 * pi-cloud-quota — subscription quota & pay-as-you-go balance in the pi
 * status bar.
 *
 * Format: `Ark 5h 91% ↺3h · wk 50% · mo 29%`
 *   - provider name prefix (Ark / Kimi / GLM / Codex / …)
 *   - used percent per window, color-graded (green <70, yellow <90, red ≥90)
 *   - reset countdown per window, shown only while remaining quota is below a
 *     configurable threshold (defaults: 5h <80%, wk <40%); when the status
 *     exceeds the width budget the 5h reset is kept and the rest dropped
 *     (Ollama: predicted from the global reset grid — the API reports no
 *     reset times, but resets are epoch-aligned and identical for all
 *     accounts, see parseOllama)
 *   - balance-type providers (OpenRouter, one-api-family gateways, Moonshot,
 *     DeepSeek, …) render the remaining amount instead: `OpenRouter $12.34`
 *
 * See README.md (“Provider coverage & status”) for the full provider list
 * and which endpoints have been verified against real accounts.
 *
 * The status only shows while the active model matches a known provider.
 * A background timer fetches fresh data on a configurable interval
 * (30s / 1min / 2min / 5min, default 1min — change via `/cloud-quota`);
 * session_start / model_select reuse a 5-minute cache.
 *
 * Quota warnings: toast when a window's severity escalates (80% → warning,
 * 90% → high, 100% → critical). Only critical notifies at error level.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const STATUS_KEY = "cloud-quota";

/** Refresh-interval options offered by `/cloud-quota`; default is 1min. */
const INTERVALS = [
	{ label: "30s", ms: 30_000 },
	{ label: "1min", ms: 60_000 },
	{ label: "2min", ms: 120_000 },
	{ label: "5min", ms: 300_000 },
] as const;
const DEFAULT_INTERVAL_MS = INTERVALS[1].ms;
const CONFIG_PATH = join(homedir(), ".pi", "agent", "cloud-quota.json");

/** Reset countdown shows while remaining quota < threshold, per window label. */
const DEFAULT_RESET_THRESHOLDS: Record<string, number> = { "5h": 80, wk: 40 };
/** Status width budget in visible chars; 0 = unlimited. */
const DEFAULT_MAX_WIDTH = 40;

interface QuotaConfig {
	refreshIntervalMs: number;
	resetThresholds: Record<string, number>;
	maxWidth: number;
}

function readConfig(): QuotaConfig {
	const raw = readJson(CONFIG_PATH);
	const interval = raw?.refreshIntervalMs;
	return {
		refreshIntervalMs: INTERVALS.some((i) => i.ms === interval)
			? (interval as number)
			: DEFAULT_INTERVAL_MS,
		resetThresholds: {
			...DEFAULT_RESET_THRESHOLDS,
			...(raw?.resetThresholds ?? {}),
		},
		maxWidth:
			typeof raw?.maxWidth === "number" && Number.isFinite(raw.maxWidth)
				? raw.maxWidth
				: DEFAULT_MAX_WIDTH,
	};
}

function saveConfig(patch: Partial<QuotaConfig>) {
	writeFileSync(
		CONFIG_PATH,
		JSON.stringify({ ...readConfig(), ...patch }, null, 2) + "\n",
	);
}


export type Period = { label: string; percent: number; resetsAt?: string };

/** Remaining amount for pay-as-you-go providers; `total` when the account has a known limit. `spent` marks pure-spend display (unlimited tokens). */
export type Balance = {
	amount: number;
	unit: string;
	total?: number;
	spent?: boolean;
};

/** A provider fetch resolves to window periods, a balance amount, or throws. */
export type Usage = Period[] | Balance;

// ---- pure helpers (exported for offline tests) ----

export function colorRole(percent: number): "success" | "warning" | "error" {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

export type Severity = "none" | "warning" | "high" | "critical";
const SEVERITY_RANK: Severity[] = ["none", "warning", "high", "critical"];

/** [warning, high, critical] percent thresholds, aligned per provider. */
export type Thresholds = [number, number, number];
const DEFAULT_THRESHOLDS: Thresholds = [80, 90, 100];

export function severityOf(
	percent: number,
	t: Thresholds = DEFAULT_THRESHOLDS,
): Severity {
	if (percent >= t[2]) return "critical";
	if (percent >= t[1]) return "high";
	if (percent >= t[0]) return "warning";
	return "none";
}

/** True when `arkcli auth status` stdout describes a logged-in SSO session. */
export function arkAuthOk(stdout: string): boolean {
	try {
		return (JSON.parse(stdout) as { logged_in?: boolean }).logged_in === true;
	} catch {
		return stdout.includes('"logged_in": true');
	}
}

/** `↺3h` when more than an hour remains, `↺45m` below, `↺2d` for days; undefined when past/unknown. */
export function formatReset(
	resetsAt: string | undefined,
	now = Date.now(),
): string | undefined {
	if (!resetsAt) return undefined;
	const ms = Date.parse(resetsAt) - now;
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	const minutes = ms / 60_000;
	if (minutes < 60) return `↺${Math.max(1, Math.round(minutes))}m`;
	const hours = minutes / 60;
	if (hours < 24) return `↺${Math.round(hours)}h`;
	return `↺${Math.round(hours / 24)}d`;
}

export type RenderOptions = {
	/** per-window-label remaining-% threshold; reset shows while remaining < it */
	resetThresholds?: Record<string, number>;
	/** status width budget in visible chars; 0 = unlimited */
	maxWidth?: number;
};

/** When the status exceeds the width budget, this window's reset is kept last. */
const PRIORITY_RESET_LABEL = "5h";

function visibleLength(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Next boundary of a global reset grid: boundaries at `phase + k*period`
 * (phase defaults to epoch). Ollama Cloud resets are global — the same
 * instant for every account — so the next reset is computable locally:
 * session = every 5h on an epoch-aligned grid, weekly = every 7d starting
 * Monday 00:00 UTC (epoch + 4d). Community-verified, see ollama/ollama#12532.
 */
export function nextReset(
	now: number,
	periodMs: number,
	phaseMs = 0,
): string {
	const remain = periodMs - ((now - phaseMs) % periodMs);
	return new Date(now + remain).toISOString();
}

/** Normalize epoch seconds/milliseconds or an ISO date string to ISO. */
export function parseDateish(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0)
		return new Date(value > 1e11 ? value : value * 1000).toISOString();
	if (typeof value === "string" && value) {
		const d = new Date(value);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}
	return undefined;
}

export function renderQuota(
	fg: (role: string, text: string) => string,
	name: string,
	periods: Period[],
	opts: RenderOptions = {},
	now = Date.now(),
): string | undefined {
	const thresholds = { ...DEFAULT_RESET_THRESHOLDS, ...opts.resetThresholds };
	const maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;

	const resetFor = (p: Period): string | undefined => {
		const th = thresholds[p.label];
		if (th === undefined) return undefined; // no threshold → never show
		if (100 - p.percent >= th) return undefined; // plenty remaining → hide
		return formatReset(p.resetsAt, now);
	};

	const render = (
		periods: Period[],
		resetLabels: ReadonlySet<string> | null,
	): string | undefined => {
		const parts = periods
			.filter((p) => Number.isFinite(p.percent))
			.map((p) => {
				const pct = fg(colorRole(p.percent), `${Math.round(p.percent)}%`);
				const reset = resetLabels?.has(p.label) ? resetFor(p) : undefined;
				return `${p.label} ${pct}${reset ? fg("dim", ` ${reset}`) : ""}`;
			});
		if (parts.length === 0) return undefined;
		return `${name} ${parts.join(" · ")}`;
	};

	const fits = (s: string | undefined) =>
		s !== undefined && (maxWidth <= 0 || visibleLength(s) <= maxWidth);

	// width fallback: all resets → 5h reset only → 5h period only → no resets
	let text = render(periods, new Set(periods.map((p) => p.label)));
	if (!fits(text)) text = render(periods, new Set([PRIORITY_RESET_LABEL]));
	if (!fits(text))
		text = render(
			periods.filter((p) => p.label === PRIORITY_RESET_LABEL),
			new Set([PRIORITY_RESET_LABEL]),
		);
	if (!fits(text))
		text = render(periods.filter((p) => p.label === PRIORITY_RESET_LABEL), null);
	return text;
}

/** Balance line, e.g. `OpenRouter $12.34`; colored by remaining fraction when a limit is known. */
export function renderBalance(
	fg: (role: string, text: string) => string,
	name: string,
	b: Balance,
): string {
	const total = Number(b.total);
	const frac =
		Number.isFinite(total) && total > 0 && Number.isFinite(b.amount)
			? b.amount / total
			: undefined;
	const percent =
		frac !== undefined ? frac * 100 : b.amount > 0 || b.spent ? 0 : 100;
	const money =
		b.unit === "USD"
			? `$${b.amount.toFixed(2)}`
			: `${b.amount.toFixed(2)} ${b.unit}`;
	const shown = b.spent ? `${money} spent` : money;
	return `${name} ${fg(colorRole(percent), shown)}`;
}

export function parseArk(json: any): Period[] {
	const items = Array.isArray(json?.items) ? json.items : [];
	const item = items.find((i: any) => i?.subscribed) ?? items[0];
	const short = (l: string) =>
		l === "weekly" ? "wk" : l === "monthly" ? "mo" : l;
	return (Array.isArray(item?.periods) ? item.periods : [])
		.filter((p: any) => Number.isFinite(Number(p?.percent)))
		.map((p: any) => ({
			label: short(String(p.label)),
			percent: Number(p.percent),
			resetsAt: typeof p?.reset_at === "string" ? p.reset_at : undefined,
		}));
}

export function parseKimi(json: any): Period[] {
	const pct = (used: any, limit: any): number => {
		const u = Number(used);
		const l = Number(limit);
		if (!Number.isFinite(u) || !Number.isFinite(l)) return NaN;
		// A window with a zero quota limit still exists and must stay visible
		// (Kimi's 5h window shows as 0% while its limit is 0); usage reported
		// against a zero limit reads as fully consumed.
		if (l <= 0) return u > 0 ? 100 : 0;
		return (u / l) * 100;
	};
	const out: Period[] = [];
	// rolling windows: pick the shortest-duration one (300min = 5h)
	let bestMin = Infinity;
	let best: Period | undefined;
	for (const entry of Array.isArray(json?.limits) ? json.limits : []) {
		if (entry?.window?.timeUnit !== "TIME_UNIT_MINUTE") continue;
		const minutes = Number(entry?.window?.duration);
		const p = pct(entry?.detail?.used, entry?.detail?.limit);
		if (Number.isFinite(minutes) && Number.isFinite(p) && minutes < bestMin) {
			bestMin = minutes;
			best = {
				label: minutes === 300 ? "5h" : `${minutes}m`,
				percent: p,
				resetsAt:
					typeof entry?.detail?.resetTime === "string"
						? entry.detail.resetTime
						: undefined,
			};
		}
	}
	if (best) out.push(best);
	const weekly = pct(json?.usage?.used, json?.usage?.limit);
	if (Number.isFinite(weekly))
		out.push({
			label: "wk",
			percent: weekly,
			resetsAt:
				typeof json?.usage?.resetTime === "string"
					? json.usage.resetTime
					: undefined,
		});
	return out;
}

export function parseOllama(json: any, now = Date.now()): Period[] {
	// session window is displayed as "5h" per user convention; the API
	// reports usage as 0-1 fractions and no reset times. Resets are global
	// (same instant for all accounts) on an epoch-aligned grid, so the next
	// reset is predicted locally: session = multiples of 5h since epoch,
	// weekly = Monday 00:00 UTC. Verified against community observations
	// (ollama/ollama#12532) and the settings-page countdown.
	const out: Period[] = [];
	const sess = Number(json?.limits?.session?.usage);
	if (Number.isFinite(sess))
		out.push({
			label: "5h",
			percent: sess * 100,
			resetsAt: nextReset(now, 5 * 60 * 60 * 1000),
		});
	const wk = Number(json?.limits?.weekly?.usage);
	if (Number.isFinite(wk))
		out.push({
			label: "wk",
			percent: wk * 100,
			resetsAt: nextReset(now, 7 * 24 * 60 * 60 * 1000, 4 * 24 * 60 * 60 * 1000),
		});
	return out;
}

/**
 * GLM Coding Plan `/api/monitor/usage/quota/limit`: `data.limits[]` with
 * TOKENS_LIMIT entries; unit 3 = hours, unit 6 = weeks;
 * percentage is used-%, nextResetTime is epoch ms.
 */
export function parseGlm(json: any): Period[] {
	const out: Period[] = [];
	for (const entry of Array.isArray(json?.data?.limits)
		? json.data.limits
		: []) {
		if (entry?.type !== "TOKENS_LIMIT") continue;
		const percent = Number(entry?.percentage);
		if (!Number.isFinite(percent)) continue;
		const unit = Number(entry?.unit);
		const number = Number(entry?.number);
		const label =
			unit === 6
				? "wk"
				: unit === 3 && number === 5
					? "5h"
					: unit === 3 && Number.isFinite(number)
					? `${number}h`
					: undefined;
		if (!label) continue;
		out.push({ label, percent, resetsAt: parseDateish(entry?.nextResetTime) });
	}
	return out;
}

/** OpenAI Codex `chatgpt.com/backend-api/wham/usage` — primary 5h + secondary weekly window. */
export function parseCodex(json: any): Period[] {
	const rateLimit = json?.rate_limit ?? json?.rate_limits ?? {};
	const windows: Array<[any, string]> = [
		[
			rateLimit.primary_window ??
				rateLimit.primary ??
				rateLimit.five_hour_limit ??
				rateLimit.five_hour,
			"5h",
		],
		[
			rateLimit.secondary_window ??
				rateLimit.secondary ??
				rateLimit.weekly_limit ??
				rateLimit.weekly,
			"wk",
		],
	];
	const out: Period[] = [];
	for (const [win, label] of windows) {
		if (!win || typeof win !== "object") continue;
		let percent = Number(win.used_percent);
		if (!Number.isFinite(percent)) {
			const used = Number(win.used ?? win.usage);
			const limit = Number(win.limit ?? win.total ?? win.allowed);
			if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0)
				percent = (used / limit) * 100;
		}
		if (!Number.isFinite(percent)) continue;
		out.push({
			label,
			percent,
			resetsAt: parseDateish(win.reset_at ?? win.resets_at),
		});
	}
	return out;
}

/**
 * Anthropic Claude OAuth usage `/api/oauth/usage`: 5h/7d windows report
 * `utilization` (0-1 fraction) and `resets_at`.
 */
export function parseAnthropic(json: any): Period[] {
	const out: Period[] = [];
	const add = (entry: any, label: string) => {
		let percent = Number(entry?.utilization);
		if (!Number.isFinite(percent)) percent = Number(entry?.used_percent);
		if (!Number.isFinite(percent)) return;
		if (percent <= 1 && entry?.utilization !== undefined) percent *= 100;
		out.push({ label, percent, resetsAt: parseDateish(entry?.resets_at) });
	};
	add(json?.five_hour, "5h");
	add(json?.seven_day, "wk");
	return out;
}

/** GitHub Copilot premium-requests quota from `/copilot_internal/user` (monthly window). Free plans fall back to the chat / completions snapshots. */
export function parseCopilot(json: any): Period[] {
	const reset = parseDateish(json?.quota_reset_date_utc);
	const snapshots = json?.quota_snapshots;
	if (!snapshots || typeof snapshots !== "object") return [];
	const mappings: Array<[string, string]> = [
		["premium_interactions", "mo"],
		["chat", "mo"],
		["completions", "mo"],
	];
	for (const [key, label] of mappings) {
		const snap = snapshots[key];
		if (!snap || snap.unlimited) continue;
		const entitlement = Number(snap.entitlement);
		const remaining = Number(snap.remaining ?? snap.quota_remaining);
		if (
			!Number.isFinite(entitlement) ||
			entitlement <= 0 ||
			!Number.isFinite(remaining)
		)
			continue;
		return [
			{
				label,
				percent: ((entitlement - remaining) / entitlement) * 100,
				resetsAt: reset,
			},
		];
	}
	return [];
}

/** MiniMax Token Plan `/v1/token_plan/remains` — 5h + weekly request windows. */
export function parseMiniMax(json: any): Period[] {
	const out: Period[] = [];
	const add = (
		used: unknown,
		total: unknown,
		label: string,
		reset: unknown,
	) => {
		const u = Number(used);
		const l = Number(total);
		if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0) return;
		out.push({ label, percent: (u / l) * 100, resetsAt: parseDateish(reset) });
	};
	const d = json?.data ?? json;
	add(
		d?.current_interval_usage_count,
		d?.current_interval_total_count,
		"5h",
		d?.current_interval_reset_time,
	);
	add(
		d?.current_weekly_usage_count,
		d?.current_weekly_total_count,
		"wk",
		d?.current_weekly_reset_time,
	);
	return out;
}

/** Synthetic `/v2/quotas` rolling five-hour request limit. */
export function parseSynthetic(json: any): Period[] {
	const rl = json?.rollingFiveHourLimit;
	const max = Number(rl?.max);
	const remaining = Number(rl?.remaining);
	if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(remaining))
		return [];
	return [
		{
			label: "5h",
			percent: ((max - remaining) / max) * 100,
			resetsAt: parseDateish(rl?.nextTickAt),
		},
	];
}

// ---- balance parsers ----

export function parseOpenrouterCredits(json: any): Balance | undefined {
	const d = json?.data;
	const total = Number(d?.total_credits);
	const used = Number(d?.total_usage);
	if (!Number.isFinite(total) || !Number.isFinite(used)) return undefined;
	return { amount: total - used, unit: "USD", total };
}

/** one-api/new-api gateway billing pair → remaining USD (`total_usage` is cents). Unlimited tokens report hard_limit_usd = 1e8 → show pure spend. */
export function parseGatewayBilling(
	subscription: any,
	usage: any,
): Balance | undefined {
	const hard = Number(subscription?.hard_limit_usd);
	const usedDollars = Number(usage?.total_usage) / 100;
	if (!Number.isFinite(hard) || !Number.isFinite(usedDollars)) return undefined;
	if (hard >= 1e6) return { amount: usedDollars, unit: "USD", spent: true };
	return { amount: hard - usedDollars, unit: "USD", total: hard };
}

export function parseMoonshotBalance(
	json: any,
	unit: string,
): Balance | undefined {
	const amount = Number(json?.data?.available_balance);
	if (!Number.isFinite(amount)) return undefined;
	return { amount, unit };
}

export function parseDeepseekBalance(json: any): Balance | undefined {
	const info = (Array.isArray(json?.balance_infos)
		? json.balance_infos
		: [])[0];
	const amount = Number(info?.total_balance);
	if (!Number.isFinite(amount)) return undefined;
	return { amount, unit: String(info?.currency ?? "CNY") };
}

export function parseSiliconflowBalance(
	json: any,
	unit: string,
): Balance | undefined {
	const d = json?.data;
	const amount = Number(d?.totalBalance ?? d?.balance);
	if (!Number.isFinite(amount)) return undefined;
	return { amount, unit };
}

export function parseStepfunBalance(json: any): Balance | undefined {
	const entry = Array.isArray(json?.accounts)
		? json.accounts[0]
		: Array.isArray(json?.data)
			? json.data[0]
			: (json?.data ?? json?.account);
	const amount = Number(entry?.balance ?? entry?.remain ?? json?.balance);
	if (!Number.isFinite(amount)) return undefined;
	return { amount, unit: String(entry?.currency ?? "USD") };
}

export function parseXaiCredits(json: any): Balance | undefined {
	const list = Array.isArray(json?.api_key)
		? json.api_key
		: json?.api_key
			? [json.api_key]
			: [];
	let amount: number | undefined;
	let total: number | undefined;
	for (const key of list) {
		const grant = key?.credit_grants ?? key;
		const remaining = Number(grant?.remaining ?? grant?.credit_remaining);
		if (Number.isFinite(remaining)) amount = (amount ?? 0) + remaining;
		const granted = Number(grant?.granted ?? grant?.total);
		if (Number.isFinite(granted)) total = (total ?? 0) + granted;
	}
	if (amount === undefined) return undefined;
	return { amount, unit: "USD", total };
}

/** Prepaid deposits surface as a negative `stripe_balance`; positive = owed. */
export function parseDeepinfraBalance(json: any): Balance | undefined {
	const sb = Number(json?.stripe_balance);
	if (!Number.isFinite(sb)) return undefined;
	return { amount: -sb, unit: "USD" };
}

export function parseVercelBalance(json: any): Balance | undefined {
	const amount = Number(json?.balance);
	if (!Number.isFinite(amount)) return undefined;
	return { amount, unit: "USD" };
}

// ---- Ark SSO session helpers ----

/** True when an arkcli error message means "SSO session missing/expired, re-login needed". */
export function isArkNotLoggedIn(message: string): boolean {
	return /arkcli auth login volc-sso|requires Volcengine Ark SSO STS/.test(message);
}

/** True when an arkcli message means the SSO/token endpoint is rate-limiting us. */
export function isArkRateLimited(message: string): boolean {
	return /rate limit|too many requests/i.test(message);
}

const ARKCLI_IDENTITIES_DIR = join(homedir(), ".arkcli", "identities");

/**
 * Milliseconds until the Ark SSO refresh token expires, decoded from the local
 * `~/.arkcli/identities/<id>/token.json` JWT (newest exp wins). Refresh tokens
 * are not rotated and expire server-side ~48h after login, so the session
 * must be refreshed manually before then.
 */
export function arkLoginExpiryMs(
	identitiesDir = ARKCLI_IDENTITIES_DIR,
): number | undefined {
	let latest: number | undefined;
	try {
		for (const name of readdirSync(identitiesDir, { withFileTypes: true })) {
			if (!name.isDirectory()) continue;
			const raw = readJson(join(identitiesDir, name.name, "token.json"))
				?.refresh_token;
			if (typeof raw !== "string") continue;
			const payload = JSON.parse(
				Buffer.from(raw.split(".")[1], "base64url").toString("utf8"),
			);
			const exp = Number(payload?.exp);
			if (Number.isFinite(exp) && exp > 0)
				latest = Math.max(latest ?? 0, exp * 1000);
		}
	} catch {
		return latest;
	}
	return latest;
}

// ---- credentials & fetching ----

function readJson(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** A credential may be a plain string or an OAuth-ish `{type, key|access, …}` object. */
function credToken(cred: any): string | undefined {
	if (typeof cred === "string") return cred || undefined;
	if (cred && typeof cred === "object") {
		const token = cred.key ?? cred.access;
		return typeof token === "string" && token ? token : undefined;
	}
	return undefined;
}

function piAuth(id: string): any {
	return readJson(join(homedir(), ".pi", "agent", "auth.json"))?.[id];
}

/** OpenCode keeps its own auth store; some credentials only exist there. */
function ocKey(id: string): string | undefined {
	return credToken(
		readJson(join(homedir(), ".local/share/opencode/auth.json"))?.[id],
	);
}

function modelKey(providerId: string): string | undefined {
	return readJson(join(homedir(), ".pi", "agent", "models.json"))?.providers?.[
		providerId
	]?.apiKey;
}

function envKey(name: string): string | undefined {
	const v = process.env[name];
	return typeof v === "string" && v ? v : undefined;
}

function kimiToken(): string | undefined {
	return credToken(piAuth("kimi-coding"));
}

function ollamaKey(): string | undefined {
	return modelKey("ollama-cloud");
}

async function fetchWithHeaders(
	url: string,
	headers: Record<string, string>,
): Promise<Response> {
	return fetch(url, {
		headers: { Accept: "application/json", ...headers },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
}

async function fetchJson(url: string, token: string): Promise<any> {
	const res = await fetchWithHeaders(url, { Authorization: `Bearer ${token}` });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function fetchJsonAuth(
	url: string,
	headers: Record<string, string>,
): Promise<any> {
	const res = await fetchWithHeaders(url, headers);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function fetchArk(): Promise<Period[]> {
	const { stdout } = await execFileP("arkcli", ["usage", "plan"], {
		timeout: TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
	});
	const start = stdout.indexOf("{");
	try {
		return parseArk(JSON.parse(start >= 0 ? stdout.slice(start) : stdout));
	} catch {
		throw new Error("invalid `arkcli usage plan` output");
	}
}

// ---- provider fetchers (exported for offline tests) ----

const GLM_CN_BASE = "https://open.bigmodel.cn";
const GLM_GLOBAL_BASE = "https://api.z.ai";

/**
 * GLM Coding Plan usage. Region implementations disagree on whether the
 * monitor endpoint wants the bare key or a `Bearer` prefix; send the bare
 * key first and retry with `Bearer` on 401.
 */
export async function fetchGlm(base: string, key: string): Promise<Usage> {
	const url = `${base}/api/monitor/usage/quota/limit`;
	let res = await fetchWithHeaders(url, {
		Authorization: key,
		"User-Agent": BROWSER_UA,
	});
	if (res.status === 401)
		res = await fetchWithHeaders(url, {
			Authorization: `Bearer ${key}`,
			"User-Agent": BROWSER_UA,
		});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const json = await res.json();
	// The endpoint answers with HTTP 200 even for non-subscribed accounts:
	// business failures carry `success: false` plus a human-readable msg.
	if (json && json.success === false)
		throw new Error(`GLM coding plan: ${json.msg ?? "unavailable"}`);
	return parseGlm(json);
}

export async function fetchGlmCn(): Promise<Usage> {
	const key =
		credToken(piAuth("bigmodel-cn")) ??
		modelKey("bigmodel-cn") ??
		envKey("ZHIPUAI_API_KEY");
	if (!key) throw new Error("no bigmodel-cn API key");
	return fetchGlm(GLM_CN_BASE, key);
}

export async function fetchGlmGlobal(): Promise<Usage> {
	const key =
		ocKey("zai") ??
		ocKey("zai-coding-plan") ??
		modelKey("zai") ??
		envKey("ZAI_API_KEY");
	if (!key) throw new Error("no z.ai API key");
	return fetchGlm(GLM_GLOBAL_BASE, key);
}

// OpenAI Codex / ChatGPT subscription usage. Access tokens are short-lived;
// on 401/403 an in-memory refresh runs against auth.openai.com; credential
// files stay untouched (the refreshed token outlives only this process).
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

interface CodexCreds {
	access: string;
	account?: string;
	refresh?: string;
	expiresAt?: number;
}

function codexCreds(): CodexCreds | undefined {
	const cli = readJson(join(homedir(), ".codex", "auth.json"))?.tokens;
	const pi = piAuth("openai-codex");
	const piObj = pi && typeof pi === "object" ? pi : undefined;
	const access = cli?.access_token ?? credToken(pi);
	if (!access) return undefined;
	const piExpires = Number(piObj?.expires);
	return {
		access,
		account: cli?.account_id ?? piObj?.accountId,
		refresh: cli?.refresh_token ?? piObj?.refresh,
		expiresAt:
			Number.isFinite(piExpires) && piExpires > 0
				? piExpires < 1e12
					? piExpires * 1000
					: piExpires
				: undefined,
	};
}

let codexTokenOverride: { access: string; at: number } | undefined;

async function codexUsage(creds: CodexCreds): Promise<Period[]> {
	return parseCodex(
		await fetchJsonAuth("https://chatgpt.com/backend-api/wham/usage", {
			Authorization: `Bearer ${creds.access}`,
			...(creds.account ? { "ChatGPT-Account-Id": creds.account } : {}),
			Origin: "https://chatgpt.com",
			Referer: "https://chatgpt.com/",
			"User-Agent": BROWSER_UA,
		}),
	);
}

export async function fetchCodex(): Promise<Usage> {
	const creds = codexCreds();
	if (!creds) throw new Error("no openai-codex credential");
	const override = codexTokenOverride;
	if (override && Date.now() - override.at < 10 * 60_000)
		return codexUsage({ ...creds, access: override.access });
	try {
		return await codexUsage(creds);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const stale =
			/^HTTP 40[13]$/.test(msg) ||
			(creds.expiresAt !== undefined && creds.expiresAt <= Date.now());
		if (!stale || !creds.refresh) throw e;
		const res = await fetch("https://auth.openai.com/oauth/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				grant_type: "refresh_token",
				client_id: OPENAI_CLIENT_ID,
				refresh_token: creds.refresh,
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`codex token refresh: HTTP ${res.status}`);
		const json = await res.json();
		const access = json?.access_token;
		if (typeof access !== "string" || !access)
			throw new Error("codex token refresh: no access_token");
		codexTokenOverride = { access, at: Date.now() };
		return codexUsage({ ...creds, access });
	}
}

// Anthropic subscription usage needs a Claude OAuth token; a plain API key
// (sk-ant-…) has no subscription usage endpoint to read.
export async function fetchAnthropic(): Promise<Usage> {
	const token = credToken(piAuth("anthropic"));
	if (!token) throw new Error("no anthropic OAuth credential");
	if (token.startsWith("sk-ant-"))
		throw new Error("anthropic API key has no subscription usage");
	return parseAnthropic(
		await fetchJsonAuth("https://api.anthropic.com/api/oauth/usage", {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		}),
	);
}

async function copilotToken(): Promise<string> {
	const env = envKey("GITHUB_TOKEN") ?? envKey("GH_TOKEN");
	if (env) return env;
	const { stdout } = await execFileP("gh", ["auth", "token"], {
		timeout: 10_000,
	});
	const token = stdout.trim();
	if (!token) throw new Error("no GitHub token (run `gh auth login`)");
	return token;
}

export async function fetchCopilot(): Promise<Usage> {
	const token = await copilotToken();
	const fetchUser = (t: string) =>
		fetchJsonAuth("https://api.github.com/copilot_internal/user", {
			Authorization: `Bearer ${t}`,
			Accept: "application/vnd.github+json",
			"User-Agent": BROWSER_UA,
		});
	let json: any;
	try {
		json = await fetchUser(token);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg !== "HTTP 401") throw e;
		// Token refused → exchange for a short-lived Copilot token, retry.
		const ex = await fetchJsonAuth(
			"https://api.github.com/copilot_internal/v2/token",
			{ Authorization: `Bearer ${token}`, "User-Agent": BROWSER_UA },
		);
		const exchanged = String(ex?.token ?? "");
		if (!exchanged) throw new Error("copilot token exchange failed");
		json = await fetchUser(exchanged);
	}
	const periods = parseCopilot(json);
	if (periods.length === 0) throw new Error("no copilot premium quota snapshot");
	return periods;
}

/** MiniMax Token Plan; region picked from baseUrl/provider id. */
export async function fetchMiniMax(
	providerId: string,
	baseUrl: string,
	key: string,
): Promise<Usage> {
	const cn =
		/minimaxi|\.cn/i.test(baseUrl) || /-cn|minimaxi/i.test(providerId);
	const base = cn ? "https://api.minimaxi.com" : "https://api.minimax.io";
	const periods = parseMiniMax(
		await fetchJsonAuth(`${base}/v1/token_plan/remains`, {
			Authorization: `Bearer ${key}`,
		}),
	);
	if (periods.length === 0) throw new Error("minimax: no quota windows");
	return periods;
}

export async function fetchSynthetic(): Promise<Usage> {
	const key = envKey("SYNTHETIC_API_KEY");
	if (!key) throw new Error("no SYNTHETIC_API_KEY");
	const periods = parseSynthetic(
		await fetchJsonAuth("https://api.synthetic.new/v2/quotas", {
			Authorization: `Bearer ${key}`,
		}),
	);
	if (periods.length === 0) throw new Error("synthetic: no quota windows");
	return periods;
}

export async function fetchOpenrouter(key: string): Promise<Usage> {
	const balance = parseOpenrouterCredits(
		await fetchJsonAuth("https://openrouter.ai/api/v1/credits", {
			Authorization: `Bearer ${key}`,
		}),
	);
	if (!balance) throw new Error("openrouter: unexpected credits response");
	return balance;
}

/**
 * one-api/new-api gateway family: OpenAI-compatible billing endpoints on the
 * gateway origin, authenticated with the same sk- token used for inference.
 * Gateways that never answer these endpoints are marked dead once per token
 * (origin + key) and then skip further probing.
 */
const deadGateways = new Set<string>();

export async function fetchGateway(
	origin: string,
	key: string,
): Promise<Usage> {
	const gateId = `${origin}\u0000${key}`;
	if (deadGateways.has(gateId)) throw new Error("gateway billing unavailable");
	let balance: Balance | undefined;
	try {
		balance = await probeGateway(origin, key);
	} catch (e) {
		deadGateways.add(gateId);
		throw e;
	}
	if (!balance) {
		deadGateways.add(gateId);
		throw new Error("gateway: unexpected billing response");
	}
	return balance;
}

async function probeGateway(
	origin: string,
	key: string,
): Promise<Balance | undefined> {
	const headers = { Authorization: `Bearer ${key}` };
	const sub = await fetchJsonAuth(
		`${origin}/v1/dashboard/billing/subscription`,
		headers,
	);
	const now = new Date();
	const fmt = (d: Date) => d.toISOString().slice(0, 10);
	let usage: any;
	try {
		usage = await fetchJsonAuth(
			`${origin}/v1/dashboard/billing/usage` +
				`?start_date=${fmt(new Date(now.getFullYear(), now.getMonth(), 1))}` +
				`&end_date=${fmt(now)}`,
			headers,
		);
	} catch {
		usage = await fetchJsonAuth(
			`${origin}/v1/dashboard/billing/usage`,
			headers,
		);
	}
	return parseGatewayBilling(sub, usage);
}

function moonshotBase(providerId: string, baseUrl: string): string {
	const cn = /\.cn/i.test(baseUrl) || /-cn|cn$/i.test(providerId);
	return cn ? "https://api.moonshot.cn" : "https://api.moonshot.ai";
}

export async function fetchDeepseek(key: string): Promise<Usage> {
	const balance = parseDeepseekBalance(
		await fetchJsonAuth("https://api.deepseek.com/user/balance", {
			Authorization: `Bearer ${key}`,
		}),
	);
	if (!balance) throw new Error("deepseek: unexpected balance response");
	return balance;
}

export async function fetchSiliconflow(key: string, cn = true): Promise<Usage> {
	const base = cn
		? "https://api.siliconflow.cn"
		: "https://api.siliconflow.com";
	const balance = parseSiliconflowBalance(
		await fetchJsonAuth(`${base}/v1/user/info`, {
			Authorization: `Bearer ${key}`,
		}),
		cn ? "CNY" : "USD",
	);
	if (!balance) throw new Error("siliconflow: unexpected balance response");
	return balance;
}

export async function fetchStepfun(key: string): Promise<Usage> {
	const balance = parseStepfunBalance(
		await fetchJsonAuth("https://api.stepfun.com/v1/accounts", {
			Authorization: `Bearer ${key}`,
		}),
	);
	if (!balance) throw new Error("stepfun: unexpected balance response");
	return balance;
}

export async function fetchXai(key: string): Promise<Usage> {
	const balance = parseXaiCredits(
		await fetchJsonAuth("https://api.x.ai/v1/api-key", {
			Authorization: `Bearer ${key}`,
		}),
	);
	if (!balance) throw new Error("xai: unexpected credits response");
	return balance;
}

export async function fetchDeepinfra(key: string): Promise<Usage> {
	const balance = parseDeepinfraBalance(
		await fetchJsonAuth(
			"https://api.deepinfra.com/payment/checklist?compute_owed=true",
			{ Authorization: `Bearer ${key}` },
		),
	);
	if (!balance) throw new Error("deepinfra: unexpected balance response");
	return balance;
}

export async function fetchVercel(key: string): Promise<Usage> {
	const balance = parseVercelBalance(
		await fetchJsonAuth("https://ai-gateway.vercel.sh/v1/credits", {
			Authorization: `Bearer ${key}`,
		}),
	);
	if (!balance) throw new Error("vercel: unexpected balance response");
	return balance;
}

// ---- provider specs ----

const ARK_SPEC: Spec = {
	name: "Ark",
	fetch: fetchArk,
	thresholds: [80, 90, 100],
};

interface Spec {
	name: string;
	fetch: () => Promise<Usage>;
	/** severity thresholds [warning, high, critical]; defaults to 80/90/100 */
	thresholds?: Thresholds;
}

function kimiSpec(): Spec {
	return {
		name: "Kimi",
		thresholds: [80, 90, 100],
		fetch: async () => {
			const token = kimiToken();
			if (!token) throw new Error("no kimi-coding credential");
			return parseKimi(
				await fetchJson("https://api.kimi.com/coding/v1/usages", token),
			);
		},
	};
}

function ollamaSpec(): Spec {
	return {
		name: "Ollama",
		thresholds: [80, 90, 100],
		fetch: async () => {
			const key = ollamaKey();
			if (!key) throw new Error("no ollama-cloud apiKey");
			return parseOllama(await fetchJson("https://ollama.com/api/usage", key));
		},
	};
}

function minimaxSpec(providerId: string, baseUrl: string): Spec {
	return {
		name: "MiniMax",
		thresholds: [80, 90, 100],
		fetch: async () => {
			const key = modelKey(providerId) ?? envKey("MINIMAX_API_KEY");
			if (!key) throw new Error("no MiniMax subscription key");
			return fetchMiniMax(providerId, baseUrl, key);
		},
	};
}

function moonshotSpec(providerId: string, baseUrl: string): Spec {
	return {
		name: "Moonshot",
		fetch: async () => {
			const key =
				modelKey(providerId) ??
				ocKey("moonshotai-cn") ??
				ocKey("moonshotai") ??
				envKey("MOONSHOT_API_KEY");
			if (!key) throw new Error("no Moonshot API key");
			const base = moonshotBase(providerId, baseUrl);
			const balance = parseMoonshotBalance(
				await fetchJsonAuth(`${base}/v1/users/me/balance`, {
					Authorization: `Bearer ${key}`,
				}),
				/\.cn/i.test(base) ? "CNY" : "USD",
			);
			if (!balance) throw new Error("moonshot: unexpected balance response");
			return balance;
		},
	};
}

function keySpec(
	name: string,
	fetcher: (key: string) => Promise<Usage>,
	resolve: () => string | undefined,
	errHint: string,
): Spec {
	return {
		name,
		fetch: async () => {
			const key = resolve();
			if (!key) throw new Error(errHint);
			return fetcher(key);
		},
	};
}

/**
 * Map the active provider to a quota spec. baseUrl substrings win over
 * provider ids (same vendor, different regions = different endpoints);
 * unknown OpenAI-compatible providers fall back to one-api-family gateway
 * billing probing (hidden once the gateway proves not to answer).
 */
export function matchSpec(id: string, url: string): Spec | undefined {
	if (url.includes("volces.com")) return ARK_SPEC;
	if (url.includes("z.ai") || id === "zai")
		return { name: "Z.ai", fetch: fetchGlmGlobal };
	if (url.includes("bigmodel.cn") || id === "bigmodel-cn")
		return { name: "GLM", fetch: fetchGlmCn };
	if (id === "kimi-coding") return kimiSpec();
	if (id === "ollama-cloud") return ollamaSpec();
	if (
		url.includes("chatgpt.com") ||
		url.includes("backend-api") ||
		id === "openai-codex"
	)
		return { name: "Codex", thresholds: [80, 90, 100], fetch: fetchCodex };
	if (url.includes("anthropic.com") || id === "anthropic")
		return { name: "Claude", fetch: fetchAnthropic };
	if (url.includes("github.com") || id.includes("copilot"))
		return { name: "Copilot", fetch: fetchCopilot };
	if (url.includes("openrouter.ai") || id === "openrouter")
		return keySpec(
			"OpenRouter",
			fetchOpenrouter,
			() =>
				modelKey("openrouter") ??
				ocKey("openrouter") ??
				envKey("OPENROUTER_API_KEY"),
			"no openrouter API key",
		);
	if (
		url.includes("minimaxi.com") ||
		url.includes("minimax.io") ||
		id.startsWith("minimax")
	)
		return minimaxSpec(id, url);
	if (url.includes("moonshot") || id.startsWith("moonshot"))
		return moonshotSpec(id, url);
	if (url.includes("deepseek") || id.includes("deepseek"))
		return keySpec(
			"DeepSeek",
			fetchDeepseek,
			() => modelKey(id) ?? envKey("DEEPSEEK_API_KEY"),
			"no deepseek API key",
		);
	if (url.includes("siliconflow") || id.includes("siliconflow"))
		return keySpec(
			"SiliconFlow",
			(key) => fetchSiliconflow(key, url.includes(".cn")),
			() => modelKey(id) ?? envKey("SILICONFLOW_API_KEY"),
			"no siliconflow API key",
		);
	if (url.includes("stepfun") || id.includes("stepfun"))
		return keySpec(
			"StepFun",
			fetchStepfun,
			() => modelKey(id) ?? envKey("STEPFUN_API_KEY"),
			"no stepfun API key",
		);
	if (url.includes(".x.ai") || id === "xai" || id.includes("grok"))
		return keySpec(
			"xAI",
			fetchXai,
			() => modelKey(id) ?? envKey("XAI_API_KEY"),
			"no xai API key",
		);
	if (url.includes("deepinfra") || id.includes("deepinfra"))
		return keySpec(
			"DeepInfra",
			fetchDeepinfra,
			() => modelKey(id) ?? envKey("DEEPINFRA_API_KEY"),
			"no deepinfra API key",
		);
	if (url.includes("ai-gateway.vercel.sh") || id.includes("vercel"))
		return keySpec(
			"Vercel",
			fetchVercel,
			() => modelKey(id) ?? envKey("VERCEL_AI_GATEWAY_API_KEY"),
			"no vercel ai gateway key",
		);
	if (id.includes("synthetic"))
		return { name: "Synthetic", thresholds: [80, 90, 100], fetch: fetchSynthetic };
	return undefined;
}

function specFor(ctx: ExtensionContext): Spec | undefined {
	let provider: string | undefined;
	let baseUrl: string | undefined;
	try {
		provider = ctx?.model?.provider;
		baseUrl = ctx?.modelRegistry?.getProvider?.(provider as string)?.baseUrl;
	} catch {
		return undefined; // stale ctx
	}
	if (typeof baseUrl !== "string" || typeof provider !== "string" || !provider)
		return undefined;
	const matched = matchSpec(provider, baseUrl.toLowerCase());
	if (matched) return matched;
	// Unknown openai-compatible provider → probe one-api/new-api billing
	// endpoints on the gateway origin (new-api, one-api and derived gateways).
	const origin = /^https?:\/\//i.test(baseUrl) ? new URL(baseUrl).origin : "";
	if (!origin) return undefined;
	return {
		name: provider,
		fetch: async () => {
			const key = modelKey(provider);
			if (!key) throw new Error(`no ${provider} apiKey`);
			return fetchGateway(origin, key);
		},
	};
}

// ---- extension ----

export default function (pi: ExtensionAPI) {
	let lastCtx: ExtensionContext | undefined;
	const cache: Record<string, { usage: Usage; fetchedAt: number }> = {};
	const inFlight = new Set<string>();
	/** Last fetch failure per spec; drives exponential backoff instead of retrying every tick. */
	const lastFailure: Record<string, { at: number; streak: number }> = {};
	/** Backoff after a failed fetch: TTL, 2×TTL, 4×TTL, capped at 30min. */
	const failureBackoffMs = (streak: number): number =>
		Math.min(TTL_MS * 2 ** (streak - 1), 30 * 60_000);

	/** Drop cached entries whose spec no longer exists (dead gateways). */
	function cacheClearStale() {
		if (!lastCtx) return;
		for (const name of Object.keys(cache))
			if (!specForByName(lastCtx, name)) delete cache[name];
	}

	function specForByName(ctx: ExtensionContext, name: string): boolean {
		const spec = specFor(ctx);
		return spec?.name === name;
	}

	const lastSeverity = new Map<string, Severity>();

	/** Toast on severity escalation only; critical → error, warning/high → warning. */
	function maybeWarn(ctx: ExtensionContext, spec: Spec, usage: Usage) {
		if (!Array.isArray(usage)) return; // balance amounts never escalate
		const escalated: { p: Period; sev: Severity }[] = [];
		for (const p of usage) {
			if (!Number.isFinite(p.percent)) continue;
			const key = `${spec.name}:${p.label}`;
			const sev = severityOf(p.percent, spec.thresholds);
			const prev = lastSeverity.get(key) ?? "none";
			if (SEVERITY_RANK.indexOf(sev) > SEVERITY_RANK.indexOf(prev))
				escalated.push({ p, sev });
			if (sev !== prev) lastSeverity.set(key, sev); // de-escalation tracked silently
		}
		if (escalated.length === 0) return;
		const lines = escalated.map(({ p }) => {
			const reset = formatReset(p.resetsAt);
			return `- ${p.label}: ${Math.round(p.percent)}% used${reset ? `, resets in ${reset.slice(1)}` : ""}`;
		});
		const level = escalated.some((e) => e.sev === "critical")
			? "error"
			: "warning";
		try {
			ctx.ui.notify(`${spec.name} quota warning:\n${lines.join("\n")}`, level);
		} catch {
			/* stale ctx */
		}
	}

	function apply(ctx: ExtensionContext, spec: Spec, usage: Usage) {
		const cfg = readConfig();
		const fg = (role: string, t: string) => ctx.ui.theme.fg(role, t);
		const text = Array.isArray(usage)
			? renderQuota(fg, spec.name, usage, {
					resetThresholds: cfg.resetThresholds,
					maxWidth: cfg.maxWidth,
				})
			: renderBalance(fg, spec.name, usage);
		ctx.ui.setStatus(
			STATUS_KEY,
			text ?? fg("dim", `${spec.name} ⌀`),
		);
	}

	async function refresh(ctx: ExtensionContext, spec: Spec, force = false) {
		const hit = cache[spec.name];
		if (!force && hit && Date.now() - hit.fetchedAt < TTL_MS) {
			apply(ctx, spec, hit.usage);
			maybeWarn(ctx, spec, hit.usage);
			return;
		}
		const fail = lastFailure[spec.name];
		if (!force && fail && Date.now() - fail.at < failureBackoffMs(fail.streak))
			return;
		if (inFlight.has(spec.name)) return;
		inFlight.add(spec.name);
		try {
			const usage = await spec.fetch();
			cache[spec.name] = { usage, fetchedAt: Date.now() };
			delete lastFailure[spec.name];
			apply(ctx, spec, usage);
			maybeWarn(ctx, spec, usage);
			notified.delete("ark-needs-login");
			notified.delete("ark-rate-limited");
			if (spec.name === "Ark") maybeWarnLoginExpiry(ctx);
		} catch (e) {
			lastFailure[spec.name] = {
				at: Date.now(),
				streak: (fail?.streak ?? 0) + 1,
			};
			if (!cache[spec.name] && !(spec.name === "Ark" && loginInFlight)) {
				const msg = e instanceof Error ? e.message : String(e);
				if (spec.name === "Ark" && isArkRateLimited(msg)) {
					ctx.ui.setStatus(
						STATUS_KEY,
						ctx.ui.theme.fg("dim", `${spec.name} 限流中`),
					);
					notifyOnce(
						ctx,
						"ark-rate-limited",
						"Ark 端点限流，刷新已退避暂停；限流解除后自动恢复",
					);
				} else if (spec.name === "Ark" && isArkNotLoggedIn(msg)) {
					ctx.ui.setStatus(
						STATUS_KEY,
						ctx.ui.theme.fg("dim", `${spec.name} 未登录`),
					);
					notifyOnce(
						ctx,
						"ark-needs-login",
						"Ark 未登录（SSO 会话过期）：运行 /cloud-quota login 重新登录",
					);
				} else {
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${spec.name} ✗`));
				}
			}
		} finally {
			inFlight.delete(spec.name);
		}
	}

	const notified = new Set<string>();
	function notifyOnce(
		ctx: ExtensionContext,
		key: string,
		message: string,
		type: "info" | "warning" | "error" = "warning",
	) {
		if (notified.has(key)) return;
		notified.add(key);
		ctx.ui.notify(message, type);
	}

	const LOGIN_EXPIRY_WARN_MS = 12 * 60 * 60 * 1000;
	/** Toast (once per expiry) when the Ark SSO session is close to expiring. */
	function maybeWarnLoginExpiry(ctx: ExtensionContext) {
		const exp = arkLoginExpiryMs();
		if (exp === undefined) return;
		const left = exp - Date.now();
		if (left > LOGIN_EXPIRY_WARN_MS) return;
		notifyOnce(
			ctx,
			`ark-login-expiry:${Math.floor(exp / 60_000)}`,
			`Ark SSO 登录将于 ${new Date(exp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 过期（约 ${Math.max(1, Math.round(left / 3_600_000))} 小时后）；运行 /cloud-quota login 重新登录`,
		);
	}

	let loginInFlight = false;
	const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
	/** Start the interactive Ark SSO login (opens the browser), refresh on completion. */
	function arkLogin(ctx: ExtensionContext) {
		if (loginInFlight) {
			ctx.ui.notify("Ark 登录已在进行中，请完成浏览器授权", "info");
			return;
		}
		loginInFlight = true;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "Ark 登录中…"));
		ctx.ui.notify(
			"已启动火山 SSO 登录：浏览器将打开，完成授权后自动刷新用量",
			"info",
		);
		const finish = (ok: boolean, message: string) => {
			if (!loginInFlight) return;
			loginInFlight = false;
			ctx.ui.notify(message, ok ? "info" : "error");
			if (ok) {
				notified.delete("ark-needs-login");
				void refresh(ctx, ARK_SPEC, true);
			} else {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "Ark 未登录"));
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("arkcli", ["auth", "login", "volc-sso"], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			finish(false, "无法启动 arkcli，请确认已安装 @volcengine/ark-cli");
			return;
		}
		child.unref();
		const timer = setTimeout(
			() => finish(false, "Ark 登录超时：请重新运行 /cloud-quota login"),
			LOGIN_TIMEOUT_MS,
		);
		child.on("exit", (code) => {
			clearTimeout(timer);
			execFileP("arkcli", ["auth", "status"], { timeout: 10_000 })
				.then(({ stdout }) => {
					const ok = arkAuthOk(stdout);
					if (ok) {
						finish(true, "Ark 登录成功，用量已刷新");
						return;
					}
					finish(
						false,
						isArkRateLimited(stdout)
							? "Ark 登录被限流（token 交换被拒绝），等几分钟后重试 /cloud-quota login"
							: `Ark 登录失败（exit ${code ?? "?"}），请重试`,
					);
				})
				.catch(
					(e: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
						const output = `${e?.stdout ?? ""}${e?.stderr ?? ""}${e?.message ?? ""}`;
						finish(
							false,
							isArkRateLimited(output)
								? "Ark 登录被限流（token 交换被拒绝），等几分钟后重试 /cloud-quota login"
								: "Ark 登录失败，请重试",
						);
					},
				);
		});
	}

	function handle(ctx: ExtensionContext, force = false) {
		lastCtx = ctx;
		const spec = specFor(ctx);
		if (!spec) {
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				/* stale ctx */
			}
			return;
		}
		void refresh(ctx, spec, force);
	}

	let timer: number | undefined;
	function startTimer(ms: number) {
		if (timer !== undefined) clearInterval(timer);
		timer = setInterval(() => {
			if (!lastCtx) return;
			const spec = specFor(lastCtx);
			if (spec) void refresh(lastCtx, spec, true);
			else {
				// provider no longer matches (e.g. gateway probe marked dead)
				try {
					lastCtx.ui.setStatus(STATUS_KEY, undefined);
					cacheClearStale();
				} catch {
					/* stale ctx */
				}
			}
		}, ms) as unknown as number;
		(timer as unknown as { unref?: () => void }).unref?.();
	}
	startTimer(readConfig().refreshIntervalMs);

	pi.registerCommand("cloud-quota", {
		description:
			"Configure cloud-quota (refresh interval, thresholds, width) or log in to Ark",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (args.trim() === "login") {
				arkLogin(ctx);
				return;
			}
			const cfg = readConfig();
			const intervalLabel = (ms: number) =>
				INTERVALS.find((i) => i.ms === ms)?.label ?? `${ms}ms`;
			const choice = await ctx.ui.select("cloud-quota", [
				"Ark SSO login (未登录/快过期时重新登录)",
				`Refresh interval: ${intervalLabel(cfg.refreshIntervalMs)} (current)`,
				`5h reset threshold: ${cfg.resetThresholds["5h"]}% remaining (current)`,
				`Week reset threshold: ${cfg.resetThresholds.wk}% remaining (current)`,
				`Max status width: ${cfg.maxWidth > 0 ? `${cfg.maxWidth} chars` : "off"} (current)`,
			]);
			if (!choice) return;
			if (choice.startsWith("Ark SSO login")) {
				arkLogin(ctx);
				return;
			}
			const THRESHOLD_OPTIONS = [0, 20, 40, 60, 80, 90, 100];
			const thLabel = (v: number) =>
				v === 0 ? "never" : v === 100 ? "always" : `${v}% remaining`;
			const pick = async (
				title: string,
				options: number[],
				label: (v: number) => string,
				current: number,
			): Promise<number | undefined> => {
				const labels = options.map((v) =>
					v === current ? `${label(v)} (current)` : label(v),
				);
				return options[labels.indexOf(await ctx.ui.select(title, labels))];
			};

			if (choice.startsWith("Refresh interval")) {
				const labels = INTERVALS.map((i) =>
					i.ms === cfg.refreshIntervalMs ? `${i.label} (current)` : i.label,
				);
				const sel = INTERVALS[
					labels.indexOf(await ctx.ui.select("refresh interval", labels))
				];
				if (!sel) return;
				saveConfig({ refreshIntervalMs: sel.ms });
				startTimer(sel.ms);
				ctx.ui.notify(`cloud-quota refresh interval: ${sel.label}`);
				handle(ctx, true); // refresh now on the new cadence
			} else if (choice.startsWith("5h reset threshold")) {
				const v = await pick(
					"5h reset threshold (show reset while remaining < value)",
					THRESHOLD_OPTIONS,
					thLabel,
					cfg.resetThresholds["5h"],
				);
				if (v === undefined) return;
				saveConfig({ resetThresholds: { ...cfg.resetThresholds, "5h": v } });
				ctx.ui.notify(`cloud-quota 5h reset threshold: ${thLabel(v)}`);
				handle(ctx, false); // re-render with new settings
			} else if (choice.startsWith("Week reset threshold")) {
				const v = await pick(
					"week reset threshold (show reset while remaining < value)",
					THRESHOLD_OPTIONS,
					thLabel,
					cfg.resetThresholds.wk,
				);
				if (v === undefined) return;
				saveConfig({ resetThresholds: { ...cfg.resetThresholds, wk: v } });
				ctx.ui.notify(`cloud-quota week reset threshold: ${thLabel(v)}`);
				handle(ctx, false);
			} else if (choice.startsWith("Max status width")) {
				const WIDTH_OPTIONS = [0, 24, 32, 40, 48, 64];
				const wLabel = (v: number) => (v === 0 ? "off" : `${v} chars`);
				const v = await pick(
					"max status width (0 = off)",
					WIDTH_OPTIONS,
					wLabel,
					cfg.maxWidth,
				);
				if (v === undefined) return;
				saveConfig({ maxWidth: v });
				ctx.ui.notify(`cloud-quota max status width: ${wLabel(v)}`);
				handle(ctx, false);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => handle(ctx));
	pi.on("model_select", async (_event, ctx) => handle(ctx));
}
