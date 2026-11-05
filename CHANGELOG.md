# Changelog

## Brain risk gateway (2026-11-05)

- New restricted key `MCP_BRAIN_KEY` (role `brain`) for the autonomous Hermes futures agent. The brain may read everything, open entries only via `addStopOrder` with clientOid `hx_…` (experiments `hx_x_…`), exit only with reduceOnly/closeOrder against an open position, cancel only its own orders, and cancel a protective stop only while an equal-or-tighter stop still covers the position. `cancelAllOrders` is not available to it.
- Every `hx_` entry (any key) passes `lib/brainGateway.ts`: kill switch `BRAIN_TRADING_ENABLED` (default off), equity floor, daily (UTC) and rolling 7-day loss stop, entries per day, symbol set (top N USDT perps by turnover), mandatory stop-loss on the correct side, stop-distance band, integer leverage cap, ISOLATED only, risk-to-stop sizing (`riskPercentage` = % of equity lost at the stop), margin check and an account-wide open stop-risk budget. All reads fail closed.
- Limits are Vercel env vars with defaults: `BRAIN_RISK_PCT_MAX` 1.5, `BRAIN_EXPERIMENT_RISK_PCT_MAX` 0.75, `BRAIN_MAX_EXPERIMENTS` 1, `BRAIN_OPEN_RISK_PCT_MAX` 5, `BRAIN_MAX_POSITIONS` 5, `BRAIN_DAILY_LOSS_PCT` 4, `BRAIN_WEEKLY_LOSS_PCT` 10, `BRAIN_EQUITY_FLOOR_USDT` 300, `BRAIN_MAX_LEVERAGE` 5, `BRAIN_MIN_STOP_PCT` 0.4, `BRAIN_MAX_STOP_PCT` 6, `BRAIN_MAX_ENTRIES_PER_DAY` 8, `BRAIN_TOP_SYMBOLS` 20, `BRAIN_MIN_TURNOVER_USDT` 20000000, optional `BRAIN_SYMBOL_ALLOWLIST`.
- New tool `getRiskBudget` (limits, usage, blockers, stop coverage per position, allowed symbols).
- The one-way netting guard now covers `hx_` entries as well as `ta_`.
- Legacy `ta_`/`pm_` behaviour with the admin key is unchanged. Tests: `node --experimental-strip-types --import ./test/ts-resolve.mjs test/brain.mjs` (same for the other test files).

## Version 2.1.0 - New Trading Analysis Tools (2025-09-12)

### 🆕 New Features

#### Added `getPositionsHistory` Tool
- **Endpoint**: `/api/v1/history-positions`
- **Purpose**: Retrieve comprehensive historical positions data for trading analysis
- **Weight**: 2 (KuCoin Futures API weight)
- **Permission**: General API access required

**Parameters**:
- `symbol` (optional) - Filter by specific trading symbol
- `from` (optional) - Start timestamp for position closing time (Unix milliseconds)
- `to` (optional) - End timestamp for position closing time (Unix milliseconds)
- `limit` (optional) - Results per page (1-200, default: 10)
- `pageId` (optional) - Page number for pagination (default: 1)

**Response Data**:
- Position close ID and timestamps
- Profit/Loss (PNL) calculations
- Trading fees and funding fees
- Open/close prices and leverage details
- Return on Equity (ROE)
- Margin mode and position side

#### Added `getFills` Tool
- **Endpoint**: `/api/v1/fills`
- **Purpose**: Get detailed filled/executed trades list with comprehensive execution info
- **Weight**: 5 (KuCoin Futures API weight)
- **Permission**: General API access required
- **Data Retention**: Up to one week

**Parameters**:
- `orderId` (optional) - Get fills for specific order
- `symbol` (optional) - Filter by trading symbol
- `tradeTypes` (optional) - Transaction types (trade, adl, liquid, settlement)
- `side` (optional) - Order side filter (buy/sell)
- `type` (optional) - Order type filter
- `startAt` (optional) - Start timestamp (Unix milliseconds)
- `endAt` (optional) - End timestamp (Unix milliseconds)
- `currentPage` (optional) - Page number (default: 1)
- `pageSize` (optional) - Results per page (1-1000, default: 50)

**Response Data**:
- Trade execution details (price, size, value)
- Fee information (open/close fees, rates)
- Liquidity information (maker/taker)
- Order and trade IDs
- Margin mode and position details

### 🔧 Technical Implementation

