import { z } from "zod";

// Environment variables interface for Vercel
interface Env {
  KUCOIN_API_KEY: string;
  KUCOIN_API_SECRET: string;
  KUCOIN_API_PASSPHRASE: string;
  MCP_AUTH_KEY?: string;
  MCP_AUTH_KEYS?: string; // Comma-separated list of keys for multiple teams
}

// KuCoin Futures API client adapted for Vercel Edge Runtime
class KuCoinFuturesClient {
  private apiKey: string;
  private apiSecret: string;
  private apiPassphrase: string;
  private baseUrl: string = "https://api-futures.kucoin.com";
  
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

    console.log(`Making KuCoin API request from Vercel EU edge: ${method} ${endpoint}`);
    if (requestBody) {
      console.log(`Request body:`, requestBody);
    }
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: method.toUpperCase(),
      headers,
      body: requestBody || undefined
    });

    console.log(`Response status: ${response.status}`);
    
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
    const endpoint = symbol ? `/api/v1/ticker?symbol=${symbol}` : "/api/v1/ticker";
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

  // Order Management Methods
  async addOrder(orderParams: any): Promise<any> {
    if (!orderParams.clientOid) {
      orderParams.clientOid = crypto.randomUUID();
    }
    return this.makeRequest("POST", "/api/v1/orders", orderParams);
  }

  async cancelOrder(orderId: string): Promise<any> {
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
      // Auto-generate clientOid if not provided (only essential logic)
      if (!orderParams.clientOid) {
        orderParams.clientOid = crypto.randomUUID();
      }
      
      // Add debug logging for troubleshooting
      console.log(`addStopOrder called with params:`, JSON.stringify(orderParams));
      
      // Let KuCoin API handle all validation - it provides proper error messages
      const result = await this.makeRequest("POST", "/api/v1/st-orders", orderParams);
      console.log(`addStopOrder successful:`, JSON.stringify(result));
      return result;
    } catch (error) {
      console.error(`addStopOrder failed:`, error);
      throw error;
    }
  }

  async getOpenOrders(symbol: string): Promise<any> {
    return this.makeRequest("GET", `/api/v1/openOrderStatistics?symbol=${symbol}`);
  }
}

// MCP Tools definitions - All 17 KuCoin Futures tools
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
          description: "Order book depth layer. Values 1-20 will use depth20, values 21-100 will use depth100",
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
  // Order Management Tools
  {
    name: "addOrder",
    description: "Place a new futures order",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (e.g., XBTUSDTM)"
        },
        side: {
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side"
        },
        type: {
          type: "string",
          enum: ["limit", "market"],
          description: "Order type"
        },
        size: {
          type: "number",
          description: "Order size"
        },
        price: {
          type: "number",
          description: "Order price (required for limit orders)"
        },
        clientOid: {
          type: "string",
          description: "Unique client order identifier"
        },
        leverage: {
          type: "number",
          description: "Leverage for the order"
        }
      },
      required: ["symbol", "side", "type", "size"]
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
    description: "Place a take profit and/or stop loss order. REQUIRED: symbol, side, leverage (integer), stopPriceType ('MP' recommended), at least one trigger price, and exactly one quantity (size/qty/valueQty). For limit orders, also provide 'price'. This advanced order type automatically executes when price reaches specified trigger levels, providing risk management and profit-taking capabilities.",
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
          description: "Order size in LOTS (whole number). Choose exactly ONE of: size, qty, or valueQty."
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
      required: ["clientOid", "symbol", "side", "leverage", "stopPriceType"],
      allOf: [
        {
          anyOf: [
            { required: ["triggerStopUpPrice"] },
            { required: ["triggerStopDownPrice"] }
          ]
        },
        {
          anyOf: [
            { required: ["size"] },
            { required: ["qty"] },
            { required: ["valueQty"] }
          ]
        },
        {
          if: { properties: { type: { const: "limit" } } },
          then: { required: ["price"] }
        },
        {
          if: { properties: { iceberg: { const: true } } },
          then: { required: ["visibleSize"] }
        }
      ]
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
          
          if (format === 'raw') {
            // Return direct JSON without MCP wrapper for HTTP workflows
            return new Response(JSON.stringify(result), {
              headers: { ...headers, 'Content-Type': 'application/json' }
            });
          } else if (format === 'hybrid') {
            // Return MCP-compliant JSON-RPC but with direct data (for n8n community node)
            const response = {
              jsonrpc: "2.0",
              id: body.id,
              result: result
            };
            return new Response(JSON.stringify(response), {
              headers: { ...headers, 'Content-Type': 'application/json' }
            });
          } else {
            // Standard MCP wrapped response for Claude Desktop
            const response = {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }]
              }
            };
            return new Response(JSON.stringify(response), {
              headers: { ...headers, 'Content-Type': 'application/json' }
            });
          }
          
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
  console.log('Raw args received:', JSON.stringify(args));
  
  // Handle array wrapper from built-in n8n MCP node: [{ query: { value: { ...params } }, tool: {...} }]
  if (Array.isArray(args) && args.length > 0) {
    console.log('Detected array wrapper from built-in n8n MCP node, extracting first element');
    args = args[0]; // Extract first element from array
  }
  
  // Handle built-in n8n MCP node format: { query: { value: { ...params } } }
  if (args && typeof args === 'object' && args.query && args.query.value) {
    console.log('Detected built-in n8n MCP node format, extracting from query.value');
    return args.query.value;
  }
  
  // Handle direct value wrapper: { value: { ...params } } (when array detection fails)
  if (args && typeof args === 'object' && args.value && typeof args.value === 'object') {
    console.log('Detected direct value wrapper, extracting from value');
    return args.value;
  }
  
  // Handle community n8n MCP node format: { Tool_Parameters: { ...params } }
  if (args && typeof args === 'object' && args.Tool_Parameters) {
    console.log('Detected community n8n MCP node format, extracting from Tool_Parameters');
    return args.Tool_Parameters;
  }
  
  // Handle standard format (Claude Desktop, direct API calls): { ...params }
  console.log('Using standard parameter format');
  return args;
}

