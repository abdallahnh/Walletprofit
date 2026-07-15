# Wallet Profit (Electron + SQLite)

## 1) You do NOT need Electron installed globally
Electron is installed *inside this folder* when you run `npm install`.

## 2) What you need (one-time)
- Node.js 18+ (includes npm)
  - macOS: install Node from https://nodejs.org (LTS) or `brew install node`
  - Windows: install Node from https://nodejs.org (LTS)

## 3) Run (macOS / Linux)
Open Terminal in this folder and run:
- ./run.sh

## 4) Run (Windows)
Open PowerShell (or CMD) in this folder and run:
- run.cmd

## 5) Build installers
- macOS: ./build.sh  (creates dist/*.dmg)
- Windows: build.cmd (creates dist/*installer*.exe)

## 6) Using the app
1) Sync wallet data from the API, or import TSV/CSV wallet rows
2) Assign suppliers and enter supplier cost per order (optional)
3) Mark Paid (optional)
4) Export CSV (orders) or Export Data (full database backup)

## 7) Where data is stored
A SQLite DB is created automatically in your user app data folder:
- macOS: ~/Library/Application Support/ANWallet/wallet-profit.sqlite
- Windows: %APPDATA%\\ANWallet\\wallet-profit.sqlite

Older installs may have used:
- macOS: ~/Library/Application Support/Wallet Profit/
- Windows: %APPDATA%\\Wallet Profit\\

The app auto-migrates from older folders on first launch if the new database is empty.

## 8) Upgrading without losing data
**Installing a new version does NOT delete your database.** Data is stored outside the app install folder.

Before upgrading, ask your ops manager to:
1. Open the old app → **Data → Export Data** (saves a `.db` backup file)
2. Install the new version
3. Open the new app → **Data → Import Data** (restores everything)

Or copy the database file manually from the paths above.

## 9) Mobile (Android — planned)
A separate Capacitor project lives in `mobile/` and does **not** affect the Mac/Windows Electron build. See [mobile/README.md](mobile/README.md) for architecture, offline SQLite, and export/import between phone and desktop.

**Export CSV** saves order reconciliation (supplier costs, paid flags). **Import Orders CSV** restores those values.
**Export Data** saves the entire database (recommended for laptop-to-laptop moves).

## 10) Shared cloud data (Supabase)

The desktop app keeps SQLite for offline use and synchronizes a versioned snapshot with Supabase.
Each teammate signs in with an individual Supabase Auth account, while authenticated team members
share the same company dataset.

One-time administrator setup:

1. Open Supabase Dashboard → SQL Editor.
2. Run `supabase/migrations/20260715_wallet_profit_cloud.sql`.
3. In Authentication settings, disable public user sign-ups.
4. In Authentication → Users, create an email/password account for each approved teammate.
5. On the primary computer, open Data → Cloud account, sign in, and click **Sync now** to upload
   the existing local database.
6. On each additional computer, sign in and choose **Download cloud** for its first sync.

After the first sync, the app checks the shared data automatically every two minutes. Data remains
usable offline. When two computers both change from the same revision, the app blocks silent
overwrites and asks the user to explicitly download the cloud version or replace it. A local SQLite
safety backup is created automatically before every cloud download.

Never put the Supabase database password or service-role key in the application. The bundled
publishable key is used only with authenticated sessions and Row Level Security.
