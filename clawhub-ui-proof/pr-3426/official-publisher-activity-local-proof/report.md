# ClawHub UI Proof

Status: pass
Mode: `before-after`
Route: `/official`
Baseline: `6381d789ab1883011639ca8e2aaec53202f0aad5`
Candidate: `bdeb968141b8812c6a2b847ebe9858a652ce8601`

## Result

The desktop candidate removes the grouped package/plugin icons while preserving the publisher logo, published count, download glyph, download count, and labels. The explicit middle dot uses one symmetric spacing token on both sides. The mobile candidate preserves the existing download-only activity treatment and publisher identity.

## Runtime

Screenshots come from real built ClawHub baseline and candidate instances backed by the local Convex fixture, captured in Chromium at 1440x900 and 390x844. Remote `proof:ui` provisioning was unavailable because the environment did not provide a Hetzner token.
