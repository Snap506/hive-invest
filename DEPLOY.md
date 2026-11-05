# Deploying Hive Invest and connecting it to live markets

This takes about 20 minutes. Steps 1–6 get you a working app with live prices. Steps 7–11 are optional add-ons, and you can do them later. Everything here runs on Cloudflare's free plan.

---

## What you need

- A **Cloudflare account** (free): https://dash.cloudflare.com/sign-up
- **Node.js 20 or newer** on your PC: https://nodejs.org. Choose "LTS" and install with the defaults.
- This folder, unzipped somewhere easy to find, for example `Documents\hive-invest`.

To open a terminal in the folder on Windows, open the folder in File Explorer, right-click an empty space, and choose **Open in Terminal**. Every command below is typed there.

---

## 1 · Install the tools

```
npm install
```

This downloads Wrangler, Cloudflare's command-line tool, into the folder. It is the only dependency.

## 2 · Log in to Cloudflare

```
npx wrangler login
```

A browser window opens. Click **Allow**.

## 3 · Create the database

```
npx wrangler d1 create hive-invest
```

The output includes a line like `database_id = "1a2b3c…"`. Open `wrangler.toml` in Notepad and replace `PASTE-YOUR-DATABASE-ID-HERE` with that ID. Save the file.

## 4 · Create the tables

```
npm run db:init
```

Answer **y** when it asks.

## 5 · Choose your passcode

```
npx wrangler secret put APP_TOKEN
```

Paste a long passcode, at least 20 characters. A password manager can make one for you. This passcode is what you type into the app to sign in, and Cloudflare stores it encrypted.

## 6 · Deploy

```
npm run deploy
```

The output ends with your app's address, something like `https://hive-invest.<your-name>.workers.dev`.

1. Open the address and sign in with your passcode.
2. Go to **Setup → Live connections**. These five should each show a ✓:
   - VALR BTC/ZAR price
   - Bitstamp BTC/USD price
   - Bitstamp daily history
   - Rand per dollar
   - CoinGecko research
3. The pill at the top should say **Live · VALR**.

**At this point the app is live.** Prices refresh every 20 seconds while the app is open, and every 10 seconds while a ticket is open. The server checks the trading rule every morning at 08:05 SA time.

On your phone, open the address in Chrome or Safari and choose **Add to Home screen**. It then opens like an app.

---

## 7 · Lock the site to your email (recommended)

The passcode already protects your data. Cloudflare Access adds a second lock: nobody can even load the page without a code sent to your email.

1. In the Cloudflare dashboard, go to **Workers & Pages → hive-invest → Settings → Domains & Routes**.
2. Next to `workers.dev`, click **Enable Cloudflare Access**.
3. Under **Manage Cloudflare Access**, edit the policy so it allows only your email address.

The daily check still runs, because scheduled runs are not affected by Access.

## 8 · Telegram alerts (recommended)

With this set up, the server messages you only when there is something to do: a buy, a sell, the new month's money, or a rebalance.

1. In Telegram, open **@BotFather**, send `/newbot`, and follow the prompts. It gives you a **token**.
2. Open your new bot and send it any message, for example `hi`.
3. In a browser, open `https://api.telegram.org/bot<TOKEN>/getUpdates`, replacing `<TOKEN>` with your token. Find `"chat":{"id":123456789` in the result. That number is your **chat ID**.
4. Add both as secrets:
   ```
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```
5. In the app, go to **Setup → Send test message**.

## 9 · Claude answers (optional, capped)

1. Go to https://console.anthropic.com, create an API key, and set a monthly spend limit there as well (for example $5).
2. Add the key:
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
3. The app also enforces its own cap: `CLAUDE_MONTHLY_USD = "2"` in `wrangler.toml`. After changing it, run `npm run deploy`.

Each answer costs about $0.0005. The Ask box is on the Trading tab.

## 10 · VALR balances, read-only (optional)

This lets the app and the daily check read your real trading-account balances instead of what you typed in.

1. Optional but tidy: on VALR, create a **subaccount** called "Trading" and keep only the trading account's money there.
2. On VALR, go to **Account → API Keys → Create** and tick **View only**. **Do not tick Trade, Transfer or Withdraw.** Leave the IP whitelist empty, because Cloudflare's addresses change.
3. Add the key and secret:
   ```
   npx wrangler secret put VALR_API_KEY
   npx wrangler secret put VALR_API_SECRET
   ```
   If the key belongs to your main account but should read the subaccount, also run:
   ```
   npx wrangler secret put VALR_SUBACCOUNT_ID
   ```
4. In the app:
   - On the **Trading** tab, tap **Read from VALR**.
   - In **Setup**, tick *"The daily check reads the trading account from VALR"*.

## 11 · CoinGecko key (optional)

