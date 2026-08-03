# ClawHub UI Proof

Status: pass

Mode: `before-after`

Viewport: `390 × 844` with `375 px` document client width

Capture timing: each page was allowed to settle for 5 seconds after load, then the app section was aligned at `top: 20 px` and allowed to settle for another 5 seconds before capture.

## Result

- Published `clawhub.ai`: the app-category strip is `449 px` wide and expands the document to `469 px`.
- Proposed commit `6c506f2a`: the strip fills its `335 px` content area, retains `493 px` of internally scrollable tabs, and the document remains `375 px` wide.
- Both screenshots come from real ClawHub instances in Chrome: the published site for baseline and the locally running PR commit for candidate.
