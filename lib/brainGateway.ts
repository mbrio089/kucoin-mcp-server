// ---- Brain risk gateway ----
// Hard, deterministic risk limits for the autonomous Hermes "futures brain".
// The brain authenticates with its own key (MCP_BRAIN_KEY) and is restricted
// to a narrow tool surface. Every exposure-opening order with a clientOid
// starting with 'hx_' (no matter which key sends it) passes through
// checkBrainEntry(): kill switch, equity floor, daily/weekly loss stop, entry
// count, symbol allowlist, mandatory stop-loss, stop distance band, leverage
// cap, risk-to-stop sizing and an account-wide open-risk budget.
//
// The limits live in Vercel environment variables (defaults below). The brain
// cannot change them — only the owner can. Every read is fail-closed: if the
// exchange state cannot be read, new entries are refused.
//
// Semantics differ from the legacy ta_* trader on purpose: for hx_* orders
// riskPercentage is the percent of equity LOST if the stop-loss is hit
// (risk-to-stop), not the percent of equity committed as margin.

export type Role = "admin" | "brain";

export const BRAIN_OID_PREFIX = /^hx_/;
export const BRAIN_EXPERIMENT_PREFIX = /^hx_x_/;
const BRAIN_OID_FORMAT = /^hx_[A-Za-z0-9_-]{1,37}$/;
const DAY_MS = 86_400_000;

export interface GatewayClient {
  getAccountFutures(currency?: string): Promise<any>;
  getSymbols(): Promise<any>;
  getPositions(): Promise<any>;
  getStopOrders(symbol?: string, side?: string, pageSize?: number, currentPage?: number): Promise<any>;
  getOrders(symbol?: string, status?: string, side?: string, pageSize?: number): Promise<any>;
  getPositionsHistory(symbol?: string, from?: number, to?: number, limit?: number, pageId?: number): Promise<any>;
  getTicker(symbol?: string): Promise<any>;
  getOrderById(orderId: string): Promise<any>;
}

export interface BrainLimits {
  tradingEnabled: boolean;
  riskPctMax: number;            // loss at stop per trade, % of equity
  experimentRiskPctMax: number;  // same for hx_x_* experiment entries
  maxConcurrentExperiments: number;
  openRiskPctMax: number;        // sum of loss-at-stop over all exposure, % of equity
  maxPositions: number;          // distinct symbols with position or resting entry
  dailyLossPct: number;          // stop new entries for the UTC day
  weeklyLossPct: number;         // rolling 7 days
  equityFloorUsdt: number;
  maxLeverage: number;
  minStopPct: number;
  maxStopPct: number;
  maxEntriesPerDay: number;
  topSymbols: number;
  minTurnoverUsdt: number;
  symbolAllowlist: string[] | null;
}

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v === null || String(v).trim() === "") return dflt;
  const n = Number(v);
  return isFinite(n) && n >= 0 ? n : dflt;
}

export function readBrainLimits(env: Record<string, string | undefined>): BrainLimits {
  const allow = (env.BRAIN_SYMBOL_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    tradingEnabled: env.BRAIN_TRADING_ENABLED === "true",
    riskPctMax: num(env.BRAIN_RISK_PCT_MAX, 1.5),
    experimentRiskPctMax: num(env.BRAIN_EXPERIMENT_RISK_PCT_MAX, 0.75),
    maxConcurrentExperiments: num(env.BRAIN_MAX_EXPERIMENTS, 1),
    openRiskPctMax: num(env.BRAIN_OPEN_RISK_PCT_MAX, 5),
    maxPositions: num(env.BRAIN_MAX_POSITIONS, 5),
    dailyLossPct: num(env.BRAIN_DAILY_LOSS_PCT, 4),
    weeklyLossPct: num(env.BRAIN_WEEKLY_LOSS_PCT, 10),
    equityFloorUsdt: num(env.BRAIN_EQUITY_FLOOR_USDT, 300),
    maxLeverage: num(env.BRAIN_MAX_LEVERAGE, 5),
    minStopPct: num(env.BRAIN_MIN_STOP_PCT, 0.4),
    maxStopPct: num(env.BRAIN_MAX_STOP_PCT, 6),
    maxEntriesPerDay: num(env.BRAIN_MAX_ENTRIES_PER_DAY, 8),
    topSymbols: num(env.BRAIN_TOP_SYMBOLS, 20),
    minTurnoverUsdt: num(env.BRAIN_MIN_TURNOVER_USDT, 20_000_000),
    symbolAllowlist: allow.length ? allow : null,
  };
}