#### Code Changes
- **File**: `api/mcp.ts`
  - Added `getPositionsHistory()` method to `KuCoinFuturesClient` class (lines 237-249)
  - Added `getFills()` method to `KuCoinFuturesClient` class (lines 251-277)
  - Added tool definitions to `allTools` array (lines 709-821)
  - Added case handlers in `executeToolCall()` function (lines 1110-1129)
  - Updated tool count comment from 19 to 20 tools

- **File**: `README.md`
  - Updated tool count from 18 to 20 in feature description
  - Added new tools to Position Management (4 tools) and Order Management (8 tools) categories
  - Added usage examples for both new tools
  - Updated recent changes section

#### Implementation Features
- **Parameter Validation**: Both tools enforce API limits (200 max for positions, 1000 max for fills)
- **URL Construction**: Dynamic endpoint building with optional parameter handling
- **Error Handling**: Consistent with existing tool error patterns
- **Authentication**: Inherits existing HMAC SHA256 signature authentication

### 🧪 Testing & Verification

#### Production Testing Results
**Environment**: `https://remote-mcp-server-with-auth.vercel.app`
**Authentication**: Header-based auth verified working

#### `getPositionsHistory` Testing
- ✅ **Basic Functionality**: Successfully retrieved 39 total positions
- ✅ **Pagination**: Correctly returned 5 positions as requested
- ✅ **Data Quality**: Complete position history with PNL, fees, timing
- ✅ **Multi-Symbol**: Returned positions for SOL, BTC, ENA symbols

**Sample Response Data**:
```json
{
  "currentPage": 1,
  "pageSize": 5,
  "totalNum": 39,
  "items": [
    {
      "symbol": "SOLUSDTM",
      "type": "CLOSE_LONG",
      "pnl": "20.1417012",
      "tradeFee": "0.74025828",
      "roe": "0.3311237508"
      // ... additional fields
    }
  ]
}
```

#### `getFills` Testing
- ✅ **Basic Functionality**: Successfully retrieved 6 total fills
- ✅ **Pagination**: Correctly returned 3 fills as requested
- ✅ **Symbol Filtering**: XBTUSDTM filter returned 2 BTC-specific trades
- ✅ **Execution Details**: Complete trade data with maker/taker liquidity info

**Sample Response Data**:
```json
{
  "currentPage": 1,
  "pageSize": 3,
  "totalNum": 6,
  "items": [
    {
      "symbol": "XBTUSDTM",
      "tradeId": "1872048812657",
      "side": "buy",
      "liquidity": "maker",
      "price": "114261.7",
      "fee": "1.05120764"
      // ... additional fields
    }
  ]
}
```

### 📊 Impact & Benefits

#### Enhanced Trading Capabilities
1. **Historical Analysis**: Complete position performance tracking with PNL analysis
2. **Trade Execution Analysis**: Detailed fill data for performance optimization
3. **Fee Tracking**: Comprehensive fee breakdown for cost analysis
4. **Liquidity Assessment**: Maker vs taker execution analysis

#### Use Cases Enabled
- Trading performance analysis and reporting
- Fee optimization strategies
- Risk management through historical position review
- Compliance and audit trail capabilities
- Trading pattern analysis and strategy refinement

### 🚀 Deployment

#### Git Integration
- **Commit**: `e11c88d` - "feat: add getPositionsHistory and getFills trading tools"
- **Branch**: `main`
- **Files Modified**: `api/mcp.ts`, `README.md`

#### Vercel Deployment
- **Status**: Successfully deployed to production
- **Deployment URL**: `https://remote-mcp-server-with-auth-7jdhc9k8r-mbrio089s-projects.vercel.app`
- **Build Time**: 19 seconds
- **Region**: European deployment (Frankfurt, Dublin, Paris)

### 📈 Statistics
- **Total Tools**: 20 (increased from 18)
- **New LOC**: ~156 lines added across both files
- **API Coverage**: 2 additional KuCoin Futures endpoints integrated
- **Testing**: 100% functionality verified in production environment

---

## Previous Versions

### Version 2.0.0 - Authentication & Migration
- Added header authentication (`X-MCP-Auth-Key`, `Authorization: Bearer`)
- Migrated from Cloudflare Workers to Vercel Edge Functions
- European deployment to bypass KuCoin geo-restrictions
- Removed legacy OAuth/database implementations
- Optimized for n8n workflows with universal compatibility
- 18 trading tools fully functional and tested