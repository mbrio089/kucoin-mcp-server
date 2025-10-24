# KuCoin Futures MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vercel](https://img.shields.io/badge/Vercel-000000?logo=vercel&logoColor=white)](https://vercel.com)

A production-ready **Model Context Protocol (MCP) Server** for KuCoin Futures API with header-based authentication, deployed on Vercel Edge Functions.

## 📑 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Prerequisites](#-prerequisites)
- [Deployment](#-deployment)
- [Usage](#-usage)
- [API Reference](#-api-reference)
- [Architecture](#-architecture)
- [Security](#-security)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

## 🚀 Features

### **20 Complete Trading Tools**

| Category | Tools | Description |
|----------|-------|-------------|
| **Market Data** (5) | `getSymbols`, `getTicker`, `getOrderBook`, `getKlines`, `getSymbolDetail` | Real-time market data and contract specifications |
| **Order Management** (8) | `addOrder`, `cancelOrder`, `cancelAllOrders`, `getOrders`, `getOrderById`, `addStopOrder`, `getOpenOrders`, `getFills` | Complete order lifecycle management |
| **Position Management** (4) | `getPositions`, `getPosition`, `modifyMargin`, `getPositionsHistory` | Position monitoring and management |
| **Funding** (2) | `getFundingRate`, `getFundingHistory` | Funding rate information |
| **Account** (1) | `getAccountFutures` | Account overview and balances |

### **Key Capabilities**
- ✅ **Real-time Trading** - Place, cancel, and monitor orders
- ✅ **Position Management** - Track P&L, manage margin, view history
- ✅ **Risk Management** - Stop-loss and take-profit orders
- ✅ **Market Analysis** - OHLCV data, order book depth, funding rates
- ✅ **Universal Compatibility** - Claude Desktop, n8n, direct HTTP
- ✅ **Production Ready** - European deployment, rate limiting, error handling

## 🚀 Quick Start

### 1. **Get KuCoin API Keys**
```bash
# Visit https://futures.kucoin.com/api
# Create API key with permissions: General, Trade
```

### 2. **Deploy to Vercel**
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/mbrio089/kucoin-mcp-server)

### 3. **Configure Environment Variables**
```bash
KUCOIN_API_KEY=your_api_key
KUCOIN_API_SECRET=your_api_secret
KUCOIN_API_PASSPHRASE=your_passphrase
MCP_AUTH_KEY=your_secure_auth_key
```

### 4. **Connect to Claude Desktop**
```json
{
  "mcpServers": {
    "kucoin-futures": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-deployment.vercel.app/mcp"],
      "env": {}
    }
  }
}
```

## 📋 Prerequisites

### **Required Accounts**
1. **[KuCoin Futures Account](https://futures.kucoin.com/)**
   - API key with `General` and `Trade` permissions
   - Sufficient balance for trading operations

2. **[Vercel Account](https://vercel.com)**
   - For deploying the MCP server
   - Free tier sufficient for personal use

### **Supported Clients**
- **Claude Desktop** - Direct MCP integration
- **n8n Workflows** - HTTP Request nodes
- **Custom Applications** - Direct JSON-RPC API

## 🚀 Deployment

### **Option 1: One-Click Deploy (Recommended)**
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/mbrio089/kucoin-mcp-server)

### **Option 2: Manual Deployment**

1. **Clone Repository**
   ```bash
   git clone https://github.com/mbrio089/kucoin-mcp-server.git
   cd kucoin-mcp-server
   ```

2. **Install Vercel CLI**
   ```bash
   npm i -g vercel
   ```

3. **Deploy**
   ```bash
   vercel --prod
   ```

4. **Set Environment Variables**
   ```bash
   vercel env add KUCOIN_API_KEY
   vercel env add KUCOIN_API_SECRET
   vercel env add KUCOIN_API_PASSPHRASE
   vercel env add MCP_AUTH_KEY
   ```

### **Environment Configuration**

Copy `.env.example` to configure your deployment:

```bash
# KuCoin Futures API credentials (get from https://futures.kucoin.com/api)
KUCOIN_API_KEY=your_kucoin_api_key_here
KUCOIN_API_SECRET=your_kucoin_api_secret_here
KUCOIN_API_PASSPHRASE=your_kucoin_api_passphrase_here

# MCP Authentication (generate a secure random string)
MCP_AUTH_KEY=your_secure_mcp_auth_key_here
```

## 🛠️ Usage

### **Claude Desktop Integration**

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kucoin-futures": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-deployment.vercel.app/mcp"],
      "env": {}
    }
  }
}
```

**Example Prompts:**
```
"Show me all available futures contracts"
"What's the current price of XBTUSDTM?"
"Place a limit buy order for 0.1 BTC at $65000"
"Show my current positions and their P&L"
"Set a stop loss at $60000 for my BTC position"
```

### **n8n Workflow Integration**

Use HTTP Request nodes with authentication:

```json
{
  "method": "POST",
  "url": "https://your-deployment.vercel.app/mcp",
  "headers": {
    "Content-Type": "application/json",
    "X-MCP-Auth-Key": "your-auth-key"
  },
  "body": {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "getPositions",
      "arguments": {}
    }
  }
}
```

### **Direct HTTP API**

```bash
curl -X POST https://your-deployment.vercel.app/mcp \
  -H "Content-Type: application/json" \
  -H "X-MCP-Auth-Key: your-auth-key" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "getTicker",
      "arguments": {"symbol": "XBTUSDTM"}
    }
  }'
