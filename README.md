The Cellar Lyceum: Taster's Lexicon & Wine Snap. A gift for John & Craig Darling.

## Server (Supabase function `swift-action`)
- Code: `supabase/functions/swift-action/index.ts`. Every change pushed to `main` is deployed automatically by `.github/workflows/deploy-function.yml` (needs the `SUPABASE_ACCESS_TOKEN` repository secret).
- Settings: `server/config.json` (AI prompts, extra AI requests, storage areas, limits). The server re-reads it every 5 minutes, so edits here need no deploy.
- Status: tap the "cellar" wordmark 5 times in the app.
