# Fleet Driver — Security & Architecture Audit

**App:** Fleet Driver `com.clicksolutions.fleetdriver` v1.0.7 (versionCode 18)
**Stack:** Expo SDK 54 · React Native (New Architecture, Hermes) · minSdk 24 / targetSdk 36
**Scope:** Static analysis of the shipped split-APK (decompiled DEX → Java, Hermes bytecode → pseudo-JS). No source or running backend was available, so backend-side controls are out of scope — findings are what the *client* reveals.
**Prepared for:** the Click Solutions dev team. Audit date 2026-08-16.

> Method note: JS findings come from Hermes bytecode, which preserves all string literals and original function names but not original source. Control-flow-level claims are marked **(inferred)**; string/endpoint/manifest claims are **(observed)**.

---

## Executive summary

The app is a conventional, reasonably-built Expo/RN driver app. No hardcoded API secrets, no logged auth tokens, and the release is correctly non-debuggable with cleartext blocked by default. The material issues are **data-at-rest** (bearer token in plaintext AsyncStorage + `allowBackup=true` with no backup rules), **update integrity** (OTA bundles are not code-signed), **transport hardening** (no certificate pinning), and a set of **release-hygiene** items (dev-mode/localhost switcher, Compose tooling activity, over-broad legacy permissions, verbose PII logging, placeholder URLs, empty Google Maps/Firebase config).

### Findings ranked

| # | Finding | Severity | Area |
|---|---|---|---|
| 1 | Auth bearer token stored in **plaintext AsyncStorage** (no SecureStore/Keystore) | **High** | Data at rest |
| 2 | `allowBackup="true"` with **no** `dataExtractionRules`/`fullBackupContent` → token/PII exfil via `adb backup` | **High** | Data at rest |
| 3 | Expo **OTA updates not code-signed** (`CHECK_ON_LAUNCH=ALWAYS`) → remote JS push if EAS/channel compromised | **Medium** | Supply chain |
| 4 | **No TLS certificate pinning** anywhere | **Medium** | Transport |
| 5 | Runtime **dev-mode / localhost / manual-IP switcher ships in release**, persists across logout | **Medium** | Attack surface |
| 6 | `com.canhub.cropper.CropImageActivity` **exported=true** (no permission/filter) | **Medium** | Components |
| 7 | `SYSTEM_ALERT_WINDOW` + `RECORD_AUDIO` + WebRTC MediaProjection — verify need / disclosure | **Medium** | Permissions / privacy |
| 8 | `ACCESS_BACKGROUND_LOCATION` — Play prominent-disclosure + data-safety obligations | **Medium** | Privacy / compliance |
| 9 | Verbose **production logging of PII + Expo push token** (~237 trace statements) | **Low–Med** | Info leak |
| 10 | `androidx.compose.ui.tooling.PreviewActivity` exported in release (dev tooling leak) | **Low** | Release hygiene |
| 11 | Legacy `READ/WRITE_EXTERNAL_STORAGE` with no `maxSdkVersion` | **Low** | Permissions |
| 12 | Custom-scheme deep link `exp+fleet-driver-app` unvalidated; default task affinity | **Low** | Deep links |
| 13 | Hardcoded developer IPs + `driver@fleetmanager.com` + `yourcompany.com` placeholders in bundle | **Low** | Hygiene / info leak |
| 14 | Empty Google Maps API key & no Firebase/google-services values → maps/push likely broken | **Low** (functional) | Config |
| 15 | Two parallel HTTP layers (axios interceptor + hand-rolled `fetch`) — token attached in 3+ places | **Low** | Maintainability |

Positive: not debuggable; cleartext blocked by default (targetSdk 36, no `usesCleartextTraffic`, no permissive network-security-config); no secrets in the bundle; password is **not** persisted (only the token is); FileProviders correctly `exported=false` + per-URI grants with scoped paths.

---

## 1. Authentication & session