```

## 📖 API Reference

### **Authentication**

Two authentication methods supported:

```bash
# Method 1: Custom Header
X-MCP-Auth-Key: your-auth-key

# Method 2: Bearer Token
Authorization: Bearer your-auth-key
```

### **Tool Categories**

<details>
<summary><strong>Market Data Tools (5)</strong></summary>

- **`getSymbols`** - Get all available futures contracts
- **`getTicker`** - Real-time price and 24h statistics
- **`getOrderBook`** - Order book depth (optimized endpoint)
- **`getKlines`** - Candlestick/OHLCV data with time ranges
- **`getSymbolDetail`** - Contract specifications and parameters

</details>

<details>
<summary><strong>Order Management Tools (8)</strong></summary>

- **`addOrder`** - Place limit/market orders with leverage
- **`cancelOrder`** - Cancel specific order by ID
- **`cancelAllOrders`** - Cancel all orders or by symbol
- **`getOrders`** - List orders with filtering options
- **`getOrderById`** - Get detailed order information
- **`addStopOrder`** - Place stop-loss/take-profit orders
- **`getOpenOrders`** - Get open order statistics
- **`getFills`** - Get executed trades with fees and liquidity

</details>

<details>
<summary><strong>Position Management Tools (4)</strong></summary>

- **`getPositions`** - Get all open positions
- **`getPosition`** - Get position details for specific symbol
- **`modifyMargin`** - Add or remove position margin
- **`getPositionsHistory`** - Historical positions with P&L analysis

</details>

<details>
<summary><strong>Additional Tools (3)</strong></summary>

- **`getFundingRate`** - Current funding rates
- **`getFundingHistory`** - Historical funding rate data
- **`getAccountFutures`** - Account overview and balances

</details>

## ⚡ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   MCP Client    │    │  Vercel Edge    │    │  KuCoin API     │
│  (Claude/n8n)  │◄──►│   Functions     │◄──►│    Futures      │
│                 │    │   (EU Regions)  │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### **Technical Stack**
- **Runtime**: Vercel Edge Functions (Node.js 22.x)
- **Language**: TypeScript with Zod validation
- **Protocol**: JSON-RPC 2.0 compliant MCP
- **Deployment**: European regions (Frankfurt, Dublin, Paris)
- **Authentication**: HMAC SHA256 + Header-based MCP auth

### **Key Benefits**
- **Low Latency**: Edge functions with <100ms response times
- **Geo-Bypass**: European deployment avoids US restrictions
- **Scalability**: Auto-scaling without infrastructure management
- **Security**: Multi-layer authentication and encrypted transmission

## 🔒 Security

### **Multi-Layer Security**
1. **Transport Security**: HTTPS/TLS encryption
2. **API Authentication**: HMAC SHA256 signatures for KuCoin
3. **Access Control**: Header-based authentication for MCP
4. **Input Validation**: Zod schemas validate all inputs
5. **Environment Security**: Sensitive data in Vercel environment variables

### **Rate Limiting**
- **Market Data**: 100 requests/10 seconds
- **Trading**: 30 requests/3 seconds
- **Individual Endpoints**: Specific limits per endpoint

### **Best Practices**
- Never commit API keys to version control
- Use environment variables for all sensitive data
- Regularly rotate authentication keys
- Monitor API usage and rate limits

## 🔧 Troubleshooting

### **Common Issues**

#### **401 Authentication Errors**
```bash
# Check MCP authentication
curl -H "X-MCP-Auth-Key: your-key" https://your-deployment.vercel.app/mcp

# Verify environment variables in Vercel dashboard
vercel env ls
```

#### **KuCoin API Errors**
- Verify API key permissions (General + Trade required)
- Check rate limits (Market: 100/10s, Trading: 30/3s)
- Ensure correct API credentials in environment variables

#### **Geo-restriction Issues**
- Server deployed in EU regions to bypass US restrictions
- If issues persist, check deployment region in Vercel

#### **Tool Execution Errors**
- Validate JSON-RPC request format
- Ensure all required parameters are provided
- Check tool schemas in MCP tools list

### **Debug Commands**
```bash
# Test MCP server health
curl -X OPTIONS https://your-deployment.vercel.app/mcp

# List available tools
curl -X POST https://your-deployment.vercel.app/mcp \
  -H "Content-Type: application/json" \
  -H "X-MCP-Auth-Key: your-key" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Check Vercel deployment logs
vercel logs https://your-deployment.vercel.app
```

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### **Development Setup**
```bash
git clone https://github.com/mbrio089/kucoin-mcp-server.git
cd kucoin-mcp-server
npm install
cp .env.example .env.local  # Configure your environment
vercel dev  # Start local development server
```

### **Code Standards**
- TypeScript with strict mode
- Zod for input validation
- JSON-RPC 2.0 compliance
- Comprehensive error handling

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

### **Author**
**Moritz Braun**
LinkedIn: [https://www.linkedin.com/in/moritz-braun-748434b4/](https://www.linkedin.com/in/moritz-braun-748434b4/)

---

⭐ **Star this repository** if you find it helpful!

**Need help?** Open an issue or check the [troubleshooting guide](#-troubleshooting).