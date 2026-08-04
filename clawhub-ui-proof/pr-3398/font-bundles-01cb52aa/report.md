# ClawHub UI Proof

Status: pass
Mode: `before-after`
Scenario: `homepage typography contract`
Baseline: `upstream/main@b15bd52506c0a16b7a309cdc4e1f9312fed51465`
Candidate: `01cb52aa03e6970798846953a06199d212379aab`
Provider: `local-real-browser`

Both screenshots were captured from production builds of the real ClawHub homepage in Chromium at 1440x1000. The full-page images are 1440x3411 and pixel-identical: zero changed channels and a maximum channel delta of zero.

The proposed build removes 42 emitted client font assets totaling 767,488 bytes and all 21 unused registered font faces. The main stylesheet decreases from 775,675 to 770,656 raw bytes. The browser's encoded CSS response decreases from 85,317 to 84,722 bytes. The Carapace typography tokens and computed font stacks are unchanged.

## Artifacts

### baseline

- pass: Homepage typography contract - `baseline/screenshots/homepage-typography-contract.png`

### candidate

- pass: Homepage typography contract - `candidate/screenshots/homepage-typography-contract.png`
