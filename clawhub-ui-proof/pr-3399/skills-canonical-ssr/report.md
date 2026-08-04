# ClawHub UI Proof

Status: pass

Scenario: canonical `/skills?tab=trending` on production builds backed by the same read-only production Convex deployment.

| Measurement | upstream/main | candidate |
| --- | ---: | ---: |
| Server HTML first-page items | 0 | 20 |
| Server HTML loading skeletons | 1 | 0 |
| Median server TTFB (7 samples) | 9.4 ms | 1516.0 ms |
| Median browser first list visible (5 samples) | 3527.1 ms | 2396.8 ms |
| Median browser LCP (5 samples) | 3336.0 ms | 2404.0 ms |
| Initial browser capability queries | 1 | 0 |
| Initial browser Trending queries | 1 | 0 |

Both lanes pass view-toggle, pagination, and New-tab assertions. Candidate pagination issues one next-page Trending request, while the initial canonical page issues no duplicate browser capability or Trending request.