**Observed.** Login is email + password → `POST /auth/driver/login`. The auth state (`useAuthStore`, Zustand) is `{isAuthenticated, isLoading, driver, vehicle, token, error, requiresPasswordChange}`. A temporary-password flow exists (`ForceChangePasswordScreen`, `requiresPasswordChange`, `POST /driver/change-password`, min 8 chars). Refresh endpoint `POST /auth/refresh` exists.

**Token handling (observed):**
- Persisted to **AsyncStorage** under key `authToken` (logout does `AsyncStorage.multiRemove(['authToken','driver','vehicle'])`). **No `expo-secure-store`, Keychain, or EncryptedSharedPreferences anywhere in the app** (confirmed zero references in both the JS bundle and all DEX).
- Attached by an **axios request interceptor** (`setupInterceptors`/`getToken`): reads `authToken` from storage and sets `Authorization: Bearer <token>` on every request.
- **Response interceptor logs 401s but deliberately does not auto-logout** — trace: *"Preventing auto-logout in interceptor to allow stores to handle 401s gracefully."* Session-expiry handling lives in the stores (they clear storage and set "Session expired. Please login again." on `401`/`unauthorized`/`invalid token`). **(inferred)** Confirm every 401 path actually forces re-auth, since the central guard is intentionally disabled.
- Password is **not** stored (only `authToken`/`driver`/`vehicle` persist; `credentials`/`password` strings are fetch options and UI labels).

