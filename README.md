# Trade Review

A private desktop app for reviewing your own FUTU trading. It pulls your fills, orders, and funds
from the FUTU **OpenD** gateway running on your own computer, reconstructs each **trade**, and scores
it — R-multiple, risk, MAE/MFE, position size as a % of your account, and behavioural **flags**
(added-to-loser, cut-winner-early, wide-stop, …) — then shows it all in per-trade charts, open
positions, and a weekly journal.

Everything runs and stays **on your computer**. There is no server, no cloud, no login, no account.
The app binds to `127.0.0.1` (your machine only) and opens in your web browser.

---

## Setup (about 10 minutes, once)

You need two things: **OpenD** (FUTU's gateway — provides the data) and **Trade Review** (this app —
reviews it). Set up OpenD first.

### 1. Install and start OpenD

OpenD is FUTU/moomoo's official OpenAPI gateway. Trade Review talks to it locally to read your trade
history — it never has your FUTU password.

1. Download **OpenD** from FUTU/moomoo's OpenAPI page and install it (see FUTU's own OpenD guide for
   your platform).
2. Start OpenD and **log in with your FUTU account**.
3. In OpenD's settings, note two things you'll paste into Trade Review:
   - the **port** it listens on (default **33334**), and
   - the **WebSocket key** (a password you set in OpenD to protect the connection).
4. Leave OpenD running whenever you want to sync. (No OpenD running = Trade Review opens fine but
   "Sync" will fail.)

### 2. Install Trade Review

Download the file for your computer from the **[Releases page](https://github.com/keithzrc/trade-review/releases)**:

| Your computer | Download | First launch |
| --- | --- | --- |
| **Windows** | `trade-review-windows-x64.exe` | Windows may show "Windows protected your PC" (the app isn't code-signed). Click **More info → Run anyway**. |
| **Mac (Apple Silicon** — M1/M2/M3/M4, most Macs since 2020**)** | `trade-review-macos-arm64.zip` | Unzip, then: macOS may say it "cannot verify the developer". Double-click once (it'll be blocked), then go to **System Settings → Privacy & Security**, scroll to the message about Trade Review, and click **Open Anyway**. (On older macOS you can instead right-click the app → **Open**.) |
| **Mac (Intel)** | `trade-review-macos-x64.zip` | Same as above. Not sure which Mac you have? Apple menu → **About This Mac**: "Apple M…" = Apple Silicon, "Intel" = Intel. |

The download is a single self-contained file — there is nothing to install and no other dependencies.

> The unsigned-app warnings are expected: code-signing certificates cost money and this is a personal
> tool. The app is just a local web server — it makes no outbound connections except fetching public
> price candles for the charts.

### 3. Connect Trade Review to OpenD

1. **Double-click** Trade Review. Your browser opens to the app (at `http://127.0.0.1:8123`).
2. Make sure **OpenD is running and logged in**.
3. In Trade Review, open **Settings** (left sidebar).
4. Enter the **OpenD port** (default 33334) and the **WebSocket key** you set in OpenD, then **Save**.
5. Click **Sync now** (top-right). Your trades load. Done.

---

## Everyday use

- **Start**: launch OpenD (log in), then launch Trade Review, then click **Sync now**.
- **Quit**: click the **power button** (top-right). This stops the app cleanly — closing the browser
  tab alone does *not* stop it.

Your key and all your data live only on this computer, in your user data folder:

- **Windows**: `%APPDATA%\TradeReview`
- **macOS**: `~/Library/Application Support/TradeReview`
- **Linux**: `~/.local/share/TradeReview`

The app makes a backup of its database before every launch.

## Updates

When a newer version is released, Trade Review shows a banner at the top: **"Trade Review X.Y.Z is
available"**. Click **Download** to get the new build for your computer from the Releases page, then
install it the same way you did the first time (replace the old app / run the new `.exe`). The app
never changes itself — you're always in control of when to update. Dismiss the banner and it won't
reappear until an even newer version ships.

## Troubleshooting

| Problem | Likely cause |
| --- | --- |
| **Sync failed** right after clicking Sync | OpenD isn't running / not logged in, or the key or port in **Settings** doesn't match OpenD. |
| App opens but shows no trades | You haven't synced yet — click **Sync now** (after connecting in Settings). |
| Nothing opens when I double-click | It may already be running — check `http://127.0.0.1:8123` in your browser. |
| Charts are blank for old trades | Public price history for that symbol/date isn't available; the rest of the review still works. |

---

## Building from source (for developers)

Requires [Bun](https://bun.sh).

```bash
bun install
bun run src/app.ts          # run in dev (frontend hot-reloads; backend needs a restart)
bun test                    # tests
bunx tsc --noEmit           # typecheck

# Build a standalone binary for one target (output in dist/):
bun run build               # current platform (+ a Trade Review.app on macOS)
bun run build windows-x64   # cross-compile a Windows .exe
bun run build darwin-arm64  # Apple Silicon
bun run build darwin-x64    # Intel Mac
```

> The Windows **hidden-console** build (`--windows-hide-console`) only takes effect when compiling
> *on* Windows, so release `.exe`s are built on a Windows CI runner.

See [`CLAUDE.md`](CLAUDE.md) for architecture and the contribution workflow.
