# Wallet Profit Mobile

Android-first Capacitor application that reuses the desktop HTML/JavaScript pages while replacing
Electron IPC with a mobile `window.api` bridge.

## Architecture

- **Shared UI:** copied from `../src/render` during every mobile build.
- **Shared cloud data:** individual Supabase Auth accounts use the single revisioned company snapshot.
- **Offline cache:** the most recent snapshot and local edits are stored in Android WebView IndexedDB.
- **Conflict safety:** revision checks stop one device from silently replacing newer cloud data.
- **Native features:** Capacitor Browser, Filesystem, and Share handle external links and files.
- **Desktop remains unchanged:** Electron continues using local SQLite and synchronizes the same cloud snapshot.

Toters order-detail synchronization remains centralized on desktop. Mobile receives the resulting
transactions, sales, products, supplier assignments, and reports through shared cloud sync. Mobile
can perform wallet transaction sync directly over HTTPS.

## Implemented mobile features

- Individual cloud sign-in/sign-out
- Initial upload/download and automatic sync every two minutes
- Offline order reconciliation, totals, filters, and supplier summary
- Supplier, order-cost, line-cost, payment, product, and company-expense edits
- Products, transactions, settlements, revenue dashboard, and database viewer pages
- Multi-supplier order bills with WhatsApp, Excel, HTML, copy, and print actions
- JSON backup/restore, CSV import/export, Excel product/report import/export
- Native Android share sheet and file cache
- Responsive phone layout, safe areas, horizontal tables, and secondary-page back navigation
- Offline Chart.js bundle

## Requirements

- Node.js 22 or newer
- JDK 17 or newer
- Android SDK 36
- The Supabase migration in `../supabase/migrations/20260715_wallet_profit_cloud.sql`
- Approved users created in Supabase Authentication, with public sign-ups disabled

## Development

```bash
cd mobile
npm install
npm test
npm run cap:sync
npm run cap:open
```

`npm run cap:sync` rebuilds `www/`, injects the mobile bridge into every shared HTML page, bundles
Chart.js/XLSX for offline use, and updates the Android native project.

Build a debug APK:

```bash
cd mobile/android
./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

## First-device setup

1. Install the app and open **Data → Cloud account**.
2. Sign in with an approved individual team account.
3. On the primary device, use **Sync now** only if the cloud is empty.
4. On additional devices, select **Download cloud** on the first sync.
5. Normal changes upload automatically; manual sync remains available in the Data menu.

## Release signing

The Android build supports private release signing without committing secrets:

1. Create an Android keystore.
2. Copy `android/keystore.properties.example` to `android/keystore.properties`.
3. Fill in the private keystore path and passwords.
4. Run `./gradlew bundleRelease` to produce an Android App Bundle.

Keystores and `keystore.properties` are ignored by Git.

## Security notes

- The database password and Supabase service-role key must never be bundled.
- The publishable key is protected by Supabase Auth and Row Level Security.
- Android cleartext HTTP and mixed WebView content are disabled.
- Android system backup is disabled because the cache contains business and customer data.
- A local IndexedDB safety snapshot is created before replacing local data from the cloud.