const truthy = (v: unknown) => v === true || v === "true";
const isReduceLike = (o: any) => truthy(o?.reduceOnly) || truthy(o?.closeOrder);

export class BrainGatewayError extends Error {
  constructor(message: string) {
    super(`BRAIN_GATEWAY — ${message}`);
  }
}
const refuse = (why: string): never => {
  throw new BrainGatewayError(`${why} Nothing was sent to the exchange.`);
};

interface ContractInfo { multiplier: number; lotSize: number; tickSize: number; maxOrderQty: number | null; turnover: number; }

export interface PositionRisk {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  unrealisedPnl: number;
  protectiveStops: number[];
  unprotectedQty: number;
  riskUsdt: number;
  experiment: boolean;
  openedBy: string | null;
}

export interface BrainState {
  asOf: string;
  equity: number;
  availableBalance: number;
  contracts: Map<string, ContractInfo>;
  allowedSymbols: string[];
  positions: PositionRisk[];
  restingEntries: { symbol: string; clientOid: string; side: string; riskUsdt: number; experiment: boolean }[];
  openRiskUsdt: number;
  dayPnlUsdt: number;
  weekPnlUsdt: number;
  entriesToday: number;
  experimentsOpen: number;
  stopOrders: any[];
}

function ok(resp: any, what: string): any {
  if (!resp || resp.code !== "200000") refuse(`could not read ${what} (code ${resp?.code}); fail-closed.`);
  return resp.data;
}

// Loss-at-stop of one open position. Protective stops (long: sell/down,
// short: buy/up, reduce-only or closeOrder) cover the quantity nearest-first;
// any uncovered remainder counts with its full isolated margin share.
function positionRisk(p: any, stops: any[], multiplier: number): { risk: number; prices: number[]; unprotected: number } {
  const qty = Number(p.currentQty) || 0;
  const absQty = Math.abs(qty);
  const entry = Number(p.avgEntryPrice) || 0;
  const long = qty > 0;
  const prot = stops
    .filter((s) => s.symbol === p.symbol && s.isActive !== false && isReduceLike(s) &&
      String(s.side).toLowerCase() === (long ? "sell" : "buy") && String(s.stop) === (long ? "down" : "up"))
    .map((s) => ({ price: Number(s.stopPrice), size: truthy(s.closeOrder) ? absQty : Number(s.size) || 0 }))
    .filter((s) => isFinite(s.price) && s.price > 0)
    .sort((a, b) => (long ? b.price - a.price : a.price - b.price)); // nearest (first triggered) first
  let left = absQty;
  let risk = 0;
  for (const s of prot) {
    if (left <= 0) break;
    const take = Math.min(left, s.size);
    const dist = long ? entry - s.price : s.price - entry;
    risk += Math.max(0, dist) * take * multiplier;
    left -= take;
  }
  if (left > 0) {
    const margin = Number(p.posMargin) || Number(p.maintMargin) || entry * absQty * multiplier;
    risk += margin * (left / absQty);
  }
  return { risk, prices: prot.map((s) => s.price), unprotected: left };
}

