# Solana Arbitrage Bot — Project Brain

## Project Summary
Cross-DEX arbitrage scanner on Solana. Automatically discovers long-tail tokens with pools on multiple DEXes, monitors price gaps, and alerts on profitable opportunities. Zero-cost architecture using free APIs.

## Current State
**v3.2: Live Execution Engine — OPERATIONAL**
- All v2.0 scanning features plus automated trade execution
- Wallet: 35GhfeRK...LvZD | SOL: ~0.03 | USDC: $22.36
- Auto-discovers 48 tokens, scans across 5 DEXes every 60s (~87 quotes/cycle)
- Executes trades at ≥50 bps (covers ~40 bps Jupiter platform fees)
- Trade sizing: 100% of USDC balance minus $1 refuel reserve (no hard cap)
- No trade-per-hour limit, 10s cooldown between trades
- Auto-refuel: swaps $1 USDC→SOL when SOL drops below 0.02
- Running on WSL/Ubuntu via tmux (24/7)
- Helius RPC (free tier, 1M credits/month) for tx submission
- Telegram alerts for all detections, executions, and bootstrap events
- 0 executions so far — market gaps consistently below 50 bps threshold

## Architecture
```
src/
  index.ts        Main entry — discovery loop (10min) + scan loop (60s)
  config.ts       Tokens, DEXes, thresholds, discovery config
  types.ts        TypeScript interfaces (Token, WatchlistToken, Opportunity, etc.)
  scanner.ts      Jupiter Quote API — fetchDexQuote, scanWatchlistToken, detectOpportunities
  discovery.ts    Token discovery — Jupiter candidate list + DexScreener multi-DEX validation
  rate-limiter.ts Token-bucket rate limiter for API calls
  logger.ts       Console output, file logging, Telegram alerts
```

**Stack:** Node.js v24 + TypeScript. dotenv + @solana/web3.js + @solana/spl-token.
**Data sources:**
- Jupiter public API (`public.jupiterapi.com`) — quotes, free, no key
- Jupiter token list (`cache.jup.ag/tokens`) — candidate discovery, cached 24h
- DexScreener API (`api.dexscreener.com`) — multi-DEX validation + volume/liquidity data

**Flow:**
1. Discovery (every 10min): Jupiter token list → filter community/old-registry tags → DexScreener per-token lookup → filter 2+ DEXes + $10K-$5M volume → watchlist
2. Scanning (every 60s): For each watchlist token vs USDC → Jupiter quotes on each known DEX → round-trip gap detection → alert if ≥50bps

## Phases
- [x] Phase 1: Stablecoin/LST scanner (v1.0) — DONE, obsoleted by v2.0
- [x] Phase 1.5: Long-tail token scanner (v2.0) — DONE, replaced by v3.0
- [x] Phase 3: Live execution engine (v3.0) — OPERATIONAL
- [ ] Phase 4: Expand (more pairs, better infra if profitable)

## Active Tasks
- [x] Run v2.0 scanner for 48hrs — collected 15+ opportunities
- [x] Configure Telegram alerts — working
- [x] Build execution engine (wallet, executor, bootstrap)
- [x] Add Helius RPC for reliable tx submission
- [x] Bootstrap USDC from SOL ($4.29 → $17.18)
- [x] Add auto-refuel (USDC→SOL when gas low)
- [x] Percentage-based trade sizing (80% of balance, $15 cap)
- [x] Remove trade-per-hour limits, reduce cooldown to 10s
- [x] Lower discovery volume filter ($50K→$20K) for more tokens
- [x] Remove hard cap, upgrade to 100% sizing with $1 refuel reserve
- [x] Swap 0.06 SOL → USDC (total now $22.36)
- [x] Lower volume filter further ($20K→$10K), liquidity ($5K→$2K), scan interval (120s→60s)
- [x] Attempted multi-hop routes — reverted (creates phantom opportunities)
- [ ] Monitor first live execution via Telegram
- [ ] Verify Solscan tx links work on trade notifications

