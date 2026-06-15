// Functional test for position-manager constraints (pm_* orders must be
// reduceOnly/closeOrder) and the getStopOrders tool. KuCoin is fully mocked
// via a fetch stub — no network call ever reaches the real exchange.
process.env.MCP_AUTH_KEY = "testkey";
process.env.MCP_DEBUG = "false";
process.env.KUCOIN_API_KEY = "k";
process.env.KUCOIN_API_SECRET = "s";
process.env.KUCOIN_API_PASSPHRASE = "p";

// Captures every request that would have gone to KuCoin.
const exchangeCalls = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const ok = (data) => new Response(JSON.stringify({ code: "200000", data }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  if (u.includes("/api/v1/stopOrders")) {
    exchangeCalls.push({ url: u });
    return ok({ currentPage: 1, pageSize: 50, totalNum: 1, items: [
      { id: "STOP_SL_1", symbol: "XBTUSDTM", side: "sell", stop: "down", stopPrice: "61606.7", reduceOnly: true },
      { id: "STOP_NONRO", symbol: "XBTUSDTM", side: "sell", stop: "down", stopPrice: "60000", reduceOnly: false },
    ] });
  }
  if (init.method === "DELETE" && u.match(/\/api\/v1\/orders\/[^/?]+$/)) {
    exchangeCalls.push({ url: u, method: "DELETE" });
    return ok({ cancelledOrderIds: [u.split("/").pop()] });
  }
  if (u.includes("/api/v1/st-orders") || u.match(/\/api\/v1\/orders$/)) {
    exchangeCalls.push({ url: u, body: JSON.parse(init.body) });
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

const rejected = (r) => JSON.stringify(r.body).includes("restricted to risk reduction");

// T1: pm_ addOrder WITHOUT reduceOnly/closeOrder -> rejected, nothing sent to KuCoin
exchangeCalls.length = 0;
let r = await call("addOrder", {
  clientOid: "pm_XBTUSDTM_close_1781280900", symbol: "XBTUSDTM", side: "sell", type: "market",
  size: 1, marginMode: "ISOLATED", positionSide: "BOTH", leverage: 2,
});
check("T1 pm_ Entry abgelehnt", rejected(r), r.body);
check("T1 kein Exchange-Call", exchangeCalls.length === 0, exchangeCalls);

// T2: pm_ addOrder with reduceOnly:false (explicit) -> still rejected
exchangeCalls.length = 0;
r = await call("addOrder", {
  clientOid: "pm_XBTUSDTM_close_1781280900", symbol: "XBTUSDTM", side: "sell", type: "market",
  size: 1, marginMode: "ISOLATED", positionSide: "BOTH", leverage: 2, reduceOnly: false,
});
check("T2 pm_ mit reduceOnly:false abgelehnt", rejected(r), r.body);
check("T2 kein Exchange-Call", exchangeCalls.length === 0, exchangeCalls);

// T3: pm_ addOrder with reduceOnly:true -> passes through to KuCoin
exchangeCalls.length = 0;
r = await call("addOrder", {
  clientOid: "pm_XBTUSDTM_close_1781280900", symbol: "XBTUSDTM", side: "sell", type: "market",
  size: 1, marginMode: "ISOLATED", positionSide: "BOTH", leverage: 2, reduceOnly: true,
});
check("T3 pm_ reduceOnly:true akzeptiert", r.body?.data?.orderId === "TEST_ORDER_ID", r.body);
check("T3 Exchange-Call erfolgt", exchangeCalls.length === 1, exchangeCalls);

// T4: pm_ addStopOrder with closeOrder:true -> passes (typical protective stop)
exchangeCalls.length = 0;
r = await call("addStopOrder", {
  clientOid: "pm_XBTUSDTM_sl_1781280900", symbol: "XBTUSDTM", side: "sell", type: "market",
  closeOrder: true, leverage: 2, stopPriceType: "MP", triggerStopDownPrice: "61606.7",
});
check("T4 pm_ closeOrder:true akzeptiert", r.body?.data?.orderId === "TEST_ORDER_ID", r.body);
check("T4 Exchange-Call erfolgt", exchangeCalls.length === 1, exchangeCalls);

// T5: pm_ addStopOrder with string "true" (n8n serialization) -> passes
exchangeCalls.length = 0;
r = await call("addStopOrder", {
  clientOid: "pm_XBTUSDTM_sl_1781280900", symbol: "XBTUSDTM", side: "sell", type: "market",
  reduceOnly: "true", size: 1, leverage: 2, stopPriceType: "MP", triggerStopDownPrice: "61606.7",
});
check("T5 pm_ reduceOnly:'true' (String) akzeptiert", r.body?.data?.orderId === "TEST_ORDER_ID", r.body);

// T6: non-pm order without reduceOnly is untouched by the new rule
exchangeCalls.length = 0;
r = await call("addOrder", {
  clientOid: "manual_test_123", symbol: "XBTUSDTM", side: "sell", type: "market",
  size: 1, marginMode: "ISOLATED", positionSide: "BOTH", leverage: 2,
});
check("T6 non-pm Order unbeeinflusst", r.body?.data?.orderId === "TEST_ORDER_ID", r.body);

// T7: getStopOrders without args -> hits /api/v1/stopOrders with defaults
exchangeCalls.length = 0;
r = await call("getStopOrders", {});
check("T7 getStopOrders liefert Items", r.body?.data?.items?.length === 2, r.body);
check("T7 Default-Pagination", exchangeCalls[0]?.url.includes("pageSize=50") && exchangeCalls[0]?.url.includes("currentPage=1"), exchangeCalls);

// T8: getStopOrders with symbol+side -> params forwarded
exchangeCalls.length = 0;
r = await call("getStopOrders", { symbol: "XBTUSDTM", side: "sell", pageSize: 10, currentPage: 2 });
const u8 = exchangeCalls[0]?.url || "";
check("T8 Filter-Params weitergereicht", u8.includes("symbol=XBTUSDTM") && u8.includes("side=sell") && u8.includes("pageSize=10") && u8.includes("currentPage=2"), u8);

// T9: cancelStopOrder for a real untriggered reduceOnly stop -> verifies via
// /stopOrders, then DELETEs /api/v1/orders/{id}
exchangeCalls.length = 0;
r = await call("cancelStopOrder", { orderId: "STOP_SL_1" });
check("T9 cancelStopOrder akzeptiert gültigen Stop", JSON.stringify(r.body).includes("cancelledOrderIds"), r.body);
check("T9 GET stopOrders zur Verifikation", exchangeCalls.some(c => c.url.includes("/api/v1/stopOrders")), exchangeCalls);
check("T9 DELETE /orders/{id} ausgeführt", exchangeCalls.some(c => c.method === "DELETE" && c.url.endsWith("/api/v1/orders/STOP_SL_1")), exchangeCalls);

// T10: cancelStopOrder for an orderId that is NOT an untriggered stop -> refused, no DELETE
exchangeCalls.length = 0;
r = await call("cancelStopOrder", { orderId: "NOT_A_STOP" });
check("T10 unbekannte orderId abgelehnt", JSON.stringify(r.body).includes("not an untriggered stop order"), r.body);
check("T10 kein DELETE-Call", !exchangeCalls.some(c => c.method === "DELETE"), exchangeCalls);

// T11: cancelStopOrder for a non-reduceOnly stop -> refused, no DELETE
exchangeCalls.length = 0;
r = await call("cancelStopOrder", { orderId: "STOP_NONRO" });
check("T11 non-reduceOnly Stop abgelehnt", JSON.stringify(r.body).includes("not reduceOnly"), r.body);
check("T11 kein DELETE-Call", !exchangeCalls.some(c => c.method === "DELETE"), exchangeCalls);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
