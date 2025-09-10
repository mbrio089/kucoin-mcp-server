# n8n Authentication Setup for KuCoin MCP Server

## Overview
Your KuCoin MCP Server now requires authentication via header-based API key authentication. This document provides setup instructions for n8n workflows.

## Authentication Details

### Supported Authentication Methods:
1. **Custom Header**: `X-MCP-Auth-Key: your-auth-key`
2. **Bearer Token**: `Authorization: Bearer your-auth-key`

### Your Authentication Key:
```
bf51c031d5ca393ab261195dee8e21a1e53a5c98ba16a5691c9e47131e306bfb
```

## n8n Workflow Configuration

### Method 1: Using HTTP Request Node (Recommended)

For direct API calls to the MCP server:

```json
{
  "headers": {
    "Content-Type": "application/json",
    "X-MCP-Auth-Key": "bf51c031d5ca393ab261195dee8e21a1e53a5c98ba16a5691c9e47131e306bfb"
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

### Method 2: Using MCP Client Node

If using the community MCP node (`n8n-nodes-mcp`):

1. **Install the community package**:
   ```bash
   npm install n8n-nodes-mcp
   ```

2. **Configure the MCP Client Node**:
   - **URL**: `https://remote-mcp-server-with-auth.vercel.app/stream`
   - **Headers**: Add custom header `X-MCP-Auth-Key` with your auth key
   - **Transport**: HTTP Streamable

### Method 3: Built-in n8n MCP Node

If using n8n's built-in MCP node:

1. **Configure the MCP Server Node**:
   - **URL**: `https://remote-mcp-server-with-auth.vercel.app/mcp`
   - **Authentication**: Custom Header
   - **Header Name**: `X-MCP-Auth-Key`
   - **Header Value**: `bf51c031d5ca393ab261195dee8e21a1e53a5c98ba16a5691c9e47131e306bfb`

## Example Workflow Configurations

### 1. Get Trading Symbols
```json
{
  "method": "POST",
  "url": "https://remote-mcp-server-with-auth.vercel.app/mcp",
  "headers": {
    "Content-Type": "application/json",
    "X-MCP-Auth-Key": "bf51c031d5ca393ab261195dee8e21a1e53a5c98ba16a5691c9e47131e306bfb"
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

### 2. Get Account Information
```json
{
  "method": "POST",
  "url": "https://remote-mcp-server-with-auth.vercel.app/mcp",
  "headers": {
    "Content-Type": "application/json",
    "X-MCP-Auth-Key": "bf51c031d5ca393ab261195dee8e21a1e53a5c98ba16a5691c9e47131e306bfb"
  },
  "body": {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "getAccountFutures",
      "arguments": {
        "currency": "USDT"
      }
    }
  }
}
```

### 3. Place a Stop Order
```json
{
  "method": "POST",
  "url": "https://remote-mcp-server-with-auth.vercel.app/mcp",
  "headers": {
    "Content-Type": "application/json",
    "X-MCP-Auth-Key": "bf51c031d5ca393ab261195dee8e21a1e53a5c98ba16a5691c9e47131e306bfb"
  },
  "body": {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "addStopOrder",
      "arguments": {
        "symbol": "XBTUSDTM",
        "side": "buy",
        "leverage": 10,
        "stopPriceType": "MP",
        "triggerStopDownPrice": "65000",
        "size": 1
      }
    }
  }
}
```

## Security Best Practices

### 1. Environment Variables
Store your auth key in n8n environment variables instead of hardcoding:

1. Go to n8n Settings → Environment Variables
2. Add: `MCP_AUTH_KEY` = `bf51c031d5ca393ab261195dee8e21a1e53a5c98ba16a5691c9e47131e306bfb`
3. Use in workflows: `{{$env.MCP_AUTH_KEY}}`

### 2. Credential Management
Alternatively, use n8n's credential system:

1. Create new credential type "Header Auth"
2. Set header name: `X-MCP-Auth-Key`
3. Set header value: `bf51c031d5ca393ab261195dee8e21a1e53a5c98ba16a5691c9e47131e306bfb`

## Testing Authentication

### Test 1: Valid Authentication
```bash
curl -X POST "https://remote-mcp-server-with-auth.vercel.app/mcp" \
  -H "Content-Type: application/json" \
  -H "X-MCP-Auth-Key: bf51c031d5ca393ab261195dee8e21a1e53a5c98ba16a5691c9e47131e306bfb" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```
**Expected**: HTTP 200 with tools list

### Test 2: Missing Authentication
```bash
curl -X POST "https://remote-mcp-server-with-auth.vercel.app/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```
**Expected**: HTTP 401 with error message

### Test 3: Invalid Authentication
```bash
curl -X POST "https://remote-mcp-server-with-auth.vercel.app/mcp" \
  -H "Content-Type: application/json" \
  -H "X-MCP-Auth-Key: invalid-key" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```
**Expected**: HTTP 401 with error message

## Available Endpoints

### Primary Endpoints:
- **Main MCP**: `https://remote-mcp-server-with-auth.vercel.app/mcp`
- **Streamable**: `https://remote-mcp-server-with-auth.vercel.app/stream`

Both endpoints require authentication and support all 18 KuCoin Futures tools.

## Available Tools (18 Total)

### Market Data Tools (5):
- `getSymbols` - Get all available futures trading symbols
- `getTicker` - Get ticker information for symbols  
- `getOrderBook` - Get order book depth data
- `getKlines` - Get candlestick/kline data
- `getSymbolDetail` - Get detailed contract specifications

### Order Management Tools (7):
- `addOrder` - Place new futures orders
- `cancelOrder` - Cancel specific order by ID
- `cancelAllOrders` - Cancel all orders or by symbol
- `getOrders` - List orders with filtering
- `getOrderById` - Get detailed order information
- `addStopOrder` - Place take profit/stop loss orders
- `getOpenOrders` - Get open order statistics

### Position Management Tools (3):
- `getPositions` - Get all open positions
- `getPosition` - Get position details for symbol
- `modifyMargin` - Add/remove margin for positions

### Funding Rate Tools (2):
- `getFundingRate` - Get current funding rates
- `getFundingHistory` - Get historical funding data

### Account Information Tools (1):
- `getAccountFutures` - Get futures account overview

## Troubleshooting

### Common Errors:

**401 Unauthorized**
- Check auth key is correct
- Verify header name is `X-MCP-Auth-Key`
- Ensure no extra spaces in key value

**Method not found**
- Verify endpoint URL is correct
- Check JSON-RPC format is valid

**Tool execution errors**
- Check tool parameters match schema
- Verify KuCoin API credentials are valid

## Security Notes

- **Keep your auth key secret** - never commit to version control
- **Use environment variables** for key storage
- **Rotate keys regularly** for security
- **Monitor access logs** for unauthorized attempts

---

Your KuCoin MCP Server is now secured with header authentication! 🔐