## Decisions Log
| Date | Decision | Reason |
|------|----------|--------|
| 2026-02-19 | Zero-cost constraint | No paid RPC, no VPS. Free API + local machine |
| 2026-02-19 | `public.jupiterapi.com` | Old `quote-api.jup.ag` DNS dead, `api.jup.ag` requires auth |
| 2026-02-19 | Extract routePlan outAmount | Public endpoint adds 20bps platform fee to top-level outAmount |
| 2026-02-19 | SOL mint corrected to 43-char | Original 46-char address caused WrongSize API errors |
| 2026-02-19 | Pivot from stablecoins to long-tail | Stablecoin pairs too competitive (-2bps gap), zero opportunities in 70+ cycles |
| 2026-02-19 | Jupiter cache + DexScreener discovery | `tokens.jup.ag` DNS dead; `cache.jup.ag/tokens` works (287K tokens, cached to disk) |
| 2026-02-19 | Paginated discovery (200/cycle) | 1,466 candidates too many for single cycle; rotate through batches |
| 2026-02-19 | DexScreener DEX mapping fix | DexScreener uses `meteora` not `meteora-dlmm`; was missing Meteora pools |
| 2026-02-19 | 50bps min profit threshold | Long-tail gaps are wider than stablecoins; 3bps threshold too noisy |
| 2026-02-21 | 80% balance trade sizing | User wants dynamic sizing that scales with manual deposits |
| 2026-02-21 | $15 hard cap per trade | Safety limit even with percentage sizing |
| 2026-02-21 | Unlimited trades/hr, 10s cooldown | Maximize opportunity capture |
| 2026-02-21 | $20K min volume filter (was $50K) | More tokens with wider gaps, safe at $5-15 trade sizes |
| 2026-02-21 | Auto-refuel SOL from USDC | Self-sustaining gas management when SOL < 0.02 |
| 2026-02-21 | Removed hard cap, 100% sizing | Re-quote validation + price impact + slippage are sufficient safety nets |
| 2026-02-21 | $1 USDC refuel reserve | Keep $1 aside so auto-refuel can always swap USDC→SOL for gas |
| 2026-02-21 | $10K min volume (was $20K) | Expand watchlist to find wider gaps on smaller tokens |
| 2026-02-21 | 60s scan interval (was 120s) | Faster detection of fleeting opportunities |
| 2026-02-21 | `onlyDirectRoutes` MUST stay true | Multi-hop routes create phantom arb signals (tested: $912K fake profit on WBTC) |

## Known Issues
- Discovery takes ~80-100s per 200-candidate batch (DexScreener rate limiting)
- First run downloads 287K tokens from Jupiter (~55s); cached to disk for 24h after
- 5 DEXes configured (Raydium, Whirlpool, Meteora DLMM, Phoenix, Lifinity V2)
- Jupiter bootstrap quote can fail on first attempt (transient); retry logic handles it
- Public Solana RPC unreliable for tx submission; Helius required
- Helius RPC intermittently returns 0 for USDC balance (transient, recovers on retry/restart)
- Scan cycles take 130-165s with 48 tokens despite 60s interval (next cycle starts immediately)
- `onlyDirectRoutes` MUST be true — removing it causes phantom arbitrage from multi-hop routing differences
- Market is tight: 70+ cycles with 0 opportunities, closest gaps -2 to -4 bps

## Session Log
### Session 1 (2026-02-19)
**Done:**
- Reviewed PDF executive summary, identified 11 critical/significant flaws
- Designed zero-cost architecture using Jupiter public API
- Built Phase 1 scanner: config, types, scanner, logger, main loop
- Fixed SOL mint address (46→43 chars)
- Switched API from dead `quote-api.jup.ag` to `public.jupiterapi.com`
- Added pre-fee price extraction from routePlan
- Verified: 43 quotes/cycle, -2bps closest gap

### Session 2 (2026-02-19)
**Done:**
- Pivoted strategy from stablecoin/LST pairs to long-tail token discovery
- Built token discovery engine using Jupiter + DexScreener (free APIs)
- Added rate limiter module, WatchlistToken types, discovery logging
- Implemented paginated discovery (200 candidates per 10-min cycle)
- Fixed DexScreener DEX name mapping (meteora → Meteora DLMM)
- Cached Jupiter token list to disk (24h TTL, avoids re-downloading 287K tokens)
- Rewrote main loop: discovery cycle (10min) + scan cycle (60s)
- Verified: 15 tokens discovered, 3 DEXes each, 39 quotes/cycle, -5bps closest gap
- Created new files: discovery.ts, rate-limiter.ts

