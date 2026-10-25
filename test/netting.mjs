// Functional test for the one-way-mode netting guard: ta_* entries must not
// act against an open position or a resting opposite-side ta_* entry.
// KuCoin is fully mocked via a fetch stub — no network call ever reaches the
// real exchange. Scenarios mirror the 21.10.2026 incident (ETH -3, XRP -13).
process.env.MCP_AUTH_KEY = "testkey";
process.env.MCP_DEBUG = "false";
process.env.KUCOIN_API_KEY = "k";
process.env.KUCOIN_API_SECRET = "s";
process.env.KUCOIN_API_PASSPHRASE = "p";

// Mutable exchange state per test.
let positionQty = {};      // symbol -> currentQty
let activeOrders = [];     // items of GET /orders?status=active
let positionCode = "200000";
let failPositionRead = false;
const orderCalls = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const ok = (data, code = "200000") => new Response(JSON.stringify({ code, data }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  if (u.includes("/api/v1/position?")) {
    if (failPositionRead) throw new Error("network down");
    const sym = new URL(u).searchParams.get("symbol");
    return ok({ symbol: sym, currentQty: positionQty[sym] ?? 0, positionSide: "BOTH" }, positionCode);
  }
  if (u.includes("/api/v1/orders?") && u.includes("status=active")) {
    const sym = new URL(u).searchParams.get("symbol");
    return ok({ currentPage: 1, pageSize: 100, totalNum: 0, items: activeOrders.filter(o => o.symbol === sym) });
  }
  if (u.includes("/api/v1/contracts/")) {
    return ok({ symbol: "ETHUSDTM", multiplier: 0.01, lotSize: 1, maxOrderQty: 1000000, tickSize: 0.01 });
  }
  if (u.includes("/api/v1/account-overview")) {
    return ok({ accountEquity: 439, availableBalance: 337 });
  }
  if (u.includes("/api/v1/st-orders") || u.match(/\/api\/v1\/orders$/)) {
    orderCalls.push({ url: u, body: JSON.parse(init.body) });
    return ok({ orderId: "TEST_ORDER_ID", clientOid: JSON.parse(init.body).clientOid });
  }
  throw new Error("unexpected fetch in test: " + u);
};

const mod = await import("../api/mcp.ts");
const handler = mod.default;

async function call(name, args) {
  const res = await handler(new Request("https://example.test/mcp?format=raw", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCP-Auth-Key": "testkey" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  return { status: res.status, body: JSON.parse(await res.text()) };
}

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? "PASS" : "FAIL") + "  " + label + (cond ? "" : "  -> " + JSON.stringify(detail)));
  if (!cond) failures++;
}
const guarded = (r) => JSON.stringify(r.body).includes("NETTING_GUARD");
const placed = (r) => r.body?.data?.orderId === "TEST_ORDER_ID";
function reset() {
  positionQty = {}; activeOrders = []; positionCode = "200000"; failPositionRead = false; orderCalls.length = 0;
}

// The exact 21.10. ETH bracket entry (Execution 30011), sent against ETH -3.
const ethLongBracket = {
  clientOid: "ta_ETHUSDTM_long_1792546869", symbol: "ETHUSDTM", side: "buy", type: "limit",
  price: "2444.39", riskPercentage: 9, marginMode: "ISOLATED", leverage: 2,
  triggerStopDownPrice: "2325.91", triggerStopUpPrice: "2622.12", stopPriceType: "MP",
};

// N1: buy entry against open SHORT -> refused, no order sent (incident replay)
reset(); positionQty.ETHUSDTM = -3;
let r = await call("addStopOrder", ethLongBracket);
check("N1 ta_ buy gegen offenen SHORT abgelehnt", guarded(r) && JSON.stringify(r.body).includes("currentQty -3"), r.body);
check("N1 kein Order-Call", orderCalls.length === 0, orderCalls);

// N2: sell entry against open LONG via addOrder -> refused
reset(); positionQty.ETHUSDTM = 3;
r = await call("addOrder", {
  clientOid: "ta_ETHUSDTM_short_1792546869", symbol: "ETHUSDTM", side: "sell", type: "limit", price: "2500",
  riskPercentage: 9, marginMode: "ISOLATED", positionSide: "BOTH", leverage: 2,
});
check("N2 ta_ sell gegen offenen LONG abgelehnt", guarded(r), r.body);
check("N2 kein Order-Call", orderCalls.length === 0, orderCalls);

