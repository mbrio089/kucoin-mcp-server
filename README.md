# KuCoin Futures MCP Server

Ein Model Context Protocol (MCP) Server für die KuCoin Futures API mit GitHub OAuth-Authentifizierung.

## 🚀 Features

### Market Data Tools
- `getSymbols` - Alle verfügbaren Futures-Handelssymbole abrufen
- `getTicker` - Ticker-Informationen für spezifische oder alle Symbole
- `getOrderBook` - Order-Book-Daten mit konfigurierbarer Tiefe
- `getKlines` - Candlestick/Kline-Daten mit Zeitbereich-Unterstützung
- `getSymbolDetail` - Detaillierte Kontraktspezifikationen und Handelsparameter abrufen

### Order Management Tools
- `addOrder` - Neue Futures-Orders platzieren (Limit/Market, mit Hebel)
- `cancelOrder` - Spezifische Orders per ID stornieren
- `cancelAllOrders` - Alle Orders oder für spezifisches Symbol stornieren
- `getOrders` - Orders mit Filteroptionen auflisten (Standard: 20 Orders pro Seite)
- `getOrderById` - Detaillierte Order-Informationen abrufen
- `getOpenOrders` - Offene Order-Statistiken abrufen (Anzahl und Wert nicht ausgeführter Orders)

### Position Management Tools
- `getPositions` - Alle offenen Positionen abrufen
- `getPosition` - Positionsdetails für spezifisches Symbol
- `modifyMargin` - Margin für Positionen hinzufügen oder entfernen

### Funding Rate Tools
- `getFundingRate` - Aktuelle Funding-Raten abrufen
- `getFundingHistory` - Historische Funding-Rate-Daten

## 📋 Voraussetzungen

1. **KuCoin Futures API-Schlüssel**
   - Gehe zu [KuCoin Futures API](https://futures.kucoin.com/api)
   - Erstelle einen neuen API-Schlüssel mit den benötigten Berechtigungen:
     - General (für Market Data)
     - Trade (für Order Management)
     - Transfer (falls benötigt)

2. **GitHub OAuth App**
   - Gehe zu [GitHub Developer Settings](https://github.com/settings/applications/new)
   - Erstelle eine neue OAuth App mit:
     - Application name: `KuCoin Futures MCP Server`
     - Homepage URL: `http://localhost:8800`
     - Authorization callback URL: `http://localhost:8800/callback`

## 🛠️ Setup

### 1. Environment Variables konfigurieren

Bearbeite die `.dev.vars` Datei und fülle sie mit deinen echten Werten aus:

```bash
# KuCoin Futures API credentials
KUCOIN_API_KEY=dein_kucoin_api_key
KUCOIN_API_SECRET=dein_kucoin_api_secret
KUCOIN_API_PASSPHRASE=dein_kucoin_api_passphrase

# GitHub OAuth credentials
GITHUB_CLIENT_ID=dein_github_client_id
GITHUB_CLIENT_SECRET=dein_github_client_secret

# Cookie encryption key (32+ Zeichen zufälliger String)
COOKIE_ENCRYPTION_KEY=dein_sicherer_zufälliger_string_min_32_zeichen
```

### 2. Abhängigkeiten installieren

```bash
npm install
```

### 3. Development Server starten

```bash
wrangler dev
```

Der Server läuft auf `http://localhost:8800`

### 4. Zu Claude Desktop hinzufügen

Füge folgende Konfiguration zu deiner Claude Desktop `claude_desktop_config.json` hinzu:

```json
{
  "mcpServers": {
    "kucoin-futures": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8800/mcp"],
      "env": {}
    }
  }
}
```

## 🔐 Authentifizierung

Der Server verwendet GitHub OAuth für die Authentifizierung:

1. Beim ersten Zugriff wirst du zu GitHub weitergeleitet
2. Autorisiere die Anwendung
3. Du wirst zurück zum MCP Server geleitet
4. Deine GitHub-Identität wird für alle API-Aufrufe verwendet

## 🚀 Deployment

### Production Secrets setzen

```bash
wrangler secret put KUCOIN_API_KEY
wrangler secret put KUCOIN_API_SECRET
wrangler secret put KUCOIN_API_PASSPHRASE
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put COOKIE_ENCRYPTION_KEY
```

### Deploy

```bash
wrangler deploy
```

## 📝 Verwendung

Nach der Einrichtung kannst du in Claude Desktop direkt mit der KuCoin Futures API interagieren:

```
"Zeige mir alle verfügbaren Trading-Symbole"
"Was ist der aktuelle Ticker für XBTUSDTM?"
"Platziere eine Limit-Order für 0.1 BTC auf XBTUSDTM bei $50000"
"Zeige meine aktuellen Positionen"
"Zeige meine offenen Order-Statistiken für XBTUSDTM"
```

## 🔧 Troubleshooting

### OAuth Error: 401 invalid_token
- Überprüfe deine GitHub OAuth-Credentials in `.dev.vars`
- Stelle sicher, dass die Callback URL richtig konfiguriert ist: `http://localhost:8800/callback`
- Regeneriere den COOKIE_ENCRYPTION_KEY mit mindestens 32 Zeichen
- Stelle sicher, dass alle Umgebungsvariablen gesetzt sind

### Cookie signature verification failed
- Lösche alte Cookies: Besuche `http://localhost:8800/clear-cookies`
- Stelle sicher, dass der COOKIE_ENCRYPTION_KEY mindestens 32 Zeichen hat
- Starte den Development Server neu: `wrangler dev`
- Verwende einen neuen Browser-Tab oder Inkognito-Modus

### KuCoin API Errors
- Überprüfe deine KuCoin API-Credentials
- Stelle sicher, dass dein API-Schlüssel die erforderlichen Berechtigungen hat
- Überprüfe die API-Rate-Limits

### Type Errors
```bash
npm run type-check
wrangler types
```

## 📊 API Limits

Beachte die KuCoin API-Limits:
- Market Data: 100 Anfragen/10s
- Trading: 30 Anfragen/3s
- Einzelne Symbole: Spezifische Limits pro Endpoint

## 🔒 Sicherheit

- API-Schlüssel werden sicher verschlüsselt übertragen
- HMAC SHA256-Signierung für alle KuCoin API-Aufrufe
- GitHub OAuth für Benutzerauthentifizierung
- Alle Eingaben werden mit Zod-Schemas validiert

## 📁 Projektstruktur

```
src/
├── kucoin-futures.ts     # Haupt-MCP-Server mit KuCoin API Integration
├── types.ts              # TypeScript-Typen und Hilfsfunktionen
└── auth/
    ├── github-handler.ts # GitHub OAuth-Handler
    └── oauth-utils.ts    # OAuth-Hilfsfunktionen
```

## 📄 Lizenz

MIT License - siehe LICENSE Datei für Details.