# MCP Server with GitHub OAuth - Implementation Guide

This guide provides implementation patterns and standards for building MCP (Model Context Protocol) servers with GitHub OAuth authentication using Node.js, TypeScript, and Cloudflare Workers. For WHAT to build, see the PRP (Product Requirement Prompt) documents.

## Core Principles

**IMPORTANT: You MUST follow these principles in all code changes and PRP generations:**

### KISS (Keep It Simple, Stupid)

- Simplicity should be a key goal in design
- Choose straightforward solutions over complex ones whenever possible
- Simple solutions are easier to understand, maintain, and debug

### YAGNI (You Aren't Gonna Need It)

- Avoid building functionality on speculation
- Implement features only when they are needed, not when you anticipate they might be useful in the future

### Open/Closed Principle

- Software entities should be open for extension but closed for modification
- Design systems so that new functionality can be added with minimal changes to existing code

## Troubleshooting Notes

### API Service Restrictions

- **KuCoin API Access Issues**: 
  - Encountered error indicating service unavailability in the U.S.
  - **RESOLVED**: Successfully deployed to European regions (Frankfurt, Dublin, Paris) via Vercel
  - Current implementation bypasses geo-restrictions and provides full API access

### Advanced Trading Features

- **Risk Management Tools**: The MCP server now includes advanced order types like `addStopOrder` for automated take profit and stop loss functionality
- **AI-Optimized Design**: Tool schemas include comprehensive descriptions to help AI agents understand proper trading patterns and risk management strategies
- **Position Protection**: Built-in safeguards like `reduceOnly` and `closeOrder` options prevent common trading mistakes

[... rest of the existing content remains unchanged ...]