**Risk (#1, High):** AsyncStorage is an unencrypted SQLite/file in app-private storage — trivially readable on a rooted/compromised device, an emulator, or via backup (#2). A stolen bearer token = full driver-session impersonation until it expires.
**Recommend:** store the token (and any refresh token) in `expo-secure-store` (Android Keystore / iOS Keychain). Keep token TTLs short and ensure server-side refresh/rotation + revocation on logout.

## 2. Transport security

**Observed.** Production is HTTPS (`https://bzgroup.mk/api`, `https://fleet-managment-system-production.onrender.com/api`). **No certificate pinning** (zero `sslPinning`/`CertificatePinner`/`TrustManager` references). No `networkSecurityConfig` and no `usesCleartextTraffic` → on targetSdk 36 cleartext is blocked by default (good, and it means the dev-mode `http://localhost:3001` switch is effectively **inert in release** — see #5).

**Risk (#4, Medium):** without pinning, any device that trusts a rogue/enterprise CA (or a user-installed one) can MITM driver PII, location, and tokens.
**Recommend:** add certificate/public-key pinning for the production API and WebSocket hosts (e.g. `react-native-ssl-pinning` or an OkHttp `CertificatePinner` via a config plugin). Pin to a backup key to survive rotation.

## 3. Data at rest & backup

**Observed.** AsyncStorage holds `authToken`, `driver`, `vehicle`, `expoPushToken`, `deviceToken`, and the `@fleet_*` dev/env keys. Manifest sets `allowBackup="true"` with **no** `fullBackupContent`/`dataExtractionRules` present anywhere in the APK.

**Risk (#2, High):** `adb backup` (works without root on pre-Android-12 devices; minSdk here is 24) or cloud/device-transfer can extract the entire AsyncStorage store — including the bearer token — off-device.
**Recommend:** set `android:allowBackup="false"` (simplest for an app holding session tokens), or add `dataExtractionRules` + `fullBackupContent` that exclude the auth/token/location stores. Combine with #1 (SecureStore) for defence in depth.

## 4. OTA update integrity

**Observed.** `expo.modules.updates` enabled, `CHECK_ON_LAUNCH=ALWAYS`, 5 s wait, `EXPO_UPDATE_URL=https://u.expo.dev/e6e4f790-…`, channel `production`, **runtimeVersion `1.0.4`** (note: decoupled from app version 1.0.7 — publish OTA to runtime `1.0.4` or updates won't reach installs). **No code-signing** meta-data (`CODE_SIGNING_CERTIFICATE`/`_METADATA` absent).

**Risk (#3, Medium):** the JS bundle is fetched over TLS but not end-to-end signed; a compromised EAS account or channel could push arbitrary JS (full app logic) to every device on next launch.
**Recommend:** enable `expo-updates` code signing so the runtime rejects unsigned/tampered bundles; protect the EAS account with MFA; consider a less aggressive `CHECK_ON_LAUNCH`.

## 5. Developer mode / environment switcher

**Observed.** A full runtime environment system ships in the release bundle: keys `@fleet_api_environment`, `@fleet_developer_mode_activated`, `@fleet_localhost_preference`, `@fleet_manual_ip`; functions `switchToProduction/Localhost/DevelopmentIP`, `forceLocalhost`, `activateDeveloperMode`/`deactivateDeveloperMode`, `checkDevMode`; a settings section (`showDeveloperSection`, "Use Localhost (http://localhost:3001)", `DeveloperModeIndicator`). `updateEnvironment` rebuilds the axios instance's `baseURL` at runtime. **Dev/env keys are intentionally preserved across logout.**

**Risk (#5, Medium — lower in practice):** shipping a server-repointing/dev toggle in production is attack surface (point the app at a malicious/local server, capture credentials) and confuses support. In *this* build the `http://localhost`/IP targets are blocked by the cleartext default (#2 transport), which limits real exploitability — but that's an accident of config, not a control.
**Recommend:** strip developer mode from release builds (guard by `__DEV__`/build flavor), or at minimum hard-gate it behind a build-time flag and clear its keys on logout. Never let a production build repoint the API base URL from the UI.

## 6. Manifest, permissions & exported components

Full enumeration in the findings table; highlights:
- **`CropImageActivity` exported=true** with no permission/filter (#6, Medium) — any installed app can launch it. Override to `exported="false"`.
- **`PreviewActivity` (Compose tooling) exported in release** (#10, Low) — remove tooling from release.
- **Correction to a common assumption:** there is **no `https` App Link**. MainActivity handles only `MAIN/LAUNCHER` + the custom scheme `exp+fleet-driver-app`; the `https` VIEW intent appears only inside `<queries>` (package visibility), not as a handler. So no web-link hijack vector; the custom scheme is still unverifiable/spoofable — **validate all deep-link input in the RN linking handler** (#12).
- **Permissions:** `SYSTEM_ALERT_WINDOW`, `RECORD_AUDIO` + WebRTC `MediaProjectionService` (#7) and `ACCESS_BACKGROUND_LOCATION` (#8) are the ones to justify/disclose or remove. Legacy `READ/WRITE_EXTERNAL_STORAGE` should get `maxSdkVersion="32"` or be dropped (#11). ~20 OEM launcher-badge permissions are library bloat (vendor custom perms, not system `WRITE_SETTINGS`) — low risk, trimmable.
- **FileProviders** (`FileSystemFileProvider`, `ImagePickerFileProvider`, `CropFileProvider`) are all correctly `exported=false` + `grantUriPermissions` with scoped paths — **no issue**.
- **Signing:** v2/v3 scheme only; capture the signer SHA-256 with `apksigner verify --print-certs base.apk` for your release records.

## 7. Logging hygiene

**Observed.** ~237 emoji-tagged trace statements are compiled into the release bundle. They log full API responses ("Raw axios response", "Received updated driver data"), driver identifiers, and the **Expo push token** value to logcat. No logging of the auth token value was found.
**Risk (#9, Low–Med):** logcat is app-scoped on modern Android, but PII/push-token in logs still leaks to crash tools, adb sessions, and side-loaded log readers, and adds noise/perf cost.
**Recommend:** strip `console.*` in release (`babel-plugin-transform-remove-console`) or route through a level-gated logger that is silent in production.

## 8. Configuration gaps (functional, verify on-device)

- **Google Maps API key is empty** (`maps.v2.API_KEY=""`) → Google-provider maps render blank on Android.
- **No Firebase/google-services values** embedded (resource *names* exist, but no `AIza…` key or `1:…:android:…` app-id anywhere) → server-sent FCM push likely won't deliver (local notifications still work).
- **Placeholders in the shipped bundle:** `https://yourcompany.com/{privacy-policy,terms-of-service}`, a leftover `driver@fleetmanager.com`, and hardcoded dev IPs (`10.0.2.2`, `192.168.0.77`, `192.168.1.77/191`, `192.168.8.77`, `localhost:3001`, `ws://localhost:3001/ws`). Replace legal URLs before store review; strip dev IPs/emails from release.
- **Two backends + typo:** the Render host is spelled `fleet-managment-…` — confirm the authoritative production API and remove the dead one.

## 9. Architecture & dependencies (context)

**Architecture (observed).** Zustand stores (`useAuthStore`, `useTripStore`, `useMessageStore`); an `ApiService` on axios **plus** hand-rolled `fetch()` calls (e.g. notifications) that re-attach the token manually (#15 — consolidate onto one HTTP client/interceptor). Realtime via a `WebSocketService` (reconnect w/ backoff) carrying message types `trip_assignment`, `trip_unassignment`, `route_pre_assignment`, `route_confirmation`, `status_change`, `signs_proof_approved/rejected`, `general_notification`, `ping/pong`. Dispatch calling via **AWS Chime** (`/chime/meeting/…`) atop WebRTC. Background location via expo-location task `fleet-driver-location-task` at ~`timeInterval 300000ms (5 min)` / `distanceInterval 50m`, foreground-service-backed. Local persistence via **Room + SQLite** (offline support).

**Key dependency versions (observed from `META-INF/*.version` & native libs):** Compose 1.9 / Material3 1.3.2, CameraX 1.5.0-rc01, Room 2.6.1, WorkManager 2.7.1 (older than the rest — worth bumping), Navigation 2.9, Kotlin Coroutines 1.10.1, Firebase Messaging, ML Kit barcode (`libbarhopper_v3`), WebRTC (`libjingle_peerconnection`, ~11 MB), Fresco. React 19.1 / RN new architecture. **Action for the team:** run `npm audit` / `osv-scanner` against the real `package.json`/`package-lock` and Gradle deps — a static APK can't give authoritative transitive-CVE results. Note `apollographql` classes are present in DEX but no GraphQL endpoints were observed in the bundle → likely an unused transitive dep worth confirming/removing.

---

## Prioritized remediation checklist

**High**
- [ ] Move `authToken` (+ refresh token) to `expo-secure-store`; stop persisting session tokens in AsyncStorage.
- [ ] Set `allowBackup="false"` (or add data-extraction/backup rules excluding auth & location stores).

**Medium**
- [ ] Enable `expo-updates` code signing; enforce MFA on the EAS account.
- [ ] Add TLS certificate pinning for the API + WebSocket hosts.
- [ ] Remove/hard-gate developer mode & the localhost/manual-IP switcher in release; clear its keys on logout.
- [ ] Set `CropImageActivity` `exported="false"`; verify the 401 store-side handling forces re-auth on every path.
- [ ] Justify + disclose (or remove) `SYSTEM_ALERT_WINDOW`, `RECORD_AUDIO`/WebRTC/MediaProjection, and background location (Play data-safety + prominent disclosure).

**Low**
- [ ] Strip `console.*` (and push-token/PII logging) from release.
- [ ] Remove Compose `PreviewActivity` from release; add `maxSdkVersion="32"` to legacy storage perms; trim OEM badge perms.
- [ ] Validate/sanitize all `exp+fleet-driver-app` deep-link input; consider `android:taskAffinity=""`.
- [ ] Replace `yourcompany.com` legal URLs; remove `driver@fleetmanager.com` and hardcoded dev IPs; fix the `managment` typo / dead backend.
- [ ] Supply the Google Maps API key; wire `google-services.json` so FCM push works (verify on a device).
- [ ] Consolidate axios + raw-`fetch` onto one HTTP client with a single auth interceptor.
- [ ] Bump WorkManager (2.7.1) and run `npm audit`/`osv-scanner` on the real dependency manifests.

*See `EXTRACTION-REPORT.md` (build/permissions/OTA) and `decompiled/CODE-MAP.md` (API surface, architecture, how to navigate the decompiled output) for supporting detail.*
