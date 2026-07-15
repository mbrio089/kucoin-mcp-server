import { z } from "zod";

// Environment variables interface for Vercel
interface Env {
  KUCOIN_API_KEY: string;
  KUCOIN_API_SECRET: string;
  KUCOIN_API_PASSPHRASE: string;
  MCP_AUTH_KEY?: string;
  MCP_AUTH_KEYS?: string; // Comma-separated list of keys for multiple teams
}

// Verbose logging (request lines, payloads, normalization) is opt-in via
// MCP_DEBUG=true so that trading details don't land in production logs.
// Errors are always logged via console.error regardless of this flag.
const DEBUG = process.env.MCP_DEBUG === 'true';
function debugLog(...args: any[]): void {
  if (DEBUG) console.log(...args);
}

// KuCoin Futures API client adapted for Vercel Edge Runtime
class KuCoinFuturesClient {
  private apiKey: string;
  private apiSecret: string;
  private apiPassphrase: string;
  private baseUrl: string = "https://api-futures.kucoin.com";
  // Upstream request timeout. Edge functions have a hard wall-clock limit, so
  // never let a hung KuCoin request block until the platform kills us.
  private timeoutMs: number = 15000;

  constructor(apiKey: string, apiSecret: string, apiPassphrase: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.apiPassphrase = apiPassphrase;
  }

  /**
   * Generate HMAC SHA256 signature for KuCoin API
   */
  private async generateSignature(timestamp: string, method: string, endpoint: string, body: string = ""): Promise<string> {
    const stringToSign = timestamp + method.toUpperCase() + endpoint + body;
    
    // Convert secret to key for HMAC
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    
    // Generate signature
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(stringToSign)
    );
    
