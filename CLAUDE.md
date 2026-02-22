# Solana Arbitrage Bot

## Stack
- **Runtime:** Node.js v18+ (v24 on dev machine)
- **Language:** TypeScript (strict mode)
- **Data source:** Jupiter Quote API v6 (free, no API key)
- **Future:** @solana/web3.js for transaction execution (Phase 3)

## Conventions
- Minimal dependencies — only `dotenv` in production deps
- All amounts in smallest token unit (lamports, 6-decimal for stables)
- Profit calculations use JavaScript Number (sufficient precision for <$1M amounts)
- Console output uses ANSI color codes (no chalk dependency)
- File logs in JSON Lines format, one file per day in `logs/`
- Config via environment variables (.env) for secrets, hardcoded for stable values

## Security Rules
- Private keys NEVER in source code — .env only, gitignored
- Telegram bot token in .env, never committed
- No external dependencies for HTTP (uses Node built-in fetch)
- .env.example has placeholder values only

## Known Issues
- Jupiter API DEX label names need verification against live API
- PYUSD mint address (2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo) should be verified
- Free-tier rate limits may require tuning `requestDelayMs` and `scanIntervalMs`
- Scanner approximates round-trip profit using fixed scan amounts (accurate for stablecoins, approximate for LSTs)
