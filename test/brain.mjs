// Functional test for the brain risk gateway (lib/brainGateway.ts).
// KuCoin is fully mocked via a fetch stub — no network call reaches the exchange.
process.env.MCP_AUTH_KEY = "adminkey";
process.env.MCP_BRAIN_KEY = "brainkey";
process.env.MCP_DEBUG = "false";
process.env.KUCOIN_API_KEY = "k";
process.env.KUCOIN_API_SECRET = "s";
process.env.KUCOIN_API_PASSPHRASE = "p";

const NOW = Date.now();
const DAY = 86_400_000;
const dayStart = Math.floor(NOW / DAY) * DAY;

let S;
function reset() {
  process.env.BRAIN_TRADING_ENABLED = "true";
  delete process.env.BRAIN_SYMBOL_ALLOWLIST;
  S = {
    equity: 1000, available: 900,
    positions: [],      // {symbol,currentQty,avgEntryPrice,unrealisedPnl,posMargin}
    stops: [],          // {id,symbol,side,stop,stopPrice,size,reduceOnly,closeOrder}
    active: [], done: [], hist: [],
    tickers: { ETHUSDTM: 2000, XBTUSDTM: 80000 },
    failAccount: false,
    orderCalls: [], deleteCalls: [],
    orderById: {},
  };
}
const contracts = [
  { symbol: "XBTUSDTM", quoteCurrency: "USDT", settleCurrency: "USDT", status: "Open", isInverse: false, multiplier: 0.001, lotSize: 1, tickSize: 0.1, maxOrderQty: 1000000, turnoverOf24h: 900e6 },
  { symbol: "ETHUSDTM", quoteCurrency: "USDT", settleCurrency: "USDT", status: "Open", isInverse: false, multiplier: 0.01, lotSize: 1, tickSize: 0.01, maxOrderQty: 1000000, turnoverOf24h: 300e6 },
  { symbol: "SOLUSDTM", quoteCurrency: "USDT", settleCurrency: "USDT", status: "Open", isInverse: false, multiplier: 0.1, lotSize: 1, tickSize: 0.001, maxOrderQty: 1000000, turnoverOf24h: 200e6 },
  { symbol: "XRPUSDTM", quoteCurrency: "USDT", settleCurrency: "USDT", status: "Open", isInverse: false, multiplier: 10, lotSize: 1, tickSize: 0.0001, maxOrderQty: 1000000, turnoverOf24h: 150e6 },
  { symbol: "ADAUSDTM", quoteCurrency: "USDT", settleCurrency: "USDT", status: "Open", isInverse: false, multiplier: 10, lotSize: 1, tickSize: 0.0001, maxOrderQty: 1000000, turnoverOf24h: 100e6 },
  { symbol: "DOGEUSDTM", quoteCurrency: "USDT", settleCurrency: "USDT", status: "Open", isInverse: false, multiplier: 100, lotSize: 1, tickSize: 0.00001, maxOrderQty: 1000000, turnoverOf24h: 90e6 },
  { symbol: "JUNKUSDTM", quoteCurrency: "USDT", settleCurrency: "USDT", status: "Open", isInverse: false, multiplier: 1, lotSize: 1, tickSize: 0.0001, maxOrderQty: 1000000, turnoverOf24h: 1e6 },
];

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const p = u.pathname;
  const method = (init.method || "GET").toUpperCase();
  const ok = (data, code = "200000") => new Response(JSON.stringify({ code, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  if (p === "/api/v1/account-overview") {
    if (S.failAccount) throw new Error("network down");
    return ok({ accountEquity: S.equity, availableBalance: S.available });
  }
  if (p === "/api/v1/contracts/active") return ok(contracts);
  if (p.startsWith("/api/v1/contracts/")) return ok(contracts.find((c) => c.symbol === p.split("/").pop()));
  if (p === "/api/v1/positions") return ok(S.positions.map((x) => ({ isOpen: true, ...x })));
  if (p === "/api/v1/position") {
    const sym = u.searchParams.get("symbol");
    const pos = S.positions.find((x) => x.symbol === sym);
    return ok({ symbol: sym, currentQty: pos ? pos.currentQty : 0, positionSide: "BOTH" });
  }
  if (p === "/api/v1/stopOrders") return ok({ items: S.stops.map((s) => ({ isActive: true, reduceOnly: true, closeOrder: false, ...s })) });
  if (p === "/api/v1/orders" && method === "GET") {
    const st = u.searchParams.get("status");
    const sym = u.searchParams.get("symbol");
    const list = (st === "active" ? S.active : S.done).filter((o) => !sym || o.symbol === sym);
    return ok({ items: list });
  }
  if (p === "/api/v1/history-positions") return ok({ items: S.hist });
  if (p === "/api/v1/ticker") return ok({ price: String(S.tickers[u.searchParams.get("symbol")]) });
  if (p.startsWith("/api/v1/orders/") && method === "GET") return ok(S.orderById[p.split("/").pop()]);
  if (p.startsWith("/api/v1/orders/") && method === "DELETE") { S.deleteCalls.push(p.split("/").pop()); return ok({ cancelledOrderIds: [p.split("/").pop()] }); }
  if ((p === "/api/v1/st-orders" || p === "/api/v1/orders") && method === "POST") {
    const body = JSON.parse(init.body);
    S.orderCalls.push({ path: p, body });
    return ok({ orderId: "TEST_ORDER_ID", clientOid: body.clientOid });
  }
  throw new Error("unexpected fetch in test: " + method + " " + u);
};

const handler = (await import("../api/mcp.ts")).default;

async function call(name, args, key = "brainkey") {
  const res = await handler(new Request("https://example.test/mcp?format=raw", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCP-Auth-Key": key },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  return { status: res.status, body: JSON.parse(await res.text()) };
}

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? "PASS" : "FAIL") + "  " + label + (cond ? "" : "  -> " + JSON.stringify(detail).slice(0, 600)));
  if (!cond) failures++;
}
const msg = (r) => JSON.stringify(r.body);
const refused = (r, needle) => msg(r).includes("BRAIN_GATEWAY") && (!needle || msg(r).includes(needle));
const placed = (r) => r.body?.data?.orderId === "TEST_ORDER_ID";

// ETH long: entry 2000, SL 1960 (2%), TP 2080. 1.5% of 1000 = 15 USDT risk
// -> size = 15 / (40 * 0.01) = 37.5 -> 37 lots, risk 14.8 USDT.
const ethLong = () => ({
  clientOid: "hx_ETH_long_1", symbol: "ETHUSDTM", side: "buy", type: "limit", price: "2000",
  leverage: 5, riskPercentage: 1.5, triggerStopDownPrice: "1960", triggerStopUpPrice: "2080", stopPriceType: "MP",
});

// B1 happy path: size from stop distance, ISOLATED forced, riskPercentage stripped
reset();
let r = await call("addStopOrder", ethLong());
check("B1 gültiger Long platziert", placed(r), r.body);
check("B1 Größe aus Stop-Abstand (37 Lots)", S.orderCalls[0]?.body.size === 37, S.orderCalls[0]?.body);
check("B1 riskPercentage nicht an Börse", S.orderCalls[0] && !("riskPercentage" in S.orderCalls[0].body), S.orderCalls[0]?.body);
check("B1 ISOLATED + BOTH gesetzt", S.orderCalls[0]?.body.marginMode === "ISOLATED" && S.orderCalls[0]?.body.positionSide === "BOTH", S.orderCalls[0]?.body);
check("B1 Gateway-Zusammenfassung in Antwort", Math.abs(r.body.brainGateway?.riskUsdt - 14.8) < 1e-6, r.body.brainGateway);

// B2 kill switch
reset(); process.env.BRAIN_TRADING_ENABLED = "false";
r = await call("addStopOrder", ethLong());
check("B2 Notaus blockt", refused(r, "KILL_SWITCH") && S.orderCalls.length === 0, r.body);

// B3 missing stop-loss
reset(); { const o = ethLong(); delete o.triggerStopDownPrice; r = await call("addStopOrder", o); }
check("B3 ohne Stop-Loss abgelehnt", refused(r, "stop-loss is mandatory") && S.orderCalls.length === 0, r.body);

// B4 stop on wrong side (short with SL below entry)
reset(); r = await call("addStopOrder", { ...ethLong(), side: "sell", triggerStopDownPrice: "1960", triggerStopUpPrice: undefined });
check("B4 Short ohne SL darüber abgelehnt", refused(r, "stop-loss is mandatory"), r.body);
reset(); r = await call("addStopOrder", { ...ethLong(), side: "sell", triggerStopUpPrice: "1990", triggerStopDownPrice: "1900" });
check("B4b Short-SL unter Einstieg abgelehnt", refused(r, "wrong side"), r.body);

// B5 stop distance band
reset(); r = await call("addStopOrder", { ...ethLong(), triggerStopDownPrice: "1995" });
check("B5 Stop 0,25 % zu eng", refused(r, "outside"), r.body);
reset(); r = await call("addStopOrder", { ...ethLong(), triggerStopDownPrice: "1860" });
check("B5b Stop 7 % zu weit", refused(r, "outside"), r.body);

// B6 leverage / margin mode
reset(); r = await call("addStopOrder", { ...ethLong(), leverage: 10 });
check("B6 Hebel 10 abgelehnt", refused(r, "leverage"), r.body);
reset(); r = await call("addStopOrder", { ...ethLong(), marginMode: "CROSS" });
check("B6b CROSS abgelehnt", refused(r, "ISOLATED"), r.body);

// B7 risk caps
reset(); r = await call("addStopOrder", { ...ethLong(), riskPercentage: 2 });
check("B7 2 % > 1,5 % abgelehnt", refused(r, "exceeds"), r.body);
reset(); r = await call("addStopOrder", { ...ethLong(), clientOid: "hx_x_ETH_1", riskPercentage: 1 });
check("B7b Experiment 1 % > 0,75 % abgelehnt", refused(r, "experiment cap"), r.body);
reset(); r = await call("addStopOrder", { ...ethLong(), clientOid: "hx_x_ETH_1", riskPercentage: 0.75 });
check("B7c Experiment 0,75 % ok", placed(r), r.body);

// B8 symbol allowlist (turnover filter)
reset(); r = await call("addStopOrder", { ...ethLong(), symbol: "JUNKUSDTM" });
check("B8 Junk-Symbol abgelehnt", refused(r, "allowed symbol set"), r.body);

// B9 open-risk budget: existing ETH-free positions with 40 USDT stop-risk
reset();
S.positions = [{ symbol: "XBTUSDTM", currentQty: 10, avgEntryPrice: 80000, unrealisedPnl: 0, posMargin: 200 }];
S.stops = [{ id: "s1", symbol: "XBTUSDTM", side: "sell", stop: "down", stopPrice: "76000", size: 10 }]; // 4000*10*0.001 = 40
r = await call("addStopOrder", ethLong());
check("B9 offenes Risiko 40 + 14,8 > 50 abgelehnt", refused(r, "OPEN_RISK"), r.body);
r = await call("addStopOrder", { ...ethLong(), riskPercentage: 0.9 });
check("B9b kleineres Risiko passt", placed(r), r.body);

// B10 unprotected position counts with full margin
reset();
S.positions = [{ symbol: "XBTUSDTM", currentQty: 10, avgEntryPrice: 80000, unrealisedPnl: 0, posMargin: 60 }];
r = await call("getRiskBudget", {});
check("B10 ungeschützte Position = Margin als Risiko", Math.abs(r.body.usage.openRiskUsdt - 60) < 1e-6 && r.body.canOpenNewEntries === false, r.body.usage);

// B11 max positions
reset();
S.positions = ["XBTUSDTM", "SOLUSDTM", "XRPUSDTM", "ADAUSDTM", "DOGEUSDTM"].map((s) => ({ symbol: s, currentQty: 1, avgEntryPrice: 1, unrealisedPnl: 0, posMargin: 0.1 }));
S.stops = S.positions.map((p, i) => ({ id: "s" + i, symbol: p.symbol, side: "sell", stop: "down", stopPrice: "0.99", size: 1 }));
r = await call("addStopOrder", ethLong());
check("B11 sechstes Symbol abgelehnt", refused(r, "MAX_POSITIONS"), r.body);

// B12 daily loss
reset(); S.equity = 960; S.hist = [{ closeTime: dayStart + 1000, pnl: "-41" }];
r = await call("addStopOrder", ethLong());
check("B12 Tagesverlust −4 % blockt", refused(r, "DAILY_LOSS"), r.body);
// B13 weekly loss (losses before today)
reset(); S.equity = 890; S.hist = [{ closeTime: NOW - 3 * DAY, pnl: "-111" }];
r = await call("addStopOrder", ethLong());
check("B13 Wochenverlust −10 % blockt", refused(r, "WEEKLY_LOSS"), r.body);
// B14 equity floor
reset(); S.equity = 299; S.available = 299;
r = await call("addStopOrder", ethLong());
check("B14 Equity-Untergrenze blockt", refused(r, "EQUITY_FLOOR"), r.body);
// B15 entries per day
reset(); S.done = Array.from({ length: 8 }, (_, i) => ({ symbol: "SOLUSDTM", clientOid: "hx_SOL_" + i, createdAt: dayStart + 1000 + i, filledSize: 1, isActive: false, reduceOnly: false }));
r = await call("addStopOrder", ethLong());
check("B15 8 Einstiege heute blockt", refused(r, "ENTRIES_PER_DAY"), r.body);

// B16 fail-closed
reset(); S.failAccount = true;
r = await call("addStopOrder", ethLong());
check("B16 Lesefehler = abgelehnt", msg(r).includes("BRAIN_GATEWAY") && S.orderCalls.length === 0, r.body);

// B17 margin check
reset(); S.available = 50; // 37 lots * 2000 * 0.01 / 1 = 740 margin at 1x
r = await call("addStopOrder", { ...ethLong(), leverage: 1 });
check("B17 zu wenig Margin abgelehnt", refused(r, "margin"), r.body);

// --- role policy ---
reset(); r = await call("addStopOrder", { ...ethLong(), clientOid: "ta_ETH_long_1" });
check("R1 Brain darf kein ta_ benutzen", refused(r, "hx_"), r.body);
reset(); r = await call("addOrder", { clientOid: "hx_ETH_mkt", symbol: "ETHUSDTM", side: "buy", type: "market", marginMode: "ISOLATED", positionSide: "BOTH", leverage: 2, size: 1 });
check("R2 Einstieg per addOrder abgelehnt", refused(r, "addStopOrder") && S.orderCalls.length === 0, r.body);
reset(); r = await call("cancelAllOrders", {});
check("R3 cancelAllOrders gesperrt", refused(r, "cancelAllOrders"), r.body);
reset(); S.positions = [{ symbol: "ETHUSDTM", currentQty: 3, avgEntryPrice: 2000, unrealisedPnl: 0, posMargin: 30 }];
r = await call("addOrder", { clientOid: "hx_ETH_close", symbol: "ETHUSDTM", side: "sell", type: "market", marginMode: "ISOLATED", positionSide: "BOTH", size: 3, reduceOnly: true });
check("R4 reduce-only Exit erlaubt", placed(r), r.body);
r = await call("addOrder", { clientOid: "hx_ETH_close2", symbol: "ETHUSDTM", side: "buy", type: "market", marginMode: "ISOLATED", positionSide: "BOTH", size: 3, reduceOnly: true });
check("R4b reduce-only falsche Seite abgelehnt", refused(r, "must be side 'sell'"), r.body);
r = await call("addOrder", { clientOid: "hx_SOL_close", symbol: "SOLUSDTM", side: "sell", type: "market", marginMode: "ISOLATED", positionSide: "BOTH", size: 1, reduceOnly: true });
check("R4c Exit ohne Position abgelehnt", refused(r, "no open position"), r.body);

// cancelStopOrder: sole protective stop refused, with tighter replacement allowed, TP free
reset();
S.positions = [{ symbol: "ETHUSDTM", currentQty: 3, avgEntryPrice: 2000, unrealisedPnl: 0, posMargin: 30 }];
S.stops = [
  { id: "sl1", symbol: "ETHUSDTM", side: "sell", stop: "down", stopPrice: "1950", size: 3 },
  { id: "tp1", symbol: "ETHUSDTM", side: "sell", stop: "up", stopPrice: "2100", size: 3 },
];
r = await call("cancelStopOrder", { orderId: "sl1" });
check("R5 einziger Stop-Loss nicht stornierbar", refused(r, "protective stop-loss") && S.deleteCalls.length === 0, r.body);
r = await call("cancelStopOrder", { orderId: "tp1" });
check("R5b Take-Profit stornierbar", S.deleteCalls.includes("tp1"), r.body);
S.stops.push({ id: "sl2", symbol: "ETHUSDTM", side: "sell", stop: "down", stopPrice: "1990", size: 3 });
r = await call("cancelStopOrder", { orderId: "sl1" });
check("R5c mit engerem Ersatz-Stop stornierbar", S.deleteCalls.includes("sl1"), r.body);

// cancelOrder only for hx_ orders
reset(); S.orderById = { o1: { id: "o1", clientOid: "ta_XRP_1" }, o2: { id: "o2", clientOid: "hx_XRP_1" } };
r = await call("cancelOrder", { orderId: "o1" });
check("R6 fremde Order nicht stornierbar", refused(r, "not placed by the brain"), r.body);
r = await call("cancelOrder", { orderId: "o2" });
check("R6b eigene Order stornierbar", S.deleteCalls.includes("o2"), r.body);

// admin path: ta_ unchanged, hx_ still gated
reset(); r = await call("addStopOrder", { ...ethLong(), clientOid: "ta_ETH_long_9", riskPercentage: 9, leverage: 2 }, "adminkey");
check("A1 Admin ta_ unverändert (Margin-Sizing)", placed(r) && S.orderCalls[0]?.body.size === 9, S.orderCalls[0]?.body);
reset(); process.env.BRAIN_TRADING_ENABLED = "false";
r = await call("addStopOrder", ethLong(), "adminkey");
check("A2 hx_ auch mit Admin-Key durchs Gateway", refused(r, "KILL_SWITCH"), r.body);
reset(); r = await call("cancelAllOrders", {}, "adminkey");
check("A3 Admin darf cancelAllOrders", !msg(r).includes("BRAIN_GATEWAY"), r.body);

// netting applies to hx_
reset(); S.positions = [{ symbol: "ETHUSDTM", currentQty: -3, avgEntryPrice: 2000, unrealisedPnl: 0, posMargin: 30 }];
S.stops = [{ id: "sx", symbol: "ETHUSDTM", side: "buy", stop: "up", stopPrice: "2050", size: 3 }];
r = await call("addStopOrder", ethLong());
check("N1 hx_-Long gegen Short = NETTING_GUARD", msg(r).includes("NETTING_GUARD") && S.orderCalls.length === 0, r.body);

// risk budget report
reset(); r = await call("getRiskBudget", {});
check("G1 Budget-Bericht erlaubt Einstiege", r.body.canOpenNewEntries === true && r.body.allowedSymbols.includes("ETHUSDTM") && !r.body.allowedSymbols.includes("JUNKUSDTM"), r.body);

// unauthenticated
reset(); r = await call("getRiskBudget", {}, "wrong");
check("U1 falscher Key 401", r.status === 401, r);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