    // Convert to base64
    return btoa(String.fromCharCode(...Array.from(new Uint8Array(signature))));
  }

  /**
   * Generate encrypted passphrase for KuCoin API v2
   */
  private async generatePassphrase(): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    
    const encryptedPassphrase = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(this.apiPassphrase)
    );
    
    return btoa(String.fromCharCode(...Array.from(new Uint8Array(encryptedPassphrase))));
  }

  /**
   * Make authenticated request to KuCoin Futures API from European edge
   */
  private async makeRequest(
    method: string,
    endpoint: string,
    body?: any
  ): Promise<any> {
    const timestamp = Date.now().toString();
    const requestBody = body ? JSON.stringify(body) : "";
    
    const signature = await this.generateSignature(timestamp, method, endpoint, requestBody);
    const encryptedPassphrase = await this.generatePassphrase();
    
    const headers: Record<string, string> = {
      "KC-API-KEY": this.apiKey,
      "KC-API-SIGN": signature,
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": encryptedPassphrase,
      "KC-API-KEY-VERSION": "2",
      "Content-Type": "application/json"
    };

    debugLog(`Making KuCoin API request from Vercel EU edge: ${method} ${endpoint}`);
    if (requestBody) {
      debugLog(`Request body:`, requestBody);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: method.toUpperCase(),
        headers,
        body: requestBody || undefined,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        console.error(`KuCoin API request timed out after ${this.timeoutMs}ms: ${method} ${endpoint}`);
        throw new Error(`KuCoin API request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    }

    debugLog(`Response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`KuCoin API Error - Status: ${response.status}, Response:`, errorText);
      throw new Error(`KuCoin API Error: ${response.status} - ${errorText}`);
    }

    return await response.json();
  }

  // Market Data Methods
  async getSymbols(): Promise<any> {
    return this.makeRequest("GET", "/api/v1/contracts/active");
  }

  async getTicker(symbol?: string): Promise<any> {
    // KuCoin Futures /ticker requires a symbol (400100 otherwise); use /allTickers for all.
    const endpoint = symbol ? `/api/v1/ticker?symbol=${symbol}` : "/api/v1/allTickers";
    return this.makeRequest("GET", endpoint);
  }

  async getOrderBook(symbol: string, depth: number = 20): Promise<any> {
    // Use part-orderbook endpoint (depth20 or depth100)
    const depthSize = depth <= 20 ? 20 : 100;
    return this.makeRequest("GET", `/api/v1/level2/depth${depthSize}?symbol=${symbol}`);
  }

  async getKlines(symbol: string, granularity: number, from?: number, to?: number): Promise<any> {
    let endpoint = `/api/v1/kline/query?symbol=${symbol}&granularity=${granularity}`;
    if (from) endpoint += `&from=${from}`;
    if (to) endpoint += `&to=${to}`;
    return this.makeRequest("GET", endpoint);
  }

  async getSymbolDetail(symbol: string): Promise<any> {
    return this.makeRequest("GET", `/api/v1/contracts/${symbol}`);
  }

  /**
   * Idempotency key for order placement. When the caller supplies no clientOid we
   * derive a deterministic one from the order parameters plus a short time bucket.
   * A retried identical order within the window reuses the same clientOid, so
   * KuCoin rejects the duplicate instead of opening a second position; distinct
   * orders (or the same order after the window) still get unique ids. Callers that
   * need exact control should always pass their own clientOid.
   */
  private async deriveClientOid(params: any): Promise<string> {
    const windowMs = 120000; // 2-minute idempotency window
    const bucket = Math.floor(Date.now() / windowMs);
    const canonical = JSON.stringify([
      params.symbol, params.side, params.type, params.size, params.qty,
      params.valueQty, params.price, params.leverage, params.marginMode,
      params.positionSide, params.reduceOnly, params.closeOrder,
      params.triggerStopUpPrice, params.triggerStopDownPrice, params.stopPriceType,
      bucket,
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
    return `auto_${hex.slice(0, 32)}`;
  }

  // Order Management Methods
  async addOrder(orderParams: any): Promise<any> {
    if (!orderParams.clientOid) {
      orderParams.clientOid = await this.deriveClientOid(orderParams);
    }
    return this.makeRequest("POST", "/api/v1/orders", orderParams);
  }

  async cancelOrder(orderId: string): Promise<any> {
    return this.makeRequest("DELETE", `/api/v1/orders/${orderId}`);
  }

  // Cancel a single untriggered stop order by its system orderId.
  // KuCoin Futures cancels an order (including an untriggered stop) via
  // DELETE /api/v1/orders/{orderId}; there is no per-id stop-only endpoint
  // (only DELETE /api/v1/stopOrders cancels ALL stops, which would also drop
  // the take-profit). To make this safe for the autonomous position manager,
  // we first confirm the orderId really is an untriggered, risk-reducing stop
  // (present in /stopOrders and not explicitly non-reduceOnly) and otherwise
  // refuse — the manager can never cancel an entry order or a wrong order type.
  async cancelStopOrder(orderId: string): Promise<any> {
    if (!orderId || typeof orderId !== "string") {
      throw new Error("cancelStopOrder: orderId is required");
    }
    const stopList = await this.getStopOrders(undefined, undefined, 200, 1);
    const items = (stopList && stopList.data && stopList.data.items) || [];
    const match = items.find((s: any) => String(s.id) === String(orderId));
    if (!match) {
      throw new Error(
        `cancelStopOrder: orderId ${orderId} is not an untriggered stop order ` +
        `(not found in /stopOrders). Refusing to cancel.`
      );
    }
    if (match.reduceOnly === false || match.reduceOnly === "false") {
      throw new Error(
        `cancelStopOrder: stop order ${orderId} is not reduceOnly. ` +
        `Refusing to cancel a non-protective stop.`
      );
    }
    return this.makeRequest("DELETE", `/api/v1/orders/${orderId}`);
  }

  async cancelAllOrders(symbol?: string): Promise<any> {
    const endpoint = symbol ? `/api/v1/orders?symbol=${symbol}` : "/api/v1/orders";
    return this.makeRequest("DELETE", endpoint);
  }

  async getOrders(symbol?: string, status?: string, side?: string, pageSize: number = 20): Promise<any> {
    let endpoint = "/api/v1/orders";
    const params = new URLSearchParams();
    
    if (symbol) params.append("symbol", symbol);
    if (status) params.append("status", status);
    if (side) params.append("side", side);
    params.append("pageSize", pageSize.toString());
    
    if (params.toString()) endpoint += `?${params.toString()}`;
    return this.makeRequest("GET", endpoint);
  }

  async getOrderById(orderId: string): Promise<any> {
    return this.makeRequest("GET", `/api/v1/orders/${orderId}`);
  }

  // Position Management Methods
  async getPositions(): Promise<any> {
    return this.makeRequest("GET", "/api/v1/positions");
  }

  async getPosition(symbol: string): Promise<any> {
    return this.makeRequest("GET", `/api/v1/position?symbol=${symbol}`);
  }

  async modifyMargin(symbol: string, margin: number): Promise<any> {
    return this.makeRequest("POST", "/api/v1/position/margin/deposit-margin", {
      symbol,
      margin: margin.toString(),
    });
  }

  // Funding Rate Methods
  async getFundingRate(symbol: string): Promise<any> {
    return this.makeRequest("GET", `/api/v1/funding-rate/${symbol}/current`);
  }

  async getFundingHistory(symbol: string, from?: number, to?: number): Promise<any> {
    let endpoint = `/api/v1/contract/funding-fees?symbol=${symbol}`;
    if (from) endpoint += `&from=${from}`;
    if (to) endpoint += `&to=${to}`;
    return this.makeRequest("GET", endpoint);
  }

  async getAccountFutures(currency: string = "USDT"): Promise<any> {
    // Only request single currency to reduce API calls and resource usage
    const endpoint = `/api/v1/account-overview?currency=${currency}`;
    return this.makeRequest("GET", endpoint);
  }

  // Advanced Order Management - Take Profit and Stop Loss
  async addStopOrder(orderParams: any): Promise<any> {
    try {
      // Auto-generate a deterministic idempotency clientOid if not provided
      if (!orderParams.clientOid) {
        orderParams.clientOid = await this.deriveClientOid(orderParams);
      }
      
      // Add debug logging for troubleshooting
      debugLog(`addStopOrder called with params:`, JSON.stringify(orderParams));

      // Let KuCoin API handle all validation - it provides proper error messages
      const result = await this.makeRequest("POST", "/api/v1/st-orders", orderParams);
      debugLog(`addStopOrder successful:`, JSON.stringify(result));
      return result;
    } catch (error) {
      console.error(`addStopOrder failed:`, error);
      throw error;
    }
  }

  async getOpenOrders(symbol: string): Promise<any> {
    return this.makeRequest("GET", `/api/v1/openOrderStatistics?symbol=${symbol}`);
  }

  async getStopOrders(symbol?: string, side?: string, pageSize: number = 50, currentPage: number = 1): Promise<any> {
    const params = new URLSearchParams();
    if (symbol) params.append("symbol", symbol);
    if (side) params.append("side", side);
    params.append("pageSize", pageSize.toString());
    params.append("currentPage", currentPage.toString());
    return this.makeRequest("GET", `/api/v1/stopOrders?${params.toString()}`);
  }

  async getPositionsHistory(symbol?: string, from?: number, to?: number, limit: number = 10, pageId: number = 1): Promise<any> {
    let endpoint = "/api/v1/history-positions";
    const params = new URLSearchParams();
    
    if (symbol) params.append("symbol", symbol);
    if (from) params.append("from", from.toString());
    if (to) params.append("to", to.toString());
    params.append("limit", Math.min(limit, 200).toString()); // Max 200 per API docs
    params.append("pageId", pageId.toString());
    
    if (params.toString()) endpoint += `?${params.toString()}`;
    return this.makeRequest("GET", endpoint);
  }

  async getFills(
    orderId?: string,
    symbol?: string,
    tradeTypes?: string,
    side?: string,
    type?: string,
    startAt?: number,
    endAt?: number,
    currentPage: number = 1,
    pageSize: number = 50
  ): Promise<any> {
    let endpoint = "/api/v1/fills";
    const params = new URLSearchParams();
    
    if (orderId) params.append("orderId", orderId);
    if (symbol) params.append("symbol", symbol);
    if (tradeTypes) params.append("tradeTypes", tradeTypes);
    if (side) params.append("side", side);
    if (type) params.append("type", type);
    if (startAt) params.append("startAt", startAt.toString());
    if (endAt) params.append("endAt", endAt.toString());
    params.append("currentPage", currentPage.toString());
    params.append("pageSize", Math.min(pageSize, 1000).toString()); // Max 1000 per API docs
    
    if (params.toString()) endpoint += `?${params.toString()}`;
    return this.makeRequest("GET", endpoint);
  }
}

// MCP Tools definitions - All 20 KuCoin Futures tools
const allTools = [
  // Market Data Tools
  {
    name: "getSymbols",
    description: "Get all available futures trading symbols/contracts",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "getTicker",
    description: "Get ticker information for a specific symbol or all symbols",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM)"
        }
      }
    }
  },
  {
    name: "getOrderBook",
    description: "Get part orderbook depth data (aggregated by price) for a specific symbol. Uses the optimized part-orderbook endpoint for faster response and less traffic consumption.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM)"
        },
        depth: {
          type: "number",
          description: "Order book depth: 20 returns the depth20 snapshot, 100 returns the depth100 snapshot.",
          enum: [20, 100],
          default: 20
        }
      },
      required: ["symbol"]
    }
  },
  {
    name: "getKlines",
    description: "Get klines/candlestick data for a specific symbol",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM)"
        },
        granularity: {
          type: "number",
          description: "Time granularity in minutes (1, 5, 15, 30, 60, 120, 240, 480, 720, 1440, 10080)"
        },
        from: {
          type: "number",
          description: "Start timestamp (Unix timestamp)"
        },
        to: {
          type: "number",
          description: "End timestamp (Unix timestamp)"
        }
      },
      required: ["symbol", "granularity"]
    }
  },
  {
    name: "getSymbolDetail",
    description: "Get detailed contract specifications and trading parameters for a specific futures symbol. This provides comprehensive information about a trading contract including lot size, tick size, max order quantity, fee rates, pricing information, and trading status. Essential for understanding trading rules and constraints before placing orders.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM)"
        }
      },
      required: ["symbol"]
    }
  },
  {
    name: "calculatePositionSize",
    description: "Compute the order size (in lots) for a given risk budget, server-side and deterministically: size = floor(equity * riskPercentage% * leverage / (price * multiplier)), respecting the contract's lotSize granularity and maxOrderQty. Uses live account equity and contract specs. The same computation is applied automatically when addOrder/addStopOrder receive a riskPercentage, so calling this tool is optional (preview/transparency).",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Futures contract symbol (e.g., XBTUSDTM)"
        },
        riskPercentage: {
          type: "number",
          description: "Percent of account equity (0-100] to allocate as margin for this position",
          exclusiveMinimum: 0,
          maximum: 100
        },
        leverage: {
          type: "number",
          description: "Position leverage multiplier (default 1)",
          minimum: 1
        },
        entryPrice: {
          type: "string",
          description: "Intended entry price (tick-quantized). Falls back to the current ticker price when omitted."
        },
        currency: {
          type: "string",
          description: "Settlement currency for the equity lookup (default USDT)"
        }
      },
      required: ["symbol", "riskPercentage"]
    }
  },
  // Order Management Tools
  {
    name: "addOrder",
    description: "Place a new futures order (limit or market). REQUIRED: symbol, side, type, marginMode, positionSide, and either riskPercentage (preferred — server computes size) or size. For limit orders, price is also required. Leverage is required when opening new positions or using ISOLATED margin mode. This is the primary tool for entering and exiting futures positions. NOTE: entry orders with a clientOid starting with 'ta_' MUST provide riskPercentage; their size is always computed server-side. Orders with a clientOid starting with 'pm_' (position manager) MUST set reduceOnly or closeOrder — they can only reduce risk.",
    inputSchema: {
      type: "object",
      properties: {
        clientOid: {
          type: "string",
          description: "Unique client order identifier (max 40 chars: numbers, letters, underscore, separator). Auto-generated if not provided.",
          maxLength: 40,
          pattern: "^[a-zA-Z0-9_-]+$"
        },
        symbol: {
          type: "string",
          description: "Futures contract symbol (e.g., XBTUSDTM, ETHUSDTM). Must be a valid active futures trading pair. Use getSymbols tool to see all available contracts."
        },
        side: {
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side: 'buy' to go long or close short position, 'sell' to go short or close long position"
        },
        type: {
          type: "string",
          enum: ["limit", "market"],
          description: "Order type: 'limit' for specific price execution (requires price parameter), 'market' for immediate execution at best available price"
        },
        size: {
          type: "number",
          description: "Order quantity in contracts/lots. Must be a positive integer. Each contract's lot size varies by symbol (use getSymbolDetail to check multiplier and lot size). Ignored when riskPercentage is provided (server-side sizing takes precedence).",
          minimum: 1
        },
        riskPercentage: {
          type: "number",
          description: "PREFERRED sizing input: percent of account equity (0-100] to allocate as margin for this order. The server computes size = floor(equity * riskPercentage% * leverage / (price * multiplier)) and overrides any provided size. REQUIRED for entry orders whose clientOid starts with 'ta_'. Not forwarded to the exchange.",
          exclusiveMinimum: 0,
          maximum: 100
        },
        price: {
          type: "string",
          description: "Limit price for order execution. REQUIRED when type='limit'. Use string format to preserve precision (e.g., '65000.5'). Must comply with symbol's tick size."
        },
        leverage: {
          type: "integer",
          description: "Position leverage multiplier (e.g., 5, 10, 20). REQUIRED when: (1) Opening a new position, (2) Using ISOLATED margin mode, (3) First order for a symbol. Must be between symbol's min/max leverage range. Integer only, no decimals.",
          minimum: 1
        },
        marginMode: {
          type: "string",
          enum: ["ISOLATED", "CROSS"],
          description: "REQUIRED. Margin mode for the position: 'ISOLATED' - risk limited to position margin only, allows custom leverage per position. 'CROSS' - uses entire account margin, shares risk across all positions."
        },
        positionSide: {
          type: "string",
          enum: ["BOTH", "LONG", "SHORT"],
          description: "REQUIRED. Position direction: 'BOTH' - one-way position mode (default, most common), 'LONG' - long side in hedge mode, 'SHORT' - short side in hedge mode. Use 'BOTH' unless you've enabled hedge mode on your account."
        },
        timeInForce: {
          type: "string",
          enum: ["GTC", "IOC", "FOK"],
          description: "Time in force for limit orders: 'GTC' (Good Till Canceled) - default, remains active until filled or canceled, 'IOC' (Immediate or Cancel) - fill immediately or cancel unfilled portion, 'FOK' (Fill or Kill) - fill entire order immediately or cancel completely",
          default: "GTC"
        },
        reduceOnly: {
          type: "boolean",
          description: "If true, order will only reduce existing position size and cannot increase it. Useful for closing positions without risk of opening opposite position. Extra size beyond position will be canceled.",
          default: false
        },
        postOnly: {
          type: "boolean",
          description: "If true, order will only be posted as a maker order (pays maker fee, receives rebate on some exchanges). Order will be canceled if it would execute immediately as a taker. Cannot be used with IOC or FOK.",
          default: false
        },
        hidden: {
          type: "boolean",
          description: "If true, order is hidden from the public order book. Hidden orders are not visible to other traders. Cannot be used with postOnly.",
          default: false
        },
        iceberg: {
          type: "boolean",
          description: "If true, only a portion of the order is visible in the order book (requires visibleSize parameter). Reduces market impact for large orders. Cannot be used with postOnly.",
          default: false
        },
        visibleSize: {
          type: "number",
          description: "For iceberg orders only: the maximum visible quantity in the order book. Must be less than total size. Required when iceberg=true."
        },
        remark: {
          type: "string",
          description: "Optional order note/comment for tracking purposes (max 100 characters). Useful for tagging orders by strategy or purpose.",
          maxLength: 100
        }
      },
      required: ["symbol", "side", "type", "marginMode", "positionSide"]
    }
  },
  {
    name: "cancelOrder",
    description: "Cancel a specific order by ID",
    inputSchema: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "Order ID to cancel"
        }
      },
      required: ["orderId"]
    }
  },
  {
    name: "cancelStopOrder",
    description: "Cancel a single untriggered stop order by its system orderId (e.g. to move a stop-loss). Safety-checked: the server first confirms the orderId is an untriggered, risk-reducing stop in /stopOrders and refuses otherwise, so it can never cancel an entry or wrong order. Use the 'id' field from getStopOrders.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "System orderId of the untriggered stop order to cancel (the 'id' field from getStopOrders)"
        }
      },
      required: ["orderId"]
    }
  },
  {
    name: "cancelAllOrders",
    description: "Cancel all orders or all orders for a specific symbol",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (optional - cancel all orders for this symbol)"
        }
      }
    }
  },
  {
    name: "getOrders",
    description: "Get list of orders with optional filtering",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol"
        },
        status: {
          type: "string",
          enum: ["active", "done"],
          description: "Order status filter"
        },
        side: {
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side filter"
        },
        pageSize: {
          type: "number",
          description: "Number of orders to return",
          default: 20,
          minimum: 1,
          maximum: 100
        }
      }
    }
  },
  {
    name: "getOrderById",
    description: "Get detailed information about a specific order",
    inputSchema: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "Order ID to fetch"
        }
      },
      required: ["orderId"]
    }
  },
  // Position Management Tools
  {
    name: "getPositions",
    description: "Get all open positions",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "getPosition",
    description: "Get position details for a specific symbol",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM)"
        }
      },
      required: ["symbol"]
    }
  },
  {
    name: "modifyMargin",
    description: "Add or remove margin for a position",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM)"
        },
        margin: {
          type: "number",
          description: "Margin amount to add/remove"
        }
      },
      required: ["symbol", "margin"]
    }
  },
  // Funding Rate Tools
  {
    name: "getFundingRate",
    description: "Get current funding rate for a symbol",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM)"
        }
      },
      required: ["symbol"]
    }
  },
  {
    name: "getFundingHistory",
    description: "Get funding rate history for a symbol",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM)"
        },
        from: {
          type: "number",
          description: "Start timestamp (Unix timestamp)"
        },
        to: {
          type: "number",
          description: "End timestamp (Unix timestamp)"
        }
      },
      required: ["symbol"]
    }
  },
  // Account Information Tools
  {
    name: "getAccountFutures",
    description: "Get futures account overview including balance, equity, PNL, and risk information for a specific currency (defaults to USDT)",
    inputSchema: {
      type: "object",
      properties: {
        currency: {
          type: "string",
          description: "Account currency (defaults to USDT if not specified)",
          enum: ["USDT", "USDC", "XBT", "ETH"],
          default: "USDT"
        }
      },
      required: ["currency"]
    }
  },
  // Advanced Order Management Tools
  {
    name: "addStopOrder",
    description: "Place a take profit and/or stop loss order. REQUIRED: symbol, side, leverage (integer), stopPriceType ('MP' recommended), at least one trigger price, and exactly one quantity (riskPercentage preferred — server computes size — or size/qty/valueQty). For limit orders, also provide 'price'. This advanced order type automatically executes when price reaches specified trigger levels, providing risk management and profit-taking capabilities. NOTE: entry orders with a clientOid starting with 'ta_' MUST provide riskPercentage; their size is always computed server-side. Orders with a clientOid starting with 'pm_' (position manager) MUST set reduceOnly or closeOrder — they can only reduce risk.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        clientOid: {
          type: "string",
          description: "Unique client order ID (max 40 chars: numbers, letters, underscore, separator). Required - use crypto.randomUUID() if needed.",
          maxLength: 40,
          pattern: "^[a-zA-Z0-9_-]+$"
        },
        symbol: {
          type: "string",
          description: "Futures contract symbol (e.g., XBTUSDTM, ETHUSDTM). Must be a valid futures trading pair."
        },
        side: {
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side: 'buy' for long positions, 'sell' for short positions"
        },
        leverage: {
          type: "integer",
          minimum: 1,
          description: "Leverage multiplier. Optional for ISOLATED margin mode orders. Required if closing position or CROSS margin."
        },
        type: {
          type: "string",
          enum: ["limit", "market"],
          description: "Order execution type: 'limit' for specific price execution, 'market' for immediate execution at best price",
          default: "limit"
        },
        remark: {
          type: "string",
          maxLength: 100,
          description: "Optional order note/comment for tracking purposes (max 100 characters)"
        },
        triggerStopUpPrice: {
          type: "string",
          description: "TAKE PROFIT trigger price. Order executes when price rises to this level. Use for profit-taking."
        },
        stopPriceType: {
          type: "string",
          enum: ["TP", "MP", "IP"],
          description: "Price reference for triggers: TP=Trade Price (last), MP=Mark Price (recommended), IP=Index Price"
        },
        triggerStopDownPrice: {
          type: "string",
          description: "STOP LOSS trigger price. Order executes when price falls to this level. Use for loss prevention."
        },
        reduceOnly: {
          type: "boolean",
          description: "If true, only reduces existing position size. Extra size will be canceled if it exceeds position size.",
          default: false
        },
        closeOrder: {
          type: "boolean",
          description: "If true, closes entire position when triggered. Side, Size and Leverage can be left empty.",
          default: false
        },
        forceHold: {
          type: "boolean",
          description: "Force hold funds for the order even if it reduces position size. Prevents cancellation when position changes.",
          default: false
        },
        stp: {
          type: "string",
          enum: ["CN", "CO", "CB"],
          description: "Self-Trade Prevention: CN=Cancel Newest, CO=Cancel Oldest, CB=Cancel Both"
        },
        marginMode: {
          type: "string",
          enum: ["ISOLATED", "CROSS"],
          description: "Margin mode: ISOLATED allows custom leverage, CROSS uses account-wide margin",
          default: "ISOLATED"
        },
        price: {
          type: "string",
          description: "Limit price for execution (required when type=limit). Use string to preserve precision."
        },
        size: {
          type: "integer",
          minimum: 1,
          description: "Order size in LOTS (whole number). Choose exactly ONE of: size, qty, or valueQty. Ignored when riskPercentage is provided (server-side sizing takes precedence)."
        },
        riskPercentage: {
          type: "number",
          description: "PREFERRED sizing input: percent of account equity (0-100] to allocate as margin for this order. The server computes size = floor(equity * riskPercentage% * leverage / (price * multiplier)) and overrides any provided size/qty/valueQty. REQUIRED for entry orders whose clientOid starts with 'ta_'. Not forwarded to the exchange.",
          exclusiveMinimum: 0,
          maximum: 100
        },
        qty: {
          type: "string",
          description: "Order size in base currency (e.g. BTC). Must be integer multiple of multiplier. Choose exactly ONE of: size, qty, or valueQty."
        },
        valueQty: {
          type: "string",
          description: "Order size in quote currency value (USDT/USDC). For USDS-Swap contracts only. Choose exactly ONE of: size, qty, or valueQty."
        },
        timeInForce: {
          type: "string",
          enum: ["GTC", "IOC"],
          description: "Time in force: GTC=Good Till Canceled, IOC=Immediate or Cancel (for limit orders)",
          default: "GTC"
        },
        postOnly: {
          type: "boolean",
          description: "Maker-only flag ensures order pays maker fee. Cannot be used with hidden/iceberg or when timeInForce=IOC.",
          default: false
        },
        hidden: {
          type: "boolean",
          description: "Hide order from order book. Cannot be used with postOnly.",
          default: false
        },
        iceberg: {
          type: "boolean",
          description: "Show only partial order size in order book. Requires visibleSize. Cannot be used with postOnly.",
          default: false
        },
        visibleSize: {
          type: "string",
          description: "Maximum visible size for iceberg orders (in lots). Required when iceberg=true."
        },
        positionSide: {
          type: "string",
          enum: ["BOTH", "LONG", "SHORT"],
          description: "Position direction. Optional in one-way mode (defaults to BOTH). Required in hedge mode."
        }
      },
      required: ["clientOid", "symbol", "side", "leverage", "stopPriceType"]
    }
  },
  {
    name: "getOpenOrders",
    description: "Get open order statistics for a symbol",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM)"
        }
      },
      required: ["symbol"]
    }
  },
  {
    name: "getStopOrders",
    description: "Get the list of untriggered stop orders (resting stop-loss/take-profit orders placed via addStopOrder). These live on a separate KuCoin endpoint and do NOT appear in getOrders/getOpenOrders. Essential for verifying that an open position is actually protected by a stop order on the exchange.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM). Optional - if not provided, returns stop orders for all symbols"
        },
        side: {
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side filter"
        },
        pageSize: {
          type: "number",
          description: "Number of results per page (default 50)",
          minimum: 1,
          maximum: 200,
          default: 50
        },
        currentPage: {
          type: "number",
          description: "Page number for pagination (default 1)",
          minimum: 1,
          default: 1
        }
      }
    }
  },
  {
    name: "getPositionsHistory",
    description: "Get historical positions data sorted by close time (descending). Provides comprehensive position history including PNL, fees, open/close times, and leverage details for futures trading analysis.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM). Optional - if not provided, returns history for all symbols"
        },
        from: {
          type: "number",
          description: "Start timestamp for position closing time in milliseconds (Unix timestamp)"
        },
        to: {
          type: "number", 
          description: "End timestamp for position closing time in milliseconds (Unix timestamp)"
        },
        limit: {
          type: "number",
          description: "Number of results per page (max 200, default 10)",
          minimum: 1,
          maximum: 200,
          default: 10
        },
        pageId: {
          type: "number",
          description: "Page number for pagination (default 1)",
          minimum: 1,
          default: 1
        }
      }
    }
  },
  {
    name: "getFills",
    description: "Get filled/executed trades list with comprehensive trade execution details including price, size, fees, and liquidity info. Data available for up to one week. Essential for trade analysis and performance tracking.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "Specific order ID to get fills for (optional - returns fills for specific order)"
        },
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM). Optional - if not provided, returns fills for all symbols"
        },
        tradeTypes: {
          type: "string",
          description: "Transaction types: trade, adl, liquid, settlement (comma-separated for multiple types)"
        },
        side: {
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side filter: buy or sell"
        },
        type: {
          type: "string",
          description: "Order type filter (e.g., limit, market)"
        },
        startAt: {
          type: "number",
          description: "Start timestamp in milliseconds (Unix timestamp)"
        },
        endAt: {
          type: "number", 
          description: "End timestamp in milliseconds (Unix timestamp)"
        },
        currentPage: {
          type: "number",
          description: "Page number for pagination (default 1)",
          minimum: 1,
          default: 1
        },
        pageSize: {
          type: "number",
          description: "Number of results per page (default 50, max 1000)",
          minimum: 1,
          maximum: 1000,
          default: 50
        }
      }
    }
  }
];