// Authentication helper function
function authenticateRequest(request: Request, env: Env): { isAuthenticated: boolean; error?: string } {
  // If no auth keys are configured, allow access (backward compatibility)
  if (!env.MCP_AUTH_KEY && !env.MCP_AUTH_KEYS) {
    console.log('No authentication configured, allowing access');
    return { isAuthenticated: true };
  }

  // Get auth header - support both X-MCP-Auth-Key and Authorization Bearer
  const authHeader = request.headers.get('X-MCP-Auth-Key') || 
                    request.headers.get('Authorization')?.replace('Bearer ', '');

  if (!authHeader) {
    console.log('Authentication failed: No auth header provided');
    return { 
      isAuthenticated: false, 
      error: 'Authentication required. Provide X-MCP-Auth-Key header or Authorization: Bearer <key>' 
    };
  }

  // Check against configured keys
  const validKeys = [];
  if (env.MCP_AUTH_KEY) validKeys.push(env.MCP_AUTH_KEY);
  if (env.MCP_AUTH_KEYS) validKeys.push(...env.MCP_AUTH_KEYS.split(',').map(k => k.trim()));

  const isValid = validKeys.some(key => key === authHeader);
  
  if (isValid) {
    console.log('Authentication successful');
    return { isAuthenticated: true };
  } else {
    console.log('Authentication failed: Invalid auth key');
    return { 
      isAuthenticated: false, 
      error: 'Invalid authentication key' 
    };
  }
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
    
    // Order Management Tools
    case 'addOrder':
      return await client.addOrder(normalizedArgs);
    case 'cancelOrder':
      return await client.cancelOrder(normalizedArgs.orderId);
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
      // Auto-generate clientOid if not provided
      if (!normalizedArgs.clientOid) {
        normalizedArgs.clientOid = crypto.randomUUID();
      }
      return await client.addStopOrder(normalizedArgs);
    case 'getOpenOrders':
      return await client.getOpenOrders(normalizedArgs.symbol);
    
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
          let result;
          
          // Execute the requested tool using helper function (same as /stream endpoint)
          result = await executeToolCall(client, body.params.name, body.params.arguments);
          
          // Check for format query parameter
          const url = new URL(request.url);
          const format = url.searchParams.get('format');
          
          if (format === 'raw') {
            // Return direct JSON without MCP wrapper for HTTP workflows
            return new Response(JSON.stringify(result), {
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              }
            });
          } else if (format === 'hybrid') {
            // Return MCP-compliant JSON-RPC but with direct data (for n8n community node)
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: result
            }), { headers });
          } else {
            // Standard MCP wrapped response for Claude Desktop
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{
                  type: "text", 
                  text: JSON.stringify(result)
                }]
              }
            }), { headers });
          }
          
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