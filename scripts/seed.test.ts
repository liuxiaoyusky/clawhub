import { describe, expect, it } from "vitest";
import { assertSeedTargetAllowed, buildSeedSteps, parseSeedArgs } from "./seed";

describe("shared seed runner", () => {
  it("builds the M1 seed from the searchable Padel fixture only", () => {
    expect(buildSeedSteps(parseSeedArgs(["--m1"]))).toEqual([
      {
        command: "bunx",
        args: ["convex", "run", "--no-push", "devSeed:seedPadelSkill"],
      },
    ]);
  });

  it("uses the local deployment selected by the environment by default", () => {
    expect(buildSeedSteps(parseSeedArgs([]))).toEqual([
      {
        command: "bunx",
        args: ["convex", "run", "--no-push", "devSeed:seedLocalFixtures"],
      },
      {
        command: "bunx",
        args: ["convex", "run", "--no-push", "devSeed:seedCanonicalSearchFixture"],
      },
      {
        command: "bun",
        args: ["scripts/public-corpus/seed-public-corpus.ts"],
      },
      {
        command: "bun",
        args: ["scripts/public-corpus/seed-catalog-presentation.ts"],
      },
      {
        command: "bunx",
        args: ["convex", "run", "--no-push", "statsMaintenance:updateGlobalStatsAction"],
      },
    ]);
  });

  it("targets every seed step at the same named preview deployment", () => {
    expect(buildSeedSteps(parseSeedArgs(["--preview-name", "feature/demo"]))).toEqual([
      {
        command: "bunx",
        args: ["convex", "run", "--preview-name", "feature/demo", "devSeed:seedLocalFixtures"],
      },
      {
        command: "bunx",
        args: [
          "convex",
          "run",
          "--preview-name",
          "feature/demo",
          "devSeed:seedCanonicalSearchFixture",
        ],
      },
      {
        command: "bun",
        args: ["scripts/public-corpus/seed-public-corpus.ts", "--preview-name", "feature/demo"],
      },
      {
        command: "bun",
        args: [
          "scripts/public-corpus/seed-catalog-presentation.ts",
          "--preview-name",
          "feature/demo",
        ],
      },
      {
        command: "bunx",
        args: [
          "convex",
          "run",
          "--preview-name",
          "feature/demo",
          "statsMaintenance:updateGlobalStatsAction",
        ],
      },
    ]);
  });

  it("allows only local or explicitly keyed preview targets", () => {
    expect(() =>
      assertSeedTargetAllowed(parseSeedArgs([]), {
        CONVEX_DEPLOYMENT: "local:local-amantus-clawdhub",
      }),
    ).not.toThrow();
    expect(() =>
      assertSeedTargetAllowed(parseSeedArgs(["--preview-name", "feature/demo"]), {
        CONVEX_DEPLOY_KEY: "preview:openclaw:clawhub|secret",
      }),
    ).not.toThrow();

    expect(() =>
      assertSeedTargetAllowed(parseSeedArgs(["--preview-name", "feature/demo"]), {
        CONVEX_DEPLOY_KEY: "prod:wry-manatee-359|secret",
      }),
    ).toThrow("requires a Convex Preview deploy key");
  });

  it("rejects preview targets for the M1 local fixture seed", () => {
    expect(() =>
      assertSeedTargetAllowed(parseSeedArgs(["--m1", "--preview-name", "feature/demo"]), {
        CONVEX_DEPLOY_KEY: "preview:openclaw:clawhub|secret",
      }),
    ).toThrow("M1 seed requires a local Convex deployment");
  });
});
