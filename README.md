# KuCoin Futures MCP Server

A Model Context Protocol (MCP) Server for the KuCoin Futures API with header-based authentication, deployed on Vercel Edge Functions.

## 🚀 Features

Complete trading functionality with **18 KuCoin Futures API tools** including:

### Market Data Tools (5)
- `getSymbols` - Get all available futures trading symbols/contracts
- `getTicker` - Get ticker information for specific or all symbols
- `getOrderBook` - Get order book depth data (optimized part-orderbook endpoint)
- `getKlines` - Get candlestick/kline data with time range support
- `getSymbolDetail` - Get detailed contract specifications and trading parameters

### Order Management Tools (7)
- `addOrder` - Place new futures orders (limit/market with leverage)
- `cancelOrder` - Cancel specific orders by ID
- `cancelAllOrders` - Cancel all orders or for specific symbol
- `getOrders` - List orders with filtering options (default: 20 orders per page)
- `getOrderById` - Get detailed order information
- `addStopOrder` - Place take profit and/or stop loss orders
- `getOpenOrders` - Get open order statistics (count and value of unexecuted orders)

### Position Management Tools (3)
- `getPositions` - Get all open positions
- `getPosition` - Get position details for specific symbol
- `modifyMargin` - Add or remove margin for positions

### Funding Rate Tools (2)
- `getFundingRate` - Get current funding rates
- `getFundingHistory` - Get historical funding rate data

### Account Information Tools (1)
- `getAccountFutures` - Get futures account overview for specified currency

## 🔐 Authentication

**Header-based authentication** with two supported methods:
- **Custom Header**: `X-MCP-Auth-Key: your-auth-key`
- **Bearer Token**: `Authorization: Bearer your-auth-key`

Environment variable: `MCP_AUTH_KEY` (set in Vercel dashboard)

## 📋 Prerequisites

1. **KuCoin Futures API Keys**
   - Go to [KuCoin Futures API](https://futures.kucoin.com/api)
   - Create a new API key with required permissions:
     - General (for Market Data)
     - Trade (for Order Management)
     - Transfer (if needed)

2. **Authentication Key**
   - Generate a secure authentication key for MCP access
   - Store as environment variable in Vercel dashboard

## 🚀 Deployment (Production)

This server is deployed on **Vercel Edge Functions** in European regions (Frankfurt, Dublin, Paris) to bypass KuCoin's US geo-restrictions.

**Live Server**: `https://remote-mcp-server-with-auth.vercel.app`

### Environment Variables (Vercel Dashboard)

Set these environment variables in your Vercel project:

```bash
# KuCoin Futures API credentials
KUCOIN_API_KEY=your_kucoin_api_key
KUCOIN_API_SECRET=your_kucoin_api_secret
KUCOIN_API_PASSPHRASE=your_kucoin_api_passphrase

# MCP Authentication
MCP_AUTH_KEY=your_secure_auth_key
```

## 🛠️ Usage

### Claude Desktop Integration

Add this configuration to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kucoin-futures": {
      "command": "npx",
      "args": ["mcp-remote", "https://remote-mcp-server-with-auth.vercel.app/mcp"],
      "env": {}
    }
  }
}
```

### n8n Workflow Integration

For n8n workflows, use HTTP Request nodes with authentication:

```json
{
  "method": "POST",
  "url": "https://remote-mcp-server-with-auth.vercel.app/mcp",
  "headers": {
    "Content-Type": "application/json",
    "X-MCP-Auth-Key": "your-auth-key"
  },
  "body": {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "getSymbols",
      "arguments": {}
    }
  }
}
```

## 📝 Example Usage

After setup, you can interact with the KuCoin Futures API directly:

```
"Show me all available trading symbols"
"What's the current ticker for XBTUSDTM?"
"Place a limit order for 0.1 BTC on XBTUSDTM at $65000"
"Show my current positions"
"Get open order statistics for XBTUSDTM"
"Place a stop loss order at $60000 for my BTC position"
```

## ⚡ Architecture

- **Runtime**: Vercel Edge Functions
- **Regions**: European deployment (Frankfurt, Dublin, Paris)
- **Authentication**: Header-based with environment variables
- **Protocol**: JSON-RPC 2.0 compliant MCP server
- **Geo-bypass**: Avoids KuCoin's US restrictions

## 🔧 Troubleshooting

### Authentication Errors (401 Unauthorized)
- Check your `MCP_AUTH_KEY` environment variable in Vercel
- Verify you're using the correct header: `X-MCP-Auth-Key` or `Authorization: Bearer`
- Ensure no extra spaces in the auth key value

### KuCoin API Errors
- Verify your KuCoin API credentials in Vercel environment variables
- Ensure your API key has the required permissions (General, Trade)
- Check KuCoin API rate limits (Market Data: 100 req/10s, Trading: 30 req/3s)

### Geo-restriction Errors
- This server is deployed in European regions to bypass US restrictions
- If you still encounter geo-blocks, the deployment region may need adjustment

### Tool Execution Errors
- Check tool parameters match the required schema
- Verify the JSON-RPC request format is correct
- Ensure all required parameters are provided

## 📊 API Limits

KuCoin API rate limits to be aware of:
- **Market Data**: 100 requests/10s
- **Trading**: 30 requests/3s
- **Individual symbols**: Specific limits per endpoint

## 🔒 Security

- **Encrypted transmission**: API keys securely transmitted via HTTPS
- **HMAC SHA256 signature**: All KuCoin API calls are cryptographically signed
- **Header authentication**: Secure MCP access control
- **Input validation**: All inputs validated with Zod schemas
- **Environment variables**: Sensitive data stored securely in Vercel

## 📁 Project Structure

```
api/
└── mcp.ts                # Main MCP server with KuCoin API integration

vercel.json               # Vercel deployment configuration
package.json              # Dependencies and scripts
README.md                 # This documentation
```

## 🏗️ Recent Changes

### Version 2.0.0 - Authentication & Migration
- **Added header authentication** (`X-MCP-Auth-Key`, `Authorization: Bearer`)
- **Migrated from Cloudflare Workers** to Vercel Edge Functions
- **European deployment** to bypass KuCoin geo-restrictions
- **Removed legacy OAuth/database** implementations
- **Optimized for n8n workflows** with universal compatibility
- **18 trading tools** fully functional and tested

## 📄 License

MIT License - see LICENSE file for details.