# Fleet Driver APK — Extraction Report

**Source:** `com.clicksolutions.fleetdriver-8LIzaegMtqsHagxv-sJ2Xw==/` (split-APK install pulled from device)
**Generated:** 2026-08-16 · from `base.apk` + `split_config.*` (no source code was available)

---

## 1. App identity & what shipped

| Field | Value |
|---|---|
| App name | **Fleet Driver** |
| Package | `com.clicksolutions.fleetdriver` |
| Version name | **1.0.7** |
| Version code | **18** |
| OTA runtime version | **1.0.4**  ⚠️ (differs from app version — see §4) |
| iOS build number | 9 |
| Expo SDK | 54.0.0 |
| min / compile SDK | 24 / 36 |
| JS engine | Hermes |
| UI stack | React Native (new arch) + Jetpack Compose + Material3 |
| EAS project ID | `e6e4f790-e93f-4924-81ed-07693de136a7` |
| Splash / brand color | `#2563eb` |

**Install shape:** this is a split-APK / AAB install, not a single universal APK:
- `base.apk` — code, JS bundle, resources, manifest
- `split_config.arm64_v8a.apk` — native libraries (arm64 only)
- `split_config.en.apk` — English strings
- `split_config.xxhdpi.apk` — xxhdpi density resources
- `base.dm` — dex metadata / baseline profile (ART startup optimization)

Signing: **v2/v3 scheme only** (no v1 `META-INF/*.RSA`), so the signer cert lives in the APK Signing Block and isn't extractable with unzip/keytool alone (needs `apksigner verify --print-certs`).

---

## 2. What the app does (confirmed from bundle strings)

A **driver-facing delivery / fleet app**. Screens & features found:
- `DashboardScreen`, **Current Trip / Active Trip / No Active Trip**, **Assignments**
- **Vehicle inspection photos** — "Front View", "Side View", "Passenger View", "Driver's View", "Signs ON – Driver's View"
- **Proof of Delivery** — "DDU Proof of Delivery", "Take a photo of the Proof of Delivery"
- **Call Dispatch** (WebRTC voice/video — `libjingle_peerconnection`, 11 MB native lib)
- Barcode/QR scanning (ML Kit — `libbarhopper_v3`, `mlkit_barcode_models/*.tflite`)
- Background GPS trip tracking (foreground service + task manager)
- Push notifications channel `trip-updates`
- Offline/local storage via **Room + SQLite**

---

## 3. Endpoints & external hosts (from JS bundle)

**Backends / APIs:**
- `https://bzgroup.mk/api…` — referenced via an `API_BASE_URL`-style config
- `https://fleet-managment-system-production.onrender.com/api…` — **second backend** (Render.com). ⚠️ Note the host is **misspelled "managment"** — confirm which of the two is the live production API.

**Support / content pages (in-app links):**
- `https://clicksolutions.bz/driver-guide`
- `https://clicksolutions.bz/faq`

**Placeholders still shipping — should be replaced before store review:**
- `https://yourcompany.com/privacy-policy`
- `https://yourcompany.com/terms-of-service`

**Infra (expected, benign):** `u.expo.dev/<projectId>` (OTA), `exp.host/--/api/v2/push/*`, `classic-assets.eascdn.net`.

Websocket / realtime references present (`wss://`, `baseUrl` ×11) — consistent with dispatch calling + live trip updates.

---

## 4. OTA update configuration & mismatch check

| Setting | Value |
|---|---|
| Updates enabled | `true` |
| Update URL | `https://u.expo.dev/e6e4f790-e93f-4924-81ed-07693de136a7` |
| Check on launch | `ALWAYS` |
| Launch wait timeout | 5000 ms |
| **Runtime version** | **`1.0.4`** |
| Embedded update ID | `64c9e430-8178-4d63-8af0-4f0a7f32635b` |
| Embedded update commit time | **2026-08-08 01:52 UTC** |
| Bundled assets | 41 |
| Update code-signing root | Expo Root Certificate (Expo default) |

**⚠️ OTA mismatch guidance:** OTA updates only reach this build if they are published to **runtimeVersion `1.0.4`** (not `1.0.7`, the app version). If drivers aren't getting updates, verify your EAS publish targets runtime `1.0.4` and the correct channel/branch. The app version (1.0.7) and runtime (1.0.4) are intentionally decoupled — that's normal in Expo, but it's the #1 cause of "update didn't apply."

