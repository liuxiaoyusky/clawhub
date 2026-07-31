/* @vitest-environment node */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("CLAW-603 permanent Test proof workflow", () => {
  it("pins every Test operator job to the exact deployed main SHA", async () => {
    const workflow = await readFile(".github/workflows/skills-sh-sync.yml", "utf8");

    expect(workflow.match(/c762d8ec6d198f2f92b0d33f2af3e83cac6ce8cc/g)).toHaveLength(4);
    expect(workflow).not.toContain("e9316c1c7d79840717d993689c47c66da7f4c87f");
  });

  it("retries read-only provenance pages and proves token revocation directly", async () => {
    const workflow = await readFile(".github/workflows/skills-sh-sync.yml", "utf8");

    expect(workflow).toContain("run_inline_query_with_retry()");
    expect(workflow).toContain('page="$(run_inline_query_with_retry "');
    expect(workflow).toContain('"$TEST_CONVEX_SITE_URL/api/v1/operator/skills-sh/catalog-test"');
    expect(workflow).toContain('--data \'{"operation":"mirror-status"}\'');
    expect(workflow).not.toContain('--data \'{"operation":"status"}\'');
  });

  it("completes from the durable cleanup artifact instead of transient shell state", async () => {
    const workflow = await readFile(".github/workflows/skills-sh-sync.yml", "utf8");

    expect(workflow).toContain(
      "jq -e '.disableExit == 0 and .tokenRotationExit == 0 and .revokedStatus == \"401\"'",
    );
    expect(workflow).toContain("proof_complete=1\n          trap - EXIT");
    expect(workflow).not.toContain('[[ "$proof_complete" == "1" ]]');
  });

  it("proves reactivated search through the supported public slug query", async () => {
    const workflow = await readFile(".github/workflows/skills-sh-sync.yml", "utf8");

    expect(workflow).toContain(
      '"$public_site/api/v1/search?q=$encoded_slug&mode=exact&limit=10" \\\n            > proof/claw-603/search-reactivated.json',
    );
  });

  it("compares unclaimed provenance with the audit's unclaimed eligible partition", async () => {
    const workflow = await readFile(".github/workflows/skills-sh-sync.yml", "utf8");

    expect(workflow).toContain(".counts.eligible == $provenance[0].exactSourceEligible");
    expect(workflow).not.toContain(".counts.sourceEligible == $provenance[0].exactSourceEligible");
  });
});