export async function computeBrainState(client: GatewayClient, limits: BrainLimits, now: number = Date.now()): Promise<BrainState> {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const weekStart = now - 7 * DAY_MS;
  let acc: any, contractsR: any, posR: any, stopR: any, activeR: any, doneR: any, histR: any;
  try {
    [acc, contractsR, posR, stopR, activeR, doneR, histR] = await Promise.all([
      client.getAccountFutures("USDT"),
      client.getSymbols(),
      client.getPositions(),
      client.getStopOrders(undefined, undefined, 200, 1),
      client.getOrders(undefined, "active", undefined, 100),
      client.getOrders(undefined, "done", undefined, 100),
      client.getPositionsHistory(undefined, weekStart, now, 200, 1),
    ]);
  } catch (err: any) {
    refuse(`could not read exchange state (${err?.message ?? err}); fail-closed.`);
  }
  const account = ok(acc, "account overview");
  const equity = Number(account.accountEquity);
  const availableBalance = Number(account.availableBalance);
  if (!isFinite(equity) || equity <= 0) refuse("account equity unreadable; fail-closed.");

  const contracts = new Map<string, ContractInfo>();
  for (const c of ok(contractsR, "contracts") || []) {
    contracts.set(c.symbol, {
      multiplier: Number(c.multiplier),
      lotSize: Number(c.lotSize) > 0 ? Number(c.lotSize) : 1,
      tickSize: Number(c.tickSize),
      maxOrderQty: Number(c.maxOrderQty) > 0 ? Number(c.maxOrderQty) : null,
      turnover: Number(c.turnoverOf24h) || 0,
    });
  }
  let allowedSymbols: string[];
  if (limits.symbolAllowlist) {
    allowedSymbols = limits.symbolAllowlist.filter((s) => contracts.has(s));
  } else {
    allowedSymbols = (ok(contractsR, "contracts") || [])
      .filter((c: any) => c.quoteCurrency === "USDT" && c.settleCurrency === "USDT" && c.status === "Open" && !c.isInverse &&
        (Number(c.turnoverOf24h) || 0) >= limits.minTurnoverUsdt)
      .sort((a: any, b: any) => (Number(b.turnoverOf24h) || 0) - (Number(a.turnoverOf24h) || 0))
      .slice(0, limits.topSymbols)
      .map((c: any) => c.symbol);
  }

  const stopOrders: any[] = (ok(stopR, "stop orders")?.items) || [];
  const active: any[] = (ok(activeR, "active orders")?.items) || [];
  const done: any[] = (ok(doneR, "done orders")?.items) || [];
  const hist: any[] = (ok(histR, "positions history")?.items) || [];
  const rawPositions: any[] = (ok(posR, "positions") || []).filter((p: any) => p && p.isOpen !== false && Number(p.currentQty) !== 0);

  // Latest filled exposure-opening order per symbol tells who opened the position.
  const openerBySymbol = new Map<string, string>();
  for (const o of [...done].sort((a, b) => Number(b.createdAt) - Number(a.createdAt))) {
    if (isReduceLike(o) || !(Number(o.filledSize) > 0) || openerBySymbol.has(o.symbol)) continue;
    openerBySymbol.set(o.symbol, String(o.clientOid || ""));
  }

  const positions: PositionRisk[] = rawPositions.map((p) => {
    const mult = contracts.get(p.symbol)?.multiplier || 1;
    const r = positionRisk(p, stopOrders, mult);
    const opener = openerBySymbol.get(p.symbol) ?? null;
    return {
      symbol: p.symbol,
      qty: Number(p.currentQty),
      avgEntryPrice: Number(p.avgEntryPrice),
      unrealisedPnl: Number(p.unrealisedPnl) || 0,
      protectiveStops: r.prices,
      unprotectedQty: r.unprotected,
      riskUsdt: r.risk,
      experiment: !!opener && BRAIN_EXPERIMENT_PREFIX.test(opener),
      openedBy: opener,
    };
  });

  const restingEntries = active
    .filter((o) => !isReduceLike(o) && !o.stop && o.isActive !== false)
    .map((o) => {
      const oid = String(o.clientOid || "");
      const exp = BRAIN_EXPERIMENT_PREFIX.test(oid);
      let risk: number;
      if (BRAIN_OID_PREFIX.test(oid)) {
        // Attached brackets only materialise on fill; count the hx_ cap.
        risk = equity * (exp ? limits.experimentRiskPctMax : limits.riskPctMax) / 100;
      } else {
        risk = (Number(o.value) || 0) * limits.maxStopPct / 100;
      }
      return { symbol: o.symbol, clientOid: oid, side: o.side, riskUsdt: risk, experiment: exp };
    });

  const openRiskUsdt = positions.reduce((s, p) => s + p.riskUsdt, 0) + restingEntries.reduce((s, o) => s + o.riskUsdt, 0);
  const unreal = positions.reduce((s, p) => s + p.unrealisedPnl, 0);
  const closedSince = (t: number) => hist.filter((h) => Number(h.closeTime) >= t).reduce((s, h) => s + (Number(h.pnl) || 0), 0);
  const dayPnlUsdt = closedSince(dayStart) + unreal;
  const weekPnlUsdt = closedSince(weekStart) + unreal;

  const entriesToday = [...active, ...done].filter((o) =>
    BRAIN_OID_PREFIX.test(String(o.clientOid || "")) && !isReduceLike(o) && Number(o.createdAt) >= dayStart &&
    (o.isActive !== false || Number(o.filledSize) > 0)
  ).length;
  const experimentsOpen = positions.filter((p) => p.experiment).length + restingEntries.filter((o) => o.experiment).length;

  return {
    asOf: new Date(now).toISOString(), equity, availableBalance, contracts, allowedSymbols, positions, restingEntries,
    openRiskUsdt, dayPnlUsdt, weekPnlUsdt, entriesToday, experimentsOpen, stopOrders,
  };
}

