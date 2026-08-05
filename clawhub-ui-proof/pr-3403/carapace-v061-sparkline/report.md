# Carapace sparkline UI proof

- URL: `http://localhost:3005/carapace-proof/carapace-sparkline-proof`
- Fixture: local public-corpus skill with 30 days of deterministic download data
- Browser: Codex in-app browser
- Candidate: `31426e2220`

Verified in light and dark themes:

- SVG composes `oc-sparkline`, `oc-sparkline-line`, and `oc-sparkline-fill`.
- Computed line stroke remains the semantic blue `rgb(96, 165, 250)`.
- Area fill remains the same blue at 18% alpha.
- Hover shows the nearest date/value and the local vertical marker.
- Page horizontal overflow is zero.