// Optimized HTTP Streamable Transport Handler for n8n MCP nodes
async function handleStreamableTransport(request: Request, env: Env): Promise<Response> {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, X-MCP-Auth-Key, Authorization',
    'Mcp-Session-Id': crypto.randomUUID()
  };

  // Note: Authentication is already handled in main handler before this function is called

  // Handle POST requests (standard MCP operations)
  if (request.method === 'POST') {
    try {
      const body = await request.json() as any;
      
      if (body.method === 'initialize') {
        const initResponse = {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
            serverInfo: {
              name: "KuCoin Futures API MCP Server (Vercel EU Streamable)",
              version: "1.0.0"
            }
          }
        };
        return new Response(JSON.stringify(initResponse), {
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
        
      } else if (body.method === 'tools/list') {
        const toolsResponse = {
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: allTools }
        };
        return new Response(JSON.stringify(toolsResponse), {
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
        
      } else if (body.method === 'tools/call') {
        const client = new KuCoinFuturesClient(
          env.KUCOIN_API_KEY,
          env.KUCOIN_API_SECRET,
          env.KUCOIN_API_PASSPHRASE
        );
        
        try {
          const result = await executeToolCall(client, body.params.name, body.params.arguments);

          // Check for format query parameter
          const url = new URL(request.url);
          const format = url.searchParams.get('format');

          return formatToolCallSuccess(result, format, body.id, {
            ...headers,
            'Content-Type': 'application/json'
          });

        } catch (error: any) {
          const errorResponse = {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -1, message: error?.message || 'Unknown error' }
          };
          return new Response(JSON.stringify(errorResponse), {
            status: 500,
            headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }
        
      } else if (body.method === 'ping') {
        const pingResponse = {
          jsonrpc: "2.0",
          id: body.id,
          result: "pong"
        };
        return new Response(JSON.stringify(pingResponse), {
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
        
      } else if (body.method === 'notifications/initialized') {
        return new Response('', { status: 204, headers });
        
      } else if (body.method && body.method.startsWith('notifications/')) {
        return new Response('', { status: 204, headers });
      }
      
      // Unknown method
      const errorResponse = {
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Method not found: ${body.method}` }
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 404,
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      const errorResponse = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: 'Parse error' }
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }
  }
  
  // Handle GET requests (capability discovery)
  if (request.method === 'GET') {
    const capabilitiesResponse = {
      transport: "streamable-http",
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "KuCoin Futures API MCP Server (Vercel EU Streamable)",
        version: "1.0.0"
      },
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      endpoints: { mcp: "/stream", tools: "/stream" }
    };
    return new Response(JSON.stringify(capabilitiesResponse), {
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }
  
  return new Response('Method not allowed', { status: 405, headers });
}

// Helper function to normalize parameters from different n8n MCP node formats
function normalizeParameters(args: any): any {
  debugLog('Raw args received:', JSON.stringify(args));

  // Handle array wrapper from built-in n8n MCP node: [{ query: { value: { ...params } }, tool: {...} }]
  if (Array.isArray(args) && args.length > 0) {
    debugLog('Detected array wrapper from built-in n8n MCP node, extracting first element');
    args = args[0]; // Extract first element from array
  }

  // Handle built-in n8n MCP node format: { query: { value: { ...params } } }
  if (args && typeof args === 'object' && args.query && args.query.value) {
    debugLog('Detected built-in n8n MCP node format, extracting from query.value');
    return args.query.value;
  }

  // Handle direct value wrapper: { value: { ...params } } (when array detection fails)
  if (args && typeof args === 'object' && args.value && typeof args.value === 'object') {
    debugLog('Detected direct value wrapper, extracting from value');
    return args.value;
  }

  // Handle community n8n MCP node format: { Tool_Parameters: { ...params } }
  if (args && typeof args === 'object' && args.Tool_Parameters) {
    debugLog('Detected community n8n MCP node format, extracting from Tool_Parameters');
    return args.Tool_Parameters;
  }

  // Handle standard format (Claude Desktop, direct API calls): { ...params }
  debugLog('Using standard parameter format');
  return args;
}

// Constant-time string comparison to avoid leaking the auth key via timing.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Fold the length difference into the result and always walk the full
  // length so the comparison time does not depend on where the first byte
  // mismatches.
  let diff = aBytes.length ^ bBytes.length;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

// Authentication helper function
function authenticateRequest(request: Request, env: Env): { isAuthenticated: boolean; error?: string } {
  // Fail closed: if no auth keys are configured, deny all access.
  // This server can place/cancel real-money orders, so a missing or unset
  // MCP_AUTH_KEY must never silently expose it to the public internet.
  if (!env.MCP_AUTH_KEY && !env.MCP_AUTH_KEYS) {
    console.error('Authentication denied: no MCP_AUTH_KEY/MCP_AUTH_KEYS configured (server misconfiguration)');
    return {
      isAuthenticated: false,
      error: 'Server misconfiguration: no authentication key configured. Access denied.'
    };
  }

  // Get auth header - support both X-MCP-Auth-Key and Authorization Bearer
  const authHeader = request.headers.get('X-MCP-Auth-Key') || 
                    request.headers.get('Authorization')?.replace('Bearer ', '');

  if (!authHeader) {
    console.warn('Authentication failed: No auth header provided');
    return { 
      isAuthenticated: false, 
      error: 'Authentication required. Provide X-MCP-Auth-Key header or Authorization: Bearer <key>' 
    };
  }

  // Check against configured keys
  const validKeys = [];
  if (env.MCP_AUTH_KEY) validKeys.push(env.MCP_AUTH_KEY);
  if (env.MCP_AUTH_KEYS) validKeys.push(...env.MCP_AUTH_KEYS.split(',').map(k => k.trim()));

  const isValid = validKeys.some(key => timingSafeEqual(key, authHeader));
  
  if (isValid) {
    debugLog('Authentication successful');
    return { isAuthenticated: true };
  } else {
    console.warn('Authentication failed: Invalid auth key');
    return {
      isAuthenticated: false,
      error: 'Invalid authentication key'
    };
  }
}

// ---- Server-side validation for order-executing tools ----
// Mirrors the JSON Schema contract already exposed to clients, but enforced
// server-side so a malformed order is rejected before it reaches KuCoin with
// real funds. Validation only: on success the original (unmodified) arguments
// are forwarded, so the payload semantics are never altered. Numeric fields
// accept a number or a numeric string because different n8n nodes send either.
const sideEnum = z.enum(["buy", "sell"]);
const orderTypeEnum = z.enum(["limit", "market"]);
const marginModeEnum = z.enum(["ISOLATED", "CROSS"]);
const positionSideEnum = z.enum(["BOTH", "LONG", "SHORT"]);
const stopPriceTypeEnum = z.enum(["TP", "MP", "IP"]);
const numericLike = z.union([z.string().min(1), z.number()]);
const hasValue = (v: unknown) => v !== undefined && v !== null && String(v).length > 0;

// clientOid is intentionally optional here: it is auto-generated downstream
// when omitted, so requiring it would reject valid calls.
const addOrderSchema = z
  .object({
    symbol: z.string().min(1),
    side: sideEnum,
    type: orderTypeEnum,
    size: z.coerce.number().int().positive().optional(),
    riskPercentage: z.coerce.number().positive().max(100).optional(),
    marginMode: marginModeEnum,
    positionSide: positionSideEnum,
    price: numericLike.optional(),
    leverage: z.coerce.number().int().positive().optional(),
  })
  .passthrough()
  .refine((o) => o.type !== "limit" || hasValue(o.price), {
    message: "price is required when type is 'limit'",
  })
  .refine((o) => hasValue(o.size) || hasValue(o.riskPercentage) || o.closeOrder === true, {
    message: "either size or riskPercentage is required",
  });

// Deliberately lenient: with closeOrder=true, KuCoin allows side, size and
// leverage to be omitted (it just closes the whole position). To never block a
// valid risk-management order, only the fundamentals are hard-required here
// (symbol, at least one trigger price, price-when-limit); everything else is
// only sanity-checked when present.
const addStopOrderSchema = z
  .object({
    symbol: z.string().min(1),
    side: sideEnum.optional(),
    leverage: z.coerce.number().int().positive().optional(),
    stopPriceType: stopPriceTypeEnum.optional(),
    type: orderTypeEnum.optional(),
    price: numericLike.optional(),
    triggerStopUpPrice: numericLike.optional(),
    triggerStopDownPrice: numericLike.optional(),
    size: z.coerce.number().int().positive().optional(),
    riskPercentage: z.coerce.number().positive().max(100).optional(),
    qty: numericLike.optional(),
    valueQty: numericLike.optional(),
  })
  .passthrough()
  .refine((o) => hasValue(o.triggerStopUpPrice) || hasValue(o.triggerStopDownPrice), {
    message: "at least one of triggerStopUpPrice or triggerStopDownPrice is required",
  })
  .refine((o) => o.type !== "limit" || hasValue(o.price), {
    message: "price is required when type is 'limit'",
  });

function validateOrThrow(schema: z.ZodTypeAny, toolName: string, args: any): void {
  const result = schema.safeParse(args);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid arguments for ${toolName}: ${issues}`);
  }
}

// ---- Server-side position sizing ----
// Sizing is margin-based and matches the trader system's risk accounting:
// riskPercentage% of account equity is committed as margin, multiplied by
// leverage to get the notional budget, then converted to whole lots.
// Enforcing this on the server (instead of trusting the calling LLM agent)
// guarantees no order can reach KuCoin with an unvalidated size.
const TRADER_OID_PREFIX = /^ta_/;

// ---- Position-manager order constraints ----
// Orders from the autonomous position manager (clientOid 'pm_*') may only
// ever reduce risk: they must carry reduceOnly or closeOrder. Enforcing this
// on the server makes the manager structurally unable to open or increase
// exposure (same guarantee pattern as ta_* sizing). Accepts boolean true and
// the string "true" because n8n HTTP nodes may serialize booleans as strings.
const POSITION_MANAGER_OID_PREFIX = /^pm_/;
const isTrueish = (v: unknown) => v === true || v === "true";

function enforcePositionManagerReduceOnly(toolName: string, params: any): void {
  if (typeof params.clientOid !== "string" || !POSITION_MANAGER_OID_PREFIX.test(params.clientOid)) return;
  if (isTrueish(params.reduceOnly) || isTrueish(params.closeOrder)) return;
  throw new Error(
    `${toolName}: pm_* orders are restricted to risk reduction — set reduceOnly:true or closeOrder:true. ` +
    `The position manager can never open or increase exposure.`
  );
}

async function computePositionSize(
  client: KuCoinFuturesClient,
  args: { symbol?: string; riskPercentage?: any; leverage?: any; entryPrice?: any; currency?: string }
): Promise<any> {
  const symbol = args.symbol;
  if (!symbol) throw new Error("calculatePositionSize: symbol is required");
  const riskPct = Number(args.riskPercentage);
  if (!isFinite(riskPct) || riskPct <= 0 || riskPct > 100) {
    throw new Error(`calculatePositionSize: riskPercentage must be in (0, 100], got ${args.riskPercentage}`);
  }
  const leverage = hasValue(args.leverage) ? Number(args.leverage) : 1;
  if (!isFinite(leverage) || leverage <= 0) {
    throw new Error(`calculatePositionSize: leverage must be positive, got ${args.leverage}`);
  }

  const [detailResp, accountResp] = await Promise.all([
    client.getSymbolDetail(symbol),
    client.getAccountFutures(args.currency || "USDT"),
  ]);
  const detail = detailResp?.data;
  if (!detail) throw new Error(`calculatePositionSize: no contract details for ${symbol}`);
  const equity = Number(accountResp?.data?.accountEquity);
  if (!isFinite(equity) || equity <= 0) {
    throw new Error("calculatePositionSize: could not read accountEquity from account overview");
  }

  let price = hasValue(args.entryPrice) ? Number(args.entryPrice) : NaN;
  if (!isFinite(price) || price <= 0) {
    const tickerResp = await client.getTicker(symbol);
    price = Number(tickerResp?.data?.price);
  }
  if (!isFinite(price) || price <= 0) {
    throw new Error(`calculatePositionSize: could not determine a price for ${symbol}`);
  }

  const multiplier = Number(detail.multiplier);
  if (!isFinite(multiplier) || multiplier <= 0) {
    throw new Error(`calculatePositionSize: invalid contract multiplier for ${symbol}`);
  }
  const lotSize = isFinite(Number(detail.lotSize)) && Number(detail.lotSize) > 0 ? Number(detail.lotSize) : 1;
  const maxOrderQty = isFinite(Number(detail.maxOrderQty)) && Number(detail.maxOrderQty) > 0 ? Number(detail.maxOrderQty) : null;

  const marginBudgetUsdt = equity * (riskPct / 100);
  const notionalBudgetUsdt = marginBudgetUsdt * leverage;
  const contractValueUsdt = price * multiplier;
  let size = Math.floor(notionalBudgetUsdt / contractValueUsdt / lotSize) * lotSize;
  if (maxOrderQty !== null && size > maxOrderQty) {
    size = Math.floor(maxOrderQty / lotSize) * lotSize;
  }
  if (!isFinite(size) || size < lotSize || size <= 0) {
    throw new Error(
      `calculatePositionSize: risk budget too small — ${riskPct}% of equity ${equity.toFixed(2)} USDT at ${leverage}x ` +
      `covers ${(notionalBudgetUsdt / contractValueUsdt).toFixed(3)} lots of ${symbol} ` +
      `(contract value ${contractValueUsdt.toFixed(4)} USDT/lot, min lot ${lotSize})`
    );
  }

  return {
    code: "200000",
    data: {
      symbol,
      size,
      riskPercentage: riskPct,
      leverage,
      price,
      equityUsdt: equity,
      marginBudgetUsdt,
      notionalBudgetUsdt,
      contractValueUsdt,
      multiplier,
      lotSize,
      maxOrderQty,
      formula: "size = floor(equity * riskPercentage% * leverage / (price * multiplier)) quantized to lotSize",
    },
  };
}

// Applied to addOrder/addStopOrder after schema validation, before the
// exchange call. Mutates params: resolves riskPercentage into a server-
// computed size (overriding any client-provided quantity) and strips the
// helper field so KuCoin never sees it. Orders from the autonomous trader
// (clientOid 'ta_*') that open exposure MUST carry riskPercentage — the
// calling agent is structurally unable to place an unvalidated size.
async function applyServerSideSizing(
  client: KuCoinFuturesClient,
  toolName: string,
  params: any
): Promise<void> {
  const isCloseLike = params.closeOrder === true || params.reduceOnly === true;
  const isTraderEntry =
    typeof params.clientOid === "string" && TRADER_OID_PREFIX.test(params.clientOid) && !isCloseLike;
  const hasRisk = hasValue(params.riskPercentage);

  if (!hasRisk) {
    if (isTraderEntry) {
      throw new Error(
        `${toolName}: riskPercentage is required for ta_* entry orders — size is computed server-side. ` +
        `Re-submit the same order with riskPercentage (percent of equity to commit as margin); ` +
        `any client-side size is not trusted.`
      );
    }
    return; // manual/non-trader call without riskPercentage: behavior unchanged
  }

  const riskPercentage = params.riskPercentage;
  delete params.riskPercentage; // never forward the helper field to KuCoin
  if (isCloseLike) return; // closes/reductions size against the position, not the risk budget

  const sizing = await computePositionSize(client, {
    symbol: params.symbol,
    riskPercentage,
    leverage: params.leverage,
    entryPrice: params.price,
  });
  delete params.qty;
  delete params.valueQty;
  params.size = sizing.data.size;
  debugLog(`${toolName}: server-side sizing applied`, JSON.stringify(sizing.data));
}

// Shared response formatting for a successful tools/call. Both the /mcp and
// /stream endpoints support the same three output shapes (raw | hybrid |
// standard); the caller passes its own header set so each endpoint's response
// headers stay exactly as before.
function formatToolCallSuccess(
  result: any,
  format: string | null,
  id: any,
  headers: Record<string, string>
): Response {
  if (format === 'raw') {
    // Return direct JSON without MCP wrapper for HTTP workflows
    return new Response(JSON.stringify(result), { headers });
  } else if (format === 'hybrid') {
    // MCP-compliant JSON-RPC envelope but with direct data (n8n community node)
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers });
  }
  // Standard MCP wrapped response for Claude Desktop
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(result) }] }
  }), { headers });
}

