# Carapace v0.6.1 visual preservation proof

- Candidate: `a41389a26c`
- Local URL: `http://localhost:3005/carapace-proof/skills/carapace-sparkline-proof`
- Browser: Codex in-app browser
- Reference image: the user-provided pre-PR ClawHub screenshot

The final candidate restores the chart source and CSS byte-for-byte to
`origin/main`; shared `oc-sparkline` classes and `candidate/data.css` are not
present in the final diff.

Live candidate checks:

- computed line stroke: `rgb(96, 165, 250)` from `--oc-status-info-fg`
- stroke cap and join: `round`
- area fill: the same semantic blue at 18% alpha
- horizontal overflow: `0`
- realistic 30-day local data renders the same low-variance shape as the
  requested reference

This proof supersedes the earlier synthetic alternating-value fixture, whose
spikes came from test data rather than a production geometry change.