// Account-level reasons why no new entry may be opened right now.
export function generalBlockers(state: BrainState, limits: BrainLimits): string[] {
  const b: string[] = [];
  const startOfDayEquity = state.equity - state.dayPnlUsdt;
  const startOfWeekEquity = state.equity - state.weekPnlUsdt;
  if (!limits.tradingEnabled) b.push("KILL_SWITCH: BRAIN_TRADING_ENABLED is not 'true' — only the owner can enable trading.");
  if (state.equity < limits.equityFloorUsdt)
    b.push(`EQUITY_FLOOR: equity ${state.equity.toFixed(2)} < floor ${limits.equityFloorUsdt} USDT.`);
  if (startOfDayEquity > 0 && state.dayPnlUsdt <= -limits.dailyLossPct / 100 * startOfDayEquity)
    b.push(`DAILY_LOSS: today ${state.dayPnlUsdt.toFixed(2)} USDT ≤ −${limits.dailyLossPct}% — no new entries until 00:00 UTC.`);
  if (startOfWeekEquity > 0 && state.weekPnlUsdt <= -limits.weeklyLossPct / 100 * startOfWeekEquity)
    b.push(`WEEKLY_LOSS: last 7 days ${state.weekPnlUsdt.toFixed(2)} USDT ≤ −${limits.weeklyLossPct}% — no new entries.`);
  if (state.entriesToday >= limits.maxEntriesPerDay)
    b.push(`ENTRIES_PER_DAY: ${state.entriesToday} hx_ entries today (max ${limits.maxEntriesPerDay}).`);
  if (state.openRiskUsdt >= limits.openRiskPctMax / 100 * state.equity)
    b.push(`OPEN_RISK: ${state.openRiskUsdt.toFixed(2)} USDT already at stop-risk (max ${limits.openRiskPctMax}% of equity).`);
  return b;
}

function occupiedSymbols(state: BrainState): Set<string> {
  return new Set([...state.positions.map((p) => p.symbol), ...state.restingEntries.map((o) => o.symbol)]);
}

export function riskBudgetReport(state: BrainState, limits: BrainLimits) {
  const blockers = generalBlockers(state, limits);
  const occ = occupiedSymbols(state);
  if (occ.size >= limits.maxPositions) blockers.push(`MAX_POSITIONS: ${occ.size} symbols occupied (max ${limits.maxPositions}) — only symbols already held can be added to.`);
  const pct = (v: number) => Math.round((v / state.equity) * 10000) / 100;
  return {
    asOf: state.asOf,
    canOpenNewEntries: blockers.length === 0,
    blockers,
    equityUsdt: state.equity,
    availableBalanceUsdt: state.availableBalance,
    limits: { ...limits, symbolAllowlist: undefined },
    usage: {
      openRiskUsdt: state.openRiskUsdt,
      openRiskPct: pct(state.openRiskUsdt),
      remainingRiskUsdt: Math.max(0, limits.openRiskPctMax / 100 * state.equity - state.openRiskUsdt),
      occupiedSymbols: [...occ],
      dayPnlUsdt: state.dayPnlUsdt,
      weekPnlUsdt: state.weekPnlUsdt,
      entriesToday: state.entriesToday,
      experimentsOpen: state.experimentsOpen,
    },
    positions: state.positions,
    restingEntries: state.restingEntries,
    allowedSymbols: state.allowedSymbols,
    rules: [
      "Entries only via addStopOrder with clientOid 'hx_…' (experiments 'hx_x_…'), ISOLATED margin, integer leverage ≤ maxLeverage.",
      "riskPercentage = % of equity lost if the stop-loss is hit; the server computes size from the stop distance.",
      "Long: triggerStopDownPrice (stop-loss) below entry is mandatory, triggerStopUpPrice (take-profit) optional. Short: the mirror image.",
      "Stop distance must be within [minStopPct, maxStopPct] of the entry price.",
      "Exits: addOrder/addStopOrder with reduceOnly or closeOrder against an open position.",
      "A protective stop can only be cancelled while another stop at least as tight still covers the position.",
    ],
  };
}

