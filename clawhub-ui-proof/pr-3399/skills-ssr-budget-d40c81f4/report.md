# Skills SSR latency proof

Compared production builds of `upstream/main@f9ea25e1` and `d40c81f4` against the same public catalog backend in Chrome.

- proposed warm response start: 259 ms median across five samples
- current-main warm response start: 5 ms median across five samples
- first list visible: 2,333 ms proposed median versus 3,211 ms current-main median
- slow-backend fallback: six initial skeleton rows become 20 Trending rows
- browser Trending requests: one
- direct proposed-server warm TTFB: 262–273 ms across six samples; cold first request 553 ms

