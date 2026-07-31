/* @vitest-environment node */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("CLAW-603 permanent Test proof workflow", () => {
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
});