// N3: flat symbol -> entry passes, server sizing still applied
reset();
r = await call("addStopOrder", ethLongBracket);
check("N3 flaches Symbol: Order geht raus", placed(r), r.body);
check("N3 Server-Sizing weiterhin aktiv", orderCalls[0]?.body?.size > 0 && orderCalls[0]?.body?.riskPercentage === undefined, orderCalls);

// N4: same-side add (buy on LONG) -> not this guard's business, passes
reset(); positionQty.ETHUSDTM = 3;
r = await call("addStopOrder", ethLongBracket);
check("N4 gleiche Richtung unberührt", placed(r), r.body);

// N5: resting opposite-side ta_ entry on a flat symbol -> refused
reset();
activeOrders = [{ symbol: "ETHUSDTM", side: "sell", size: 3, price: "2500", clientOid: "ta_ETHUSDTM_short_1", isActive: true, reduceOnly: false, closeOrder: false }];
r = await call("addStopOrder", ethLongBracket);
check("N5 ruhende Gegen-Entry blockiert", guarded(r) && JSON.stringify(r.body).includes("ta_ETHUSDTM_short_1"), r.body);
check("N5 kein Order-Call", orderCalls.length === 0, orderCalls);

// N6: resting opposite-side order that is NOT a ta_ entry (reduce-only, manual) -> ignored
reset();
activeOrders = [
  { symbol: "ETHUSDTM", side: "sell", size: 3, price: "2600", clientOid: "", isActive: true, reduceOnly: true, closeOrder: false },
  { symbol: "ETHUSDTM", side: "sell", size: 1, price: "2600", clientOid: "manual_1", isActive: true, reduceOnly: false, closeOrder: false },
];
r = await call("addStopOrder", ethLongBracket);
check("N6 reduceOnly-/Fremd-Orders ignoriert", placed(r), r.body);

// N7: explicit reduceOnly ta_ order against the position -> intentional close, untouched
reset(); positionQty.XRPUSDTM = -13;
r = await call("addOrder", {
  clientOid: "ta_XRPUSDTM_close_1", symbol: "XRPUSDTM", side: "buy", type: "market",
  size: 13, marginMode: "ISOLATED", positionSide: "BOTH", reduceOnly: true,
});
check("N7 explizites reduceOnly durchgelassen", placed(r), r.body);

// N8: non-ta_ orders (pm_, manual) never consult the guard
reset(); positionQty.XRPUSDTM = -13;
r = await call("addOrder", {
  clientOid: "manual_xrp_1", symbol: "XRPUSDTM", side: "buy", type: "limit", price: "1.3",
  size: 5, marginMode: "ISOLATED", positionSide: "BOTH", leverage: 2,
});
check("N8 manuelle Order unverändert", placed(r), r.body);

// N9: position read throws -> fail-closed
reset(); failPositionRead = true;
r = await call("addStopOrder", ethLongBracket);
check("N9 Lesefehler -> fail-closed", guarded(r) && JSON.stringify(r.body).includes("fail-closed"), r.body);
check("N9 kein Order-Call", orderCalls.length === 0, orderCalls);

// N10: exchange returns non-200000 code -> fail-closed
reset(); positionCode = "400100";
r = await call("addStopOrder", ethLongBracket);
check("N10 Fehlercode -> fail-closed", guarded(r) && JSON.stringify(r.body).includes("400100"), r.body);
check("N10 kein Order-Call", orderCalls.length === 0, orderCalls);

// N11: XRP partial-netting case (buy 5 against -13) -> refused
reset(); positionQty.XRPUSDTM = -13;
r = await call("addStopOrder", {
  clientOid: "ta_XRPUSDTM_long_1792546869", symbol: "XRPUSDTM", side: "buy", type: "limit",
  price: "1.33276", riskPercentage: 9, marginMode: "ISOLATED", leverage: 2,
  triggerStopDownPrice: "1.26612", triggerStopUpPrice: "1.43272", stopPriceType: "MP",
});
check("N11 XRP-Teilnetting abgelehnt", guarded(r) && JSON.stringify(r.body).includes("currentQty -13"), r.body);
check("N11 kein Order-Call", orderCalls.length === 0, orderCalls);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
