// Functional test for server-side position sizing (calculatePositionSize tool +
// riskPercentage enforcement on addOrder/addStopOrder). KuCoin is fully mocked
// via a fetch stub — no network call ever reaches the real exchange.
process.env.MCP_AUTH_KEY = "testkey";
process.env.MCP_DEBUG = "false";
process.env.KUCOIN_API_KEY = "k";
process.env.KUCOIN_API_SECRET = "s";
process.env.KUCOIN_API_PASSPHRASE = "p";

const EQUITY = 956.87;
const TICKER_PRICE = "63610";

// Captures every order POST that would have gone to KuCoin.
const orderCalls = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const ok = (data) => new Response(JSON.stringify({ code: "200000", data }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  if (u.includes("/api/v1/contracts/")) {
    return ok({ symbol: "XBTUSDTM", multiplier: 0.001, lotSize: 1, maxOrderQty: 1000000, tickSize: 0.1 });
  }
  if (u.includes("/api/v1/account-overview")) {
    return ok({ accountEquity: EQUITY, availableBalance: 400 });
  }
  if (u.includes("/api/v1/ticker")) {
    return ok({ symbol: "XBTUSDTM", price: TICKER_PRICE });
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

// T1: calculatePositionSize — 30% of equity at 2x on XBT @63610:
// 956.87*0.30=287.06 margin, *2 = 574.12 notional, /63.61 per lot = 9.02 -> 9 lots
let r = await call("calculatePositionSize", { symbol: "XBTUSDTM", riskPercentage: 30, leverage: 2, entryPrice: "63610" });
check("T1 calculatePositionSize size=9", r.body?.data?.size === 9, r.body);

// T2: same without entryPrice -> falls back to ticker (same price here)
r = await call("calculatePositionSize", { symbol: "XBTUSDTM", riskPercentage: 30, leverage: 2 });
check("T2 ticker fallback size=9", r.body?.data?.size === 9, r.body);

// T3: ta_ entry WITHOUT riskPercentage -> rejected, nothing sent to KuCoin
orderCalls.length = 0;
r = await call("addStopOrder", {
  clientOid: "ta_XBTUSDTM_long_1781259300", symbol: "XBTUSDTM", side: "buy", type: "limit",
  price: "63610", size: 999, leverage: 2, marginMode: "ISOLATED", stopPriceType: "MP",
  triggerStopDownPrice: "61606.7", triggerStopUpPrice: "66614.9",
});
check("T3 ta_ ohne riskPercentage abgelehnt", JSON.stringify(r.body).includes("riskPercentage is required"), r.body);
check("T3 kein Exchange-Call", orderCalls.length === 0, orderCalls);

// T4: ta_ entry WITH riskPercentage=5, lev 2 -> server computes size=1, overrides size=999, strips riskPercentage
orderCalls.length = 0;
r = await call("addStopOrder", {
  clientOid: "ta_XBTUSDTM_long_1781259300", symbol: "XBTUSDTM", side: "buy", type: "limit",
  price: "63610", size: 999, riskPercentage: 5, leverage: 2, marginMode: "ISOLATED", stopPriceType: "MP",
  triggerStopDownPrice: "61606.7", triggerStopUpPrice: "66614.9",
});
check("T4 Order ging raus", orderCalls.length === 1, orderCalls);
check("T4 size server-berechnet=1 (999 überschrieben)", orderCalls[0]?.body?.size === 1, orderCalls[0]?.body);
check("T4 riskPercentage gestrippt", !("riskPercentage" in (orderCalls[0]?.body || {})), orderCalls[0]?.body);

// T5: addOrder mit riskPercentage statt size (non-ta_) -> size berechnet
orderCalls.length = 0;
r = await call("addOrder", {
  symbol: "XBTUSDTM", side: "buy", type: "limit", price: "63610",
  riskPercentage: 30, leverage: 2, marginMode: "ISOLATED", positionSide: "BOTH",
});
check("T5 addOrder size=9", orderCalls[0]?.body?.size === 9, orderCalls[0]?.body);

// T6: manuelle Order (non-ta_) mit size, ohne riskPercentage -> unverändert durchgelassen
orderCalls.length = 0;
r = await call("addOrder", {
  symbol: "XBTUSDTM", side: "buy", type: "market", size: 3,
  leverage: 2, marginMode: "ISOLATED", positionSide: "BOTH",
});
check("T6 manuelle Order unverändert (size=3)", orderCalls[0]?.body?.size === 3, orderCalls[0]?.body);

// T7: closeOrder-Stop ohne size/riskPercentage (Risk-Management) -> nie blockiert
orderCalls.length = 0;
r = await call("addStopOrder", {
  symbol: "XBTUSDTM", closeOrder: true, stopPriceType: "MP", triggerStopDownPrice: "60000",
});
check("T7 closeOrder durchgelassen", orderCalls.length === 1, r.body);

// T8: ta_ reduceOnly-Close ohne riskPercentage -> erlaubt (Pflicht gilt nur für Entries)
orderCalls.length = 0;
r = await call("addOrder", {
  clientOid: "ta_XBTUSDTM_exit_123", symbol: "XBTUSDTM", side: "sell", type: "market",
  size: 1, reduceOnly: true, marginMode: "ISOLATED", positionSide: "BOTH",
});
check("T8 ta_ reduceOnly ohne risk erlaubt", orderCalls.length === 1, r.body);

// T9: Risk-Budget zu klein -> klare Ablehnung, kein Exchange-Call
orderCalls.length = 0;
r = await call("addStopOrder", {
  clientOid: "ta_XBTUSDTM_long_999", symbol: "XBTUSDTM", side: "buy", type: "limit",
  price: "63610", riskPercentage: 0.5, leverage: 1, marginMode: "ISOLATED", stopPriceType: "MP",
  triggerStopDownPrice: "61606.7",
});
check("T9 zu kleines Budget abgelehnt", JSON.stringify(r.body).includes("risk budget too small"), r.body);
check("T9 kein Exchange-Call", orderCalls.length === 0, orderCalls);

// T10: riskPercentage > 100 -> zod lehnt ab
r = await call("addOrder", {
  symbol: "XBTUSDTM", side: "buy", type: "market", riskPercentage: 150,
  leverage: 2, marginMode: "ISOLATED", positionSide: "BOTH",
});
check("T10 riskPercentage>100 abgelehnt", JSON.stringify(r.body).includes("Invalid arguments"), r.body);

console.log(failures === 0 ? "\nALLE SIZING-TESTS BESTANDEN" : `\n${failures} TEST(S) FEHLGESCHLAGEN`);
process.exit(failures === 0 ? 0 : 1);
