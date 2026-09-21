# Fleet Driver — Threat Scenarios

Concrete "what could actually happen" narratives for the Fleet Driver app, for a team walk-through. Each scenario: who does it, what they need first, the steps, the impact, and how likely/severe it is. Framing is *"here's what the binary lets happen if we don't harden"* — the findings are normal-for-mobile, the point is to close them before someone else finds them.

Severity uses Low / Med / High / Critical = business + data impact. Likelihood reflects attacker effort + preconditions.

---

## T1 — Session-token theft via device backup (no root)
**Actor:** anyone with brief physical access to an unlocked/enrolled phone (lost/stolen/resold device, a "borrowed" phone, a repair shop, a disgruntled driver).
**Preconditions:** `allowBackup="true"` with no backup rules (present), device Android ≤ 11, USB debugging on (or ADB reachable).
**Steps:** `adb backup -f out.ab com.clicksolutions.fleetdriver` → unpack → read `databases/RKStorage` → lift the plaintext `authToken`.
**Impact:** the Bearer token is replayed against the API from anywhere. Attacker acts **as that driver**: reads customer PII (addresses, loads, trip history), posts fake GPS, marks stops delivered, uploads bogus proof-of-delivery, accepts/declines routes, impersonates the driver in dispatch chat. If tokens are long-lived or not revoked on logout, it works indefinitely.
**Likelihood:** Medium · **Severity:** High
**Root cause:** finding #1 (token in plaintext AsyncStorage) + #2 (allowBackup).

## T2 — Session-token theft via rooted / compromised device
**Actor:** a driver who roots their own phone, or malware that gains root/escalation.
**Preconditions:** root or a privilege-escalation exploit on the device.
**Steps:** read the app-sandbox file `RKStorage` directly → extract `authToken`, `driver`, `vehicle`.
**Impact:** same as T1.
**Likelihood:** Medium (rooted phones are common in gig/driver populations) · **Severity:** High
**Note:** on a *healthy, non-rooted* device the sandbox does protect this file from other apps — that's why T1's backup path (no root needed) is the sharper risk.

## T3 — Fleet-wide remote code execution via unsigned OTA  ⚠ headline risk
**Actor:** whoever can publish to the Expo `production` channel — via a leaked/phished EAS token, an Expo account without MFA, a compromised CI/CD pipeline or poisoned dependency running `eas update`, or a malicious insider.
**Preconditions:** publish access to the channel. **No code signing** means the app runtime accepts any bundle served over TLS.
**Steps:** push one malicious JS bundle → on every device's next launch (checked always, ≤5 s) the app silently runs attacker code inside an authenticated session.
**Impact:** **the entire fleet at once.** Capture email + password as typed on the login screen, harvest every device's token, stream location, exfiltrate all trip/customer data — no app-store review, no user prompt, persists until a human notices and rolls back. This is remote code execution across all installs from a single point of failure (the Expo account/pipeline).
**Likelihood:** Low–Medium (needs account/pipeline compromise) · **Severity:** Critical
**Root cause:** finding #3 (OTA not code-signed).

## T4 — Man-in-the-middle without certificate pinning
**Actor:** someone controlling a network the driver uses (rogue/"free" Wi-Fi, a pushed enterprise/MDM CA, a malicious VPN).
**Preconditions:** the device trusts an attacker-controlled CA (user-installed or MDM-pushed). **No cert pinning** (confirmed absent).
**Steps:** intercept TLS to the API/WebSocket → read and modify traffic.
**Impact:** capture the Bearer token, credentials, live location and trip/customer data in transit; tamper with responses (e.g., feed fake stops, suppress alerts).
**Likelihood:** Low–Medium · **Severity:** High
**Root cause:** finding #4 (no pinning). *(Mitigated somewhat: system CA trust still required — this isn't a break of TLS itself.)*

## T5 — Rogue backend via the shipped developer-mode switch
**Actor:** a driver, or anyone with brief device access, who reaches the in-app developer mode.
**Preconditions:** developer mode is reachable in the release build (present); it persists across logout. *(In this build the `http://localhost`/IP targets are blocked by the platform cleartext default, which limits — but does not by-design prevent — repointing.)*
**Steps:** activate developer mode → switch the API base URL (localhost / manual IP) → the login screen now talks to an attacker-chosen server that captures credentials.
**Impact:** credential capture and confusion; a support/social-engineering vector ("IT asked me to point it here"). Lower real impact today due to the cleartext block, but it's attack surface that shouldn't ship.
**Likelihood:** Low · **Severity:** Medium
**Root cause:** finding #5 (dev-mode/env switcher in release).

## T6 — Combined kill-chain (why T1 and T3 compound)
**The nightmare version:** use **T3** (unsigned OTA) to push a bundle whose only job is to read every device's **T1** plaintext `authToken` and phone it home. One publish → every driver's session token exfiltrated silently, fleet-wide, with no device access required. Finding #3 delivers the payload; finding #1 is what it steals. This is the scenario that turns "two medium/high findings" into "single catastrophic event."

---

## At-a-glance

| # | Scenario | Needs | Blast radius | Likelihood | Severity |
|---|---|---|---|---|---|
| T1 | Token theft via backup | cable + phone, no root | one driver | Med | High |
| T2 | Token theft via root | rooted/compromised device | one driver | Med | High |
| T3 | Unsigned OTA RCE | Expo/CI compromise | **whole fleet** | Low–Med | **Critical** |
| T4 | MITM, no pinning | attacker CA on device | driver in transit | Low–Med | High |
| T5 | Rogue server via dev mode | device access | one driver | Low | Med |
| T6 | OTA → mass token theft | T3 preconditions | **whole fleet** | Low–Med | **Critical** |

**What the app leaks even with none of the above:** the full API contract, screen map, config, internal dev IPs, and design system — all from the public store binary (see the other reports). That's the baseline reality of shipping a mobile app; the scenarios above are what happens when a leaked *blueprint* meets an unprotected *token* or *update channel*.

*Mitigations are tracked in `SECURITY-AUDIT.md` (§ remediation checklist). The two that collapse the whole table: SecureStore + short-lived/revocable tokens (kills T1/T2/T6-payload) and expo-updates code signing + MFA (kills T3/T6).*