// Helper function to execute tool calls
async function executeToolCall(client: KuCoinFuturesClient, name: string, args: any) {
  // Normalize parameters from different MCP client formats
  const normalizedArgs = normalizeParameters(args);
  switch (name) {
    // Market Data Tools
    case 'getSymbols':
      return await client.getSymbols();
    case 'getTicker':
      return await client.getTicker(normalizedArgs.symbol);
    case 'getOrderBook':
      return await client.getOrderBook(normalizedArgs.symbol, normalizedArgs.depth || 20);
    case 'getKlines':
      return await client.getKlines(normalizedArgs.symbol, normalizedArgs.granularity, normalizedArgs.from, normalizedArgs.to);
    case 'getSymbolDetail':
      return await client.getSymbolDetail(normalizedArgs.symbol);
    case 'calculatePositionSize':
      return await computePositionSize(client, normalizedArgs);

    // Order Management Tools
    case 'addOrder':
      validateOrThrow(addOrderSchema, 'addOrder', normalizedArgs);
      enforcePositionManagerReduceOnly('addOrder', normalizedArgs);
      await applyServerSideSizing(client, 'addOrder', normalizedArgs);
      return await client.addOrder(normalizedArgs);
    case 'cancelOrder':
      return await client.cancelOrder(normalizedArgs.orderId);
    case 'cancelStopOrder':
      return await client.cancelStopOrder(normalizedArgs.orderId);
    case 'cancelAllOrders':
      return await client.cancelAllOrders(normalizedArgs.symbol);
    case 'getOrders':
      return await client.getOrders(normalizedArgs.symbol, normalizedArgs.status, normalizedArgs.side, normalizedArgs.pageSize || 20);
    case 'getOrderById':
      return await client.getOrderById(normalizedArgs.orderId);
    
    // Position Management Tools
    case 'getPositions':
      return await client.getPositions();
    case 'getPosition':
      return await client.getPosition(normalizedArgs.symbol);
    case 'modifyMargin':
      return await client.modifyMargin(normalizedArgs.symbol, normalizedArgs.margin);
    
    // Funding Rate Tools
    case 'getFundingRate':
      return await client.getFundingRate(normalizedArgs.symbol);
    case 'getFundingHistory':
      return await client.getFundingHistory(normalizedArgs.symbol, normalizedArgs.from, normalizedArgs.to);
    
    // Account Information Tools
    case 'getAccountFutures':
      return await client.getAccountFutures(normalizedArgs.currency);
    
    // Advanced Order Management Tools
    case 'addStopOrder':
      validateOrThrow(addStopOrderSchema, 'addStopOrder', normalizedArgs);
      enforcePositionManagerReduceOnly('addStopOrder', normalizedArgs);
      await applyServerSideSizing(client, 'addStopOrder', normalizedArgs);
      // clientOid is derived deterministically inside addStopOrder when absent
      return await client.addStopOrder(normalizedArgs);
    case 'getOpenOrders':
      return await client.getOpenOrders(normalizedArgs.symbol);
    case 'getStopOrders':
      return await client.getStopOrders(
        normalizedArgs.symbol,
        normalizedArgs.side,
        normalizedArgs.pageSize || 50,
        normalizedArgs.currentPage || 1
      );
    case 'getPositionsHistory':
      return await client.getPositionsHistory(
        normalizedArgs.symbol,
        normalizedArgs.from,
        normalizedArgs.to,
        normalizedArgs.limit || 10,
        normalizedArgs.pageId || 1
      );
    case 'getFills':
      return await client.getFills(
        normalizedArgs.orderId,
        normalizedArgs.symbol,
        normalizedArgs.tradeTypes,
        normalizedArgs.side,
        normalizedArgs.type,
        normalizedArgs.startAt,
        normalizedArgs.endAt,
        normalizedArgs.currentPage || 1,
        normalizedArgs.pageSize || 50
      );
    
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}


// Main Vercel Edge Function
export default async function handler(request: Request) {
  // Get environment variables
  const env = process.env as unknown as Env;
  const url = new URL(request.url);
  
  // Handle CORS preflight - no auth required for OPTIONS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, X-MCP-Auth-Key, Authorization',
      }
    });
  }

  // Authenticate all non-OPTIONS requests
  const authResult = authenticateRequest(request, env);
  if (!authResult.isAuthenticated) {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: 401,
        message: authResult.error
      }
    }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
  
  // Handle /stream endpoint for n8n compatibility (optimized)
  if (url.pathname === '/stream') {
    return handleStreamableTransport(request, env);
  }
  
  // Main /mcp endpoint for Claude Desktop

  try {
    if (request.method === 'POST') {
      const body = await request.json() as any;
      
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      };

      // Handle MCP initialize request  
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "KuCoin Futures API MCP Server (Vercel EU)",
              version: "1.0.0"
            }
          }
        }), { headers });
      }

      // Handle notifications/initialized
      if (body.method === 'notifications/initialized') {
        return new Response(null, {
          status: 204,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Handle ping
      if (body.method === 'ping') {
        return new Response(JSON.stringify({
          jsonrpc: "2.0", 
          id: body.id,
          result: "pong"
        }), { headers });
      }

      // Handle tools/list
      if (body.method === 'tools/list') {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id, 
          result: { tools: allTools }
        }), { headers });
      }

      // Handle tools/call
      if (body.method === 'tools/call') {
        // Initialize KuCoin client
        const client = new KuCoinFuturesClient(
          env.KUCOIN_API_KEY,
          env.KUCOIN_API_SECRET, 
          env.KUCOIN_API_PASSPHRASE
        );
        
        try {
          // Execute the requested tool using helper function (same as /stream endpoint)
          const result = await executeToolCall(client, body.params.name, body.params.arguments);

          // Check for format query parameter
          const url = new URL(request.url);
          const format = url.searchParams.get('format');

          return formatToolCallSuccess(result, format, body.id, headers);

        } catch (error) {
          console.error(`Tool execution error for ${body.method}:`, error);
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: -1,
              message: `Failed to execute tool '${body.params?.name || 'unknown'}': Transport error: Error POSTing to endpoint (HTTP 500): ${JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                error: {
                  code: -1,
                  message: error instanceof Error ? error.message : String(error)
                }
              })}`
            }
          }), { headers });
        }
      }

      // Unknown method
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Method not found: ${body.method}` }
      }), { headers });
    }

    // Handle GET request
    return new Response(JSON.stringify({
      name: "KuCoin Futures API MCP Server (Vercel EU)",
      version: "1.0.0",
      description: "MCP server running on Vercel Edge Functions in European regions"
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (error) {
    console.error('Global error handler:', error);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -1, 
        message: `KuCoin API Error: 500 - ${JSON.stringify({
          msg: "Service not available temporarily, please try it later.",
          code: "100000"
        })}`,
        data: error instanceof Error ? error.message : String(error)
      }
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

export const config = {
  runtime: 'edge',
  regions: ['fra1', 'dub1', 'cdg1'] // Frankfurt, Dublin, Paris
};