**Next Steps:**
1. Run `npm start` and let discovery build up the watchlist over multiple cycles
2. Monitor for gaps ≥50bps — these could appear on less-liquid tokens or off-peak hours
3. Configure Telegram for real-time alerts if desired
4. If consistent gaps appear, build Phase 2 dry-run simulation

### Session 3 (2026-02-20 to 2026-02-21)
**Done:**
- Collected 15+ opportunities over 2 days (JUP×9, JTO×2, KMNO×1, GP×2, Bonk×1)
- Fixed Jupiter API throttling: scan interval 60s→120s, added 3-min backoff on 0 quotes
- Fixed Telegram retry logic (retry once + 2s delay + 10s timeout)
- Migrated bot to WSL/Ubuntu + tmux for 24/7 uptime
- Built Phase 3 execution engine: wallet.ts, executor.ts
- Added EXECUTION_CONFIG (50bps min, 5 USDC max, 3 trades/hr, stuck recovery)
- Handled compromised private key incident (user created new wallet)
- Added Helius RPC (free tier, 1M credits) for reliable tx submission
- USDC bootstrap: auto-swapped 0.05 SOL → $4.29 USDC
- Bot is LIVE and scanning with execution enabled
- New files: wallet.ts, executor.ts
- Modified: config.ts, types.ts, index.ts, scanner.ts, logger.ts

**Status:** Bot running on WSL tmux. Executor initialized. Waiting for ≥50 bps opportunity to auto-execute.

### Session 4 (2026-02-21)
**Done:**
- Fixed executor error handling: outer try-catch in signAndSend, top-level try-catch in executeLeg
- Added bootstrap retry logic (2 attempts with 5s delay)
- Topped up USDC: 0.05 SOL → $4.29, then 0.15 SOL → $12.89 more, total $17.18
- Added auto-refuel: swaps $1 USDC→SOL when SOL drops below 0.02 (in preflightChecks)
- Lowered discovery filters: minDailyVolume $50K→$20K, minLiquidityUsd $10K→$5K (watchlist 16→20 tokens)
- Removed trade-per-hour limit (set to Infinity), reduced cooldown 60s→10s
- Implemented percentage-based trade sizing: 80% of USDC balance, $15 hard cap
- Updated reQuoteAndValidate to use tradePercentage dynamically
- Modified: executor.ts, config.ts

**Status:** Bot running. SOL: ~0.09, USDC: $17.18. Trade size: min(80% × balance, $15) = ~$13.74. Waiting for ≥50 bps opportunity.

### Session 5 (2026-02-21)
**Done:**
- Completed percentage-based trade sizing fix in `reQuoteAndValidate`
- Removed $15 hard cap — re-quote validation, price impact, and slippage are sufficient safety
- Upgraded to 100% sizing with $1 USDC refuel reserve: `(balance - $1) × 100%`
- Swapped 0.06 SOL → USDC via bootstrap (temporarily adjusted params, then reverted)
- Lowered discovery filters: minDailyVolume $20K→$10K, minLiquidityUsd $5K→$2K
- Reduced scan interval 120s→60s for faster opportunity detection
- Attempted removing `onlyDirectRoutes` — caused phantom opportunities ($912K fake profit on WBTC from multi-hop routing differences). All re-quotes showed negative bps. Reverted immediately
- Watchlist grew from 20→48 tokens, 87 quotes/cycle
- Phoenix and Lifinity V2 already configured in config.ts (no changes needed)
- 70+ scan cycles completed, 0 executions — market gaps consistently below 50 bps
- Modified: executor.ts, config.ts, scanner.ts (reverted), PROJECT_BRAIN.md

**Status:** Bot running. SOL: ~0.03, USDC: $22.36. Trade size: (balance - $1) × 100% = ~$21.36. 48 tokens, 87 quotes/cycle, 0 opportunities. Market is tight.
