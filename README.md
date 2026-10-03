# PhoneGuard

Offline-first Android diagnostic. It reports what this app process can actually read. It does not invent a clean bill for areas Android blocks.

## What a scan can verify

- This device model, API level, physical-device vs emulator
- Battery level, charge state, low-power mode
- Active network type (not who owns the traffic)
- This app's own documents and cache: size, large files, name+size duplicates
- A folder you explicitly pick with the system folder picker
- Deletes only after a confirmation modal
- Own-cache clear only

## What stays unverified

These are labeled `Not accessible` or `Needs your action`. They are excluded from the health score.

- Full installed-app list and other apps' permission grants (`QUERY_ALL_PACKAGES` is blocked in app.json)
- VPN owner, per-app destinations, accessibility services, device admins, overlay grants, notification listeners
- Root, bootloader lock, verified boot
- Battery cycle count / health grade
- Play Integrity (needs Google network; left off on purpose)
- Other apps' Android/data and silent shared-storage sweeps

The Access tab opens the real Android settings screens. Opening one does not mark that area clear.

## Run on the phone

```bash
cd PhoneGuard
npm install
npx expo start
```

Open the project in Expo Go on the Android phone. Scan from the Score tab.

Personal files are not uploaded. `uploadPersonalFiles` is forced off in settings and in app.json extra.

Package id: `com.kysmindset.phoneguard`
