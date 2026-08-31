/**
 * pi-cloud-quota — subscription quota in the pi status bar for
 * Ark (Volcengine Agent/Coding Plan), Kimi For Coding, and Ollama Cloud.
 *
 * Format: `Ark 5h 91% ↺3h · wk 50% · mo 29%`
 *   - provider name prefix (Ark / Kimi / Ollama)
 *   - used percent per window, color-graded (green <70, yellow <90, red ≥90)
 *   - reset countdown per window, shown only while remaining quota is below a
 *     configurable threshold (defaults: 5h <80%, wk <40%); when the status
 *     exceeds the width budget the 5h reset is kept and the rest dropped
 *     (Ollama: predicted from the global reset grid — the API reports no
 *     reset times, but resets are epoch-aligned and identical for all
 *     accounts, see parseOllama)
 *
 * Sources:
 *   Ark          shells out to `arkcli usage plan` (official @volcengine/ark-cli,
 *                SSO login via `arkcli auth login volc-sso`); shown when the
 *                active provider's baseUrl is on volces.com
 *   Kimi         GET https://api.kimi.com/coding/v1/usages
 *                (credential: ~/.pi/agent/auth.json → kimi-coding)
 *   Ollama       GET https://ollama.com/api/usage
 *                (credential: ~/.pi/agent/models.json → providers.ollama-cloud.apiKey)
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

function kimiToken(): string | undefined {
	const cred = readJson(join(homedir(), ".pi", "agent", "auth.json"))?.[
		"kimi-coding"
	];
	return typeof cred === "string" ? cred : (cred?.key ?? cred?.access);
}

function ollamaKey(): string | undefined {
	return readJson(join(homedir(), ".pi", "agent", "models.json"))?.providers?.[
		"ollama-cloud"
	]?.apiKey;
}

async function fetchJson(url: string, token: string): Promise<any> {
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

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

// ---- provider specs ----

const ARK_SPEC: Spec = {
	name: "Ark",
	fetch: fetchArk,
	thresholds: [80, 90, 100],
};

interface Spec {
	name: string;
	fetch: () => Promise<Period[]>;
	/** severity thresholds [warning, high, critical]; defaults to 80/90/100 */
	thresholds?: Thresholds;
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
	if (
		typeof baseUrl === "string" &&
		baseUrl.toLowerCase().includes("volces.com")
	) {
		return ARK_SPEC;
	}
	if (provider === "kimi-coding") {
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
	if (provider === "ollama-cloud") {
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
	return undefined;
}

// ---- extension ----

export default function (pi: ExtensionAPI) {
	let lastCtx: ExtensionContext | undefined;
	const cache: Record<string, { periods: Period[]; fetchedAt: number }> = {};
	const inFlight = new Set<string>();
	/** Last fetch failure per spec; drives exponential backoff instead of retrying every tick. */
	const lastFailure: Record<string, { at: number; streak: number }> = {};
	/** Backoff after a failed fetch: TTL, 2×TTL, 4×TTL, capped at 30min. */
	const failureBackoffMs = (streak: number): number =>
		Math.min(TTL_MS * 2 ** (streak - 1), 30 * 60_000);

	const lastSeverity = new Map<string, Severity>();

	/** Toast on severity escalation only; critical → error, warning/high → warning. */
	function maybeWarn(ctx: ExtensionContext, spec: Spec, periods: Period[]) {
		const escalated: { p: Period; sev: Severity }[] = [];
		for (const p of periods) {
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

	function apply(ctx: ExtensionContext, spec: Spec, periods: Period[]) {
		const cfg = readConfig();
		const text = renderQuota(
			(role, t) => ctx.ui.theme.fg(role, t),
			spec.name,
			periods,
			{ resetThresholds: cfg.resetThresholds, maxWidth: cfg.maxWidth },
		);
		ctx.ui.setStatus(
			STATUS_KEY,
			text ?? ctx.ui.theme.fg("dim", `${spec.name} ⌀`),
		);
	}

	async function refresh(ctx: ExtensionContext, spec: Spec, force = false) {
		const hit = cache[spec.name];
		if (!force && hit && Date.now() - hit.fetchedAt < TTL_MS) {
			apply(ctx, spec, hit.periods);
			maybeWarn(ctx, spec, hit.periods);
			return;
		}
		const fail = lastFailure[spec.name];
		if (!force && fail && Date.now() - fail.at < failureBackoffMs(fail.streak))
			return;
		if (inFlight.has(spec.name)) return;
		inFlight.add(spec.name);
		try {
			const periods = await spec.fetch();
			cache[spec.name] = { periods, fetchedAt: Date.now() };
			delete lastFailure[spec.name];
			apply(ctx, spec, periods);
			maybeWarn(ctx, spec, periods);
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