export interface EntrySizing {
  size: number; riskUsdt: number; riskPct: number; stopPct: number; entryPrice: number; stopLoss: number;
  takeProfit: number | null; leverage: number; marginUsdt: number; experiment: boolean; openRiskAfterUsdt: number;
}

// Validates an hx_* exposure-opening order and resolves its size. Mutates
// params (size, marginMode, positionSide, strips helper fields) on success.
export async function checkBrainEntry(
  client: GatewayClient, toolName: string, params: any, limits: BrainLimits, now: number = Date.now()
): Promise<EntrySizing> {
  if (toolName !== "addStopOrder") {
    refuse("hx_ entries must be placed with addStopOrder so the stop-loss is attached on fill (addOrder cannot carry one).");
  }
  const oid = String(params.clientOid || "");
  if (!BRAIN_OID_FORMAT.test(oid)) refuse(`clientOid '${oid}' must match hx_[A-Za-z0-9_-]{1,37} (max 40 chars).`);
  const experiment = BRAIN_EXPERIMENT_PREFIX.test(oid);

  const side = String(params.side ?? "").toLowerCase();
  if (side !== "buy" && side !== "sell") refuse(`side must be 'buy' or 'sell', got '${params.side}'.`);
  const long = side === "buy";
  const type = String(params.type ?? "").toLowerCase();
  if (type !== "limit" && type !== "market") refuse(`type must be 'limit' or 'market', got '${params.type}'.`);
  if (params.marginMode && String(params.marginMode).toUpperCase() !== "ISOLATED") refuse("only ISOLATED margin is allowed for hx_ entries.");
  if (params.positionSide && String(params.positionSide).toUpperCase() !== "BOTH") refuse("positionSide must be BOTH (one-way mode).");
  const leverage = Number(params.leverage);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > limits.maxLeverage)
    refuse(`leverage must be an integer in [1, ${limits.maxLeverage}], got ${params.leverage}.`);

  const riskPct = Number(params.riskPercentage);
  const cap = experiment ? limits.experimentRiskPctMax : limits.riskPctMax;
  if (!isFinite(riskPct) || riskPct <= 0) refuse("riskPercentage (percent of equity lost at the stop-loss) is required.");
  if (riskPct > cap) refuse(`riskPercentage ${riskPct}% exceeds the ${experiment ? "experiment " : ""}cap of ${cap}%.`);

  const state = await computeBrainState(client, limits, now);
  const blockers = generalBlockers(state, limits);
  if (blockers.length) refuse(blockers.join(" "));

  const symbol = String(params.symbol || "");
  if (!state.allowedSymbols.includes(symbol)) refuse(`${symbol} is not in the allowed symbol set (top ${limits.topSymbols} USDT perps by 24h turnover, ≥ ${limits.minTurnoverUsdt} USDT).`);
  const contract = state.contracts.get(symbol) as ContractInfo;
  if (!contract || !(contract.multiplier > 0)) refuse(`no contract details for ${symbol}.`);

  let entryPrice: number;
  if (type === "limit") {
    entryPrice = Number(params.price);
  } else {
    let t: any;
    try { t = await client.getTicker(symbol); } catch (err: any) { refuse(`ticker unreadable (${err?.message ?? err}); fail-closed.`); }
    entryPrice = Number(ok(t, "ticker")?.price);
  }
  if (!isFinite(entryPrice) || entryPrice <= 0) refuse("could not determine the entry price.");

  const slRaw = long ? params.triggerStopDownPrice : params.triggerStopUpPrice;
  const tpRaw = long ? params.triggerStopUpPrice : params.triggerStopDownPrice;
  const stopLoss = Number(slRaw);
  if (slRaw === undefined || slRaw === null || String(slRaw) === "" || !isFinite(stopLoss) || stopLoss <= 0)
    refuse(`a stop-loss is mandatory: set ${long ? "triggerStopDownPrice (below entry) for a long" : "triggerStopUpPrice (above entry) for a short"}.`);
  if (long ? stopLoss >= entryPrice : stopLoss <= entryPrice)
    refuse(`stop-loss ${stopLoss} is on the wrong side of entry ${entryPrice} for a ${long ? "long" : "short"}.`);
  let takeProfit: number | null = null;
  if (tpRaw !== undefined && tpRaw !== null && String(tpRaw) !== "") {
    takeProfit = Number(tpRaw);
    if (!isFinite(takeProfit) || (long ? takeProfit <= entryPrice : takeProfit >= entryPrice))
      refuse(`take-profit ${tpRaw} is on the wrong side of entry ${entryPrice}.`);
  }
  const stopDist = Math.abs(entryPrice - stopLoss);
  const stopPct = (stopDist / entryPrice) * 100;
  if (stopPct < limits.minStopPct || stopPct > limits.maxStopPct)
    refuse(`stop distance ${stopPct.toFixed(2)}% is outside [${limits.minStopPct}%, ${limits.maxStopPct}%].`);

  const occ = occupiedSymbols(state);
  if (!occ.has(symbol) && occ.size >= limits.maxPositions)
    refuse(`MAX_POSITIONS: ${occ.size} symbols already occupied (max ${limits.maxPositions}).`);
  if (experiment && state.experimentsOpen >= limits.maxConcurrentExperiments)
    refuse(`only ${limits.maxConcurrentExperiments} concurrent experiment(s) allowed; ${state.experimentsOpen} open.`);

  const lot = contract.lotSize;
  let size = Math.floor((state.equity * riskPct / 100) / (stopDist * contract.multiplier) / lot) * lot;
  if (contract.maxOrderQty !== null && size > contract.maxOrderQty) size = Math.floor(contract.maxOrderQty / lot) * lot;
  if (!(size >= lot)) {
    refuse(`risk budget too small: ${riskPct}% of ${state.equity.toFixed(2)} USDT at a ${stopPct.toFixed(2)}% stop is less than one lot of ${symbol}.`);
  }
  const riskUsdt = size * stopDist * contract.multiplier;
  const marginUsdt = (size * entryPrice * contract.multiplier) / leverage;
  if (marginUsdt > state.availableBalance)
    refuse(`needs ${marginUsdt.toFixed(2)} USDT margin at ${leverage}x but only ${state.availableBalance.toFixed(2)} available — use higher leverage (≤ ${limits.maxLeverage}) or a smaller riskPercentage.`);
  const openRiskAfter = state.openRiskUsdt + riskUsdt;
  if (openRiskAfter > limits.openRiskPctMax / 100 * state.equity + 1e-9)
    refuse(`OPEN_RISK: would raise open stop-risk to ${openRiskAfter.toFixed(2)} USDT (max ${(limits.openRiskPctMax / 100 * state.equity).toFixed(2)}). Use a smaller riskPercentage.`);

  delete params.riskPercentage;
  delete params.qty;
  delete params.valueQty;
  params.size = size;
  params.marginMode = "ISOLATED";
  params.positionSide = "BOTH";
  params.leverage = leverage;
  if (!params.stopPriceType) params.stopPriceType = "MP";

  return {
    size, riskUsdt, riskPct: (riskUsdt / state.equity) * 100, stopPct, entryPrice, stopLoss, takeProfit,
    leverage, marginUsdt, experiment, openRiskAfterUsdt: openRiskAfter,
  };
}