The research tab works without a key. A free Demo key (https://www.coingecko.com/en/api) gives higher limits:

```
npx wrangler secret put COINGECKO_API_KEY
```

## 12 · Load the price history (one minute)

This gives the **History** tab years of daily prices to analyse:

| Item | What's loaded | Back to | Source |
|---|---|---|---|
| Bitcoin | Bitcoin | 2014 | Bitstamp |
| Ether | Ether | 2017 | Bitstamp |
| Global shares | Vanguard Total World fund (VT) | 2014 | Yahoo |
| SA shares | Satrix 40 | 2014 | Yahoo |
| SA bonds | Satrix SA Bond | 2014 | Yahoo |
| Rand per dollar | Exchange rate | 2014 | ECB |

1. In the app, go to **History → Fetch the history**.
2. Each source should get a ✓. After that, the server adds each new day every morning.

If a source shows ✕, the provider is refusing Cloudflare's servers. Yahoo sometimes does this. Fill it once from your PC instead, from this folder:

```
# Windows (PowerShell)
$env:APP_TOKEN="your-passcode"; npm run backfill -- https://hive-invest.<your-name>.workers.dev

# Mac / Linux
APP_TOKEN=your-passcode npm run backfill -- https://hive-invest.<your-name>.workers.dev
```

The script fetches the data over your home internet and sends it to your app. To do only some series, add their names at the end, for example `... workers.dev sa bonds`.

**Updating from the first version:** run `npm run db:init` to add the history tables, then `npm run deploy`.

## 13 · Automatic deploys from GitHub (recommended)

Once this is set up, every push to the `main` branch deploys the app. You no longer run `npm run deploy` yourself.

Do steps 3 and 5 first, and make sure the real `database_id` is saved in `wrangler.toml` and pushed to GitHub. The ID is not a secret.

1. Push this folder to a GitHub repository (a private one is fine).
2. In the Cloudflare dashboard, go to **Workers & Pages → hive-invest → Settings → Build**. Under **Git repository**, click **Connect** and choose your repository. GitHub asks you to allow Cloudflare access to it.
3. Set:
   - **Production branch:** `main`
   - **Build command:** `npm test`
   - **Deploy command:** `npm run deploy:ci`. This applies any new database migrations, then deploys.
   - **Non-production branch deploy command:** `npx wrangler versions upload`. Other branches then get a preview version without replacing the live app.
4. Push a change and watch it build under **Deployments**.

Secrets (`APP_TOKEN`, Telegram, VALR, and so on) stay in Cloudflare. They are never put in GitHub, and a deploy leaves them unchanged.

GitHub also runs the tests on every push (`.github/workflows/ci.yml`), so a pull request shows a ✓ or ✕ before you merge it.

---

## Checklist before using real money

- [ ] Setup → Live connections: all core sources show ✓
- [ ] Setup → **Run it now** shows the rule, today's VALR price, and your account
- [ ] The Telegram test message arrived
- [ ] Your plan in Setup is right: R3,000 a month, +R3,000 a month each year, and the start date
- [ ] The Main tab shows your real holdings, entered from your statements
- [ ] The trading account has a small amount to start, for example R500–R1,000

## How to roll it out

| Phase | What happens | Move on when |
|---|---|---|
| **1 · Watch** (weeks 1–4) | Real prices, real signals, and small real amounts. You place every order yourself and log it. | Four weeks without a wrong number or a missed alert |
| **2 · Build** (months 2–12) | The full monthly plan goes in. The trading account grows by its share every month. | A year of plan followed |
| **3 · Automate** (later, separate) | Placing orders automatically would need a Trade-permission key on a capped subaccount, a daily spend limit, and a kill switch. **It is deliberately not included here.** Add it only after phase 2, and only if you still want it. | — |

---

## Everyday commands

| Task | Command |
|---|---|
| Deploy a change | Push to `main` on GitHub (step 13), or `npm run deploy` by hand |
| Watch the server live | `npm run logs` |
| Run the tests | `npm test` |
| Run locally | Copy `.dev.vars.example` to `.dev.vars`, run `npm run db:init:local`, then `npm run dev`, then open http://localhost:8787 |
| Back up your data | Setup → **Download my data** |
| Fill the history from your PC | `npm run backfill -- <your app address>` (step 12) |

## If something is wrong

| You see | Fix |
|---|---|
| "The server has no passcode yet" | Do step 5, then reload the page |
| Deploy fails mentioning `database_id` | Step 3: paste the ID into `wrangler.toml` |
| "That passcode is not right" | Re-run step 5 to set a new passcode |
| VALR ✕ "answered 401" | The key or secret is wrong, or the key has an IP whitelist. Make a new View-only key. |
| Bitstamp ✕ | Nothing to do. History switches to CoinGecko automatically and a banner says so. |
| "Delayed" pill | A price source is slow. The last good price stays on screen, and the app retries with growing gaps. |
| No Telegram messages | Use Setup → Send test message. Messages only come when there is an action. |
| History ✕ for a source | Fill it from your PC (step 12). The rest of the app is unaffected. |
| "Exceeded CPU" in the logs | The free plan allows 10 ms of processing per request. The app is built to stay under that, but Workers Paid ($5 a month) raises the limit if it ever trips. |

## What it costs

| Item | Cost |
|---|---|
| Workers (100,000 requests a day), D1 (5 GB), the daily schedule | Free |
| Telegram | Free |
| Claude | Capped at $2 a month by default |
| Custom domain (optional) | About R200 a year |