---

## 5. Permissions audit

**Dangerous / runtime permissions:**
- `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, **`ACCESS_BACKGROUND_LOCATION`**
- `CAMERA`, `RECORD_AUDIO`
- `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`
- `POST_NOTIFICATIONS`

**Normal / signature:** `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `WAKE_LOCK`, `VIBRATE`, `RECEIVE_BOOT_COMPLETED`, `MODIFY_AUDIO_SETTINGS`, **`SYSTEM_ALERT_WINDOW`**, `READ_APP_BADGE`.

**Notes for Play review:**
- `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION` require the **Play prominent-disclosure + background-location review** and a demo video. Have that ready.
- `WRITE_EXTERNAL_STORAGE` is a no-op on Android 13+ (API 33+); harmless but removable.
- `SYSTEM_ALERT_WINDOW` (draw-over-other-apps) draws scrutiny — confirm a feature actually needs it (likely incoming-call overlay). Remove if unused.
- ~25 launcher **badge-count** permissions (Samsung/HTC/Huawei/Oppo/Sony/etc.) are auto-added by the notifications lib — benign.
- `allowBackup="true"` — default; consider `false` if trip/PII data shouldn't land in cloud/adb backups.
- `debuggable` is **not** set (good).

---

## 6. Secrets / credential exposure — ⚠️ verify

**No hardcoded secrets found** in the JS bundle or resources: no Google `AIza…` key, no Firebase app-id value, no JWT, no Stripe/AWS/Slack tokens, no private keys. ✅

But two **native Google configs are empty/absent** — verify these features actually work in production:

1. **Google Maps API key is EMPTY** in the manifest:
   `com.google.android.gms.maps.v2.API_KEY = ""` (and the legacy `maps.v2.API_KEY = ""`).
   → If any screen uses the Google Maps provider, it will show a blank/grey map on Android. Confirm maps render, or supply the key.

2. **No google-services / Firebase values embedded.** The resource *names* `google_app_id` and `gcm_defaultSenderId` are referenced, but **no real value** (`AIza…`, `1:<sender>:android:<hash>`) exists anywhere in the APK.
   → FCM/remote push may not be configured for this build. Local notifications will still fire, but **server-sent push via Firebase likely won't deliver.** Verify a real device receives a push, or wire up `google-services.json` at build time.

---

## 7. Key libraries / native components

**Native libs (arm64):** `libhermes` (JS), `libreactnative`, `libreanimated`, `libworklets`/`librnworklets`, `librnscreens`, `libjingle_peerconnection` (WebRTC, ~11 MB), `libbarhopper_v3` (ML Kit barcode), `libexpo-av`, `libexpo-modules-core`, `libgesturehandler`, Fresco image pipeline (`libimagepipeline`, `libstatic-webp`, `libgifimage`).

**Android SDKs:** Expo SDK 54, Compose 1.9 / Material3 1.3.2, CameraX 1.5.0-rc01, Room 2.6.1 + SQLite 2.4, WorkManager 2.7.1, Navigation 2.9, Firebase Messaging, Kotlin Coroutines 1.10.1.

**RN/Expo modules (from bundle):** expo-location, expo-camera, expo-image-picker, expo-av, expo-maps, expo-notifications, expo-task-manager, expo-font, react-native-webrtc, react-native-reanimated, react-native-gesture-handler, react-native-screens, react-native-safe-area-context, @react-navigation, canhub image cropper.

---

## 8. Recommended next steps (prioritized)

1. **Fix legal URLs** — replace `yourcompany.com/{privacy-policy,terms-of-service}` with real Click Solutions URLs before any store submission.
2. **Confirm the production API** — bundle references both `bzgroup.mk/api` and the `onrender.com` host (with a **typo**). Decide which is authoritative and remove the dead one.
3. **Verify FCM push** — no google-services values shipped; test real push on a device or add `google-services.json`.
4. **Verify Google Maps** — API key is empty; confirm maps render on Android or add the key.
5. **OTA channel** — ensure EAS publishes to **runtime `1.0.4`** so updates actually reach 1.0.7 installs.
6. **Trim permissions** — reassess `SYSTEM_ALERT_WINDOW` and legacy `WRITE_EXTERNAL_STORAGE`; prepare background-location disclosure for Play review.
7. **Get the real signer cert** — run `apksigner verify --print-certs base.apk` to record the signing SHA-256 (v2/v3 only).