const BRAIN_READ_TOOLS = new Set([
  "getSymbols", "getTicker", "getOrderBook", "getKlines", "getSymbolDetail", "calculatePositionSize",
  "getOrders", "getOrderById", "getPositions", "getPosition", "getFundingRate", "getFundingHistory",
  "getAccountFutures", "getOpenOrders", "getStopOrders", "getPositionsHistory", "getFills", "getRiskBudget",
]);

// Tool-surface policy for the brain key. Runs before the regular per-tool
// enforcement. Exposure-opening hx_ entries are checked by checkBrainEntry.
export async function enforceBrainRole(client: GatewayClient, name: string, params: any): Promise<void> {
  if (BRAIN_READ_TOOLS.has(name) || name === "modifyMargin") return;

  if (name === "cancelAllOrders") refuse("cancelAllOrders is not available to the brain (it would also drop protective stops).");

  if (name === "addOrder" || name === "addStopOrder") {
    const oid = String(params.clientOid || "");
    if (!BRAIN_OID_FORMAT.test(oid)) refuse(`the brain must use a clientOid matching hx_[A-Za-z0-9_-]{1,37}; got '${oid}'.`);
    if (!isReduceLike(params)) {
      if (name === "addOrder") refuse("entries must use addStopOrder with an attached stop-loss; addOrder is only for exits (reduceOnly/closeOrder).");
      return; // addStopOrder entry → checkBrainEntry
    }
    // Exit / protective order: must act against an existing position.
    let posR: any;
    try { posR = await client.getPositions(); } catch (err: any) { refuse(`positions unreadable (${err?.message ?? err}); fail-closed.`); }
    const pos = (ok(posR, "positions") || []).find((p: any) => p.symbol === params.symbol && Number(p.currentQty) !== 0);
    if (!pos) refuse(`${params.symbol} has no open position to reduce or close.`);
    if (!truthy(params.closeOrder)) {
      const side = String(params.side ?? "").toLowerCase();
      const need = Number(pos.currentQty) > 0 ? "sell" : "buy";
      if (side !== need) refuse(`a reduce-only order on a ${Number(pos.currentQty) > 0 ? "long" : "short"} must be side '${need}'.`);
    }
    return;
  }

  if (name === "cancelOrder") {
    let o: any;
    try { o = ok(await client.getOrderById(String(params.orderId)), "order"); } catch (err: any) {
      if (err instanceof BrainGatewayError) throw err;
      refuse(`order unreadable (${err?.message ?? err}); fail-closed.`);
    }
    if (!BRAIN_OID_PREFIX.test(String(o?.clientOid || "")))
      refuse(`order ${params.orderId} was not placed by the brain (clientOid '${o?.clientOid || ""}'); attached stops are cancelled with cancelStopOrder.`);
    return;
  }

  if (name === "cancelStopOrder") {
    let stopR: any, posR: any;
    try {
      [stopR, posR] = await Promise.all([client.getStopOrders(undefined, undefined, 200, 1), client.getPositions()]);
    } catch (err: any) { refuse(`stops/positions unreadable (${err?.message ?? err}); fail-closed.`); }
    const stops: any[] = ok(stopR, "stop orders")?.items || [];
    const target = stops.find((s) => String(s.id) === String(params.orderId));
    if (!target) return; // the regular cancelStopOrder guard refuses unknown ids
    const pos = (ok(posR, "positions") || []).find((p: any) => p.symbol === target.symbol && Number(p.currentQty) !== 0);
    if (!pos) return; // stale stop without a position
    const long = Number(pos.currentQty) > 0;
    const isProtective = String(target.side).toLowerCase() === (long ? "sell" : "buy") && String(target.stop) === (long ? "down" : "up");
    if (!isProtective) return; // take-profit
    const remaining = stops.filter((s) => String(s.id) !== String(target.id));
    const others = remaining.filter((s) => s.symbol === target.symbol && isReduceLike(s) &&
      String(s.side).toLowerCase() === (long ? "sell" : "buy") && String(s.stop) === (long ? "down" : "up"));
    const tp = Number(target.stopPrice);
    const covered = others.some((s) => {
      const p = Number(s.stopPrice);
      const atLeastAsTight = long ? p >= tp : p <= tp;
      const size = truthy(s.closeOrder) ? Infinity : Number(s.size) || 0;
      return atLeastAsTight && size >= Math.abs(Number(pos.currentQty));
    });
    if (!covered)
      refuse(`stop ${target.id} is the protective stop-loss of the open ${target.symbol} position; place a tighter (or equal) reduce-only stop first, then cancel this one.`);
    return;
  }

  refuse(`tool '${name}' is not available to the brain.`);
}
