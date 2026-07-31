#!/usr/bin/env bun

/* oxlint-disable typescript/no-explicit-any -- Test-only recovery decodes live Convex JSON. */

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertControlledMirrorRecoveryMetadata,
  assertControlledProofBookmark,
  buildControlledCandidateContent,
  classifyClaimRecoveryState,
} from "./claw-603-claim-proof-helpers";

const EXTERNAL_ID = "patrick-erichsen/skills/html";
const REPO = "patrick-erichsen/skills";
const PATH = "skills/html";
const COMMIT_A = "050daba89f6b6636470add5cb300aac46a412cf8";
const HASH_A = "a47adb2c1ac33c088f664b5187971b63d2b958a7b9f01516d26005ca941a108f";
const FILE_HASH_A = "42d2e89358ea927441dfede45c3b0cf89a21603bc7c32246f098d24a9cbea1ff";
const COMMIT_B = "1111111111111111111111111111111111111111";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PREVIOUS_PROOF_RUN = 30608116457;
const PUBLIC_SITE = "https://academic-chihuahua-392.convex.site";
const RECOVERY_SNAPSHOT_ID = "claw-603-claim-recovery:30608116457";
const PROOF_BOOKMARK = {
  id: "w17aeppjxks4v38af24a897fd98bkvfp",
  skillId: "kd712b24dhkftgq5pt88gctehx8b6g9v",
  userId: "kn746c8fb39xg3pachtrd40fgd8akgxr",
  createdAt: 1785477444440,
  hourlyStatsRecordedAt: 1785477444440,
};
const EXPECTED_MIRROR_RECOVERY_METADATA = {
  digest: {
    externalId: EXTERNAL_ID,
    sourceType: "github",
    upstreamSourceType: "controlled-github",
    owner: "patrick-erichsen",
    repo: "skills",
    slug: "html",
    displayName: "HTML Artifact Chooser",
    sourceUrl: "https://www.skills.sh/patrick-erichsen/skills/html",
    canonicalRepoUrl: "https://github.com/patrick-erichsen/skills",
    githubPath: PATH,
    upstreamInstalls: 123,
    upstreamScanners: {
      genAgentTrustHub: { status: "unavailable" },
      snyk: { status: "unavailable" },
      socket: { status: "unavailable" },
    },
    inferredCategories: ["other"],
    inferredTopics: [],
    inferredCategoryConfidence: "low",
    inferredTopicConfidence: "low",
    inferredClassifierVersion: "taxonomy-prototype-v9",
    inferredTopicClassifierVersion: "topic-prototype-v1",
    inferredInputHash: "5cd78db114746ff695441cc98f9560f0ac09876ccfaecff572ddfe07039f7045",
    inferredTopicInputHash: "0f0d55bfc10574035d704c182e7054da83f1240d30185e8486cf928e58475ec7",
    inferredAt: 1784788731652,
  },
  detail: {
    contentKind: "skill-md",
    path: "skills/html/SKILL.md",
    contentSha256: FILE_HASH_A,
    contentBytes: 5688,
    sourceBytes: 5688,
    sourceFileCount: 1,
    truncated: false,
  },
};
const execFileAsync = promisify(execFile);

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function runCommand(command: string[]) {
  const [executable, ...args] = command;
  assert(executable, "command executable is required");
  const { stdout } = await execFileAsync(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout.trim();
}

async function runConvex(functionName: string, args: Record<string, unknown>) {
  const output = await runCommand([
    "bunx",
    "convex",
    "run",
    "--no-push",
    functionName,
    JSON.stringify(args),
  ]);
  return JSON.parse(output) as Record<string, any>;
}

async function runInline(query: string) {
  const output = await runCommand(["bunx", "convex", "run", "--no-push", "--inline-query", query]);
  return JSON.parse(output) as Record<string, any>;
}

const operatorToken = requireEnv("CLAWHUB_TEST_OPERATOR_TOKEN");
const mirrorGateUrl = requireEnv("CLAWHUB_TEST_MIRROR_GATE_URL");
const outputPath = resolve(
  process.env.CLAWHUB_CLAIM_PROOF_OUTPUT?.trim() || "claw-603-claim-recovery.json",
);

async function postMirror(body: Record<string, unknown>) {
  const response = await fetch(mirrorGateUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${operatorToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert(response.status === 200, `mirror ${String(body.operation)} returned ${response.status}`);
  return JSON.parse(text) as Record<string, any>;
}

async function sourceState() {
  return await runInline(`
    const source = await ctx.db.query("githubSkillSources")
      .withIndex("by_repo", q => q.eq("repo", "${REPO}"))
      .unique();
    if (!source) return null;
    const skills = await ctx.db.query("skills")
      .withIndex("by_github_source", q => q.eq("githubSourceId", source._id))
      .collect();
    const candidates = [];
    for (const skill of skills) {
      if (skill.githubPendingCandidateId) {
        candidates.push(await ctx.db.get(skill.githubPendingCandidateId));
      }
    }
    return {source, skills, candidates};
  `);
}

async function queueState() {
  return await runInline(`
    const requests = await ctx.db.query("skillScanRequests").take(1001);
    const jobs = await ctx.db.query("securityScanJobs").take(1001);
    return {
      requestIds: requests.map(row => row._id).sort(),
      jobIds: jobs.map(row => row._id).sort(),
      // Candidate promotion and mirror processing do not write scan jobs; this detects any
      // out-of-contract mutation even when the bounded queue identities stay unchanged.
      jobUpdatedAtSum: jobs.reduce((sum, row) => sum + row.updatedAt, 0),
      requestsTruncated: requests.length > 1000,
      jobsTruncated: jobs.length > 1000,
    };
  `);
}

async function proofBookmarkState() {
  return await runInline(`
    const star = await ctx.db.query("stars")
      .withIndex("by_skill_user", q => q
        .eq("skillId", "${PROOF_BOOKMARK.skillId}")
        .eq("userId", "${PROOF_BOOKMARK.userId}"))
      .unique();
    const skill = await ctx.db.get("${PROOF_BOOKMARK.skillId}");
    return {star, skill};
  `);
}

function mirrorRow(state: Record<string, any>) {
  const { digest, detail } = state;
  assert(digest && detail, "controlled mirror row and detail are required");
  // skillsShMirror.rowValidator has no summary field; searchable summary text is derived from
  // the exact detail content below rather than copied as independent mirror metadata.
  assert(digest.summary === undefined, "controlled mirror has unsupported summary metadata");
  return {
    externalId: digest.externalId,
    sourceType: digest.sourceType,
    upstreamSourceType: digest.upstreamSourceType,
    owner: digest.owner,
    repo: digest.repo,
    slug: digest.slug,
    displayName: digest.displayName,
    sourceUrl: digest.sourceUrl,
    canonicalRepoUrl: digest.canonicalRepoUrl,
    githubPath: digest.githubPath,
    githubCommit: COMMIT_A,
    sourceContentHash: HASH_A,
    upstreamInstalls: digest.upstreamInstalls,
    upstreamScanners: digest.upstreamScanners,
    inferredCategories: digest.inferredCategories,
    inferredTopics: digest.inferredTopics,
    inferredCategoryConfidence: digest.inferredCategoryConfidence,
    inferredTopicConfidence: digest.inferredTopicConfidence,
    inferredClassifierVersion: digest.inferredClassifierVersion,
    inferredTopicClassifierVersion: digest.inferredTopicClassifierVersion,
    inferredInputHash: digest.inferredInputHash,
    inferredTopicInputHash: digest.inferredTopicInputHash,
    inferredAt: digest.inferredAt,
    detail: {
      contentKind: detail.contentKind,
      path: detail.path,
      content: detail.content,
      contentBytes: detail.contentBytes,
      sourceBytes: detail.sourceBytes,
      sourceFileCount: detail.sourceFileCount,
      truncated: detail.truncated,
    },
  };
}

async function restoreMirror(state: Record<string, any>) {
  const run = await runConvex("skillsShMirror:startRunInternal", {
    actor: "CLAW-603 permanent Test claim recovery",
    reason: "restore exact controlled mirror after completed claim proof",
    snapshotId: RECOVERY_SNAPSHOT_ID,
    sourceTotal: 1,
    sourcePageSize: 1,
    sourceMeasuredAt: new Date().toISOString(),
    sourceRequests: 0,
    sourceDurationMs: 0,
  });
  const leaseToken = `claw-603-claim-recovery-${Date.now()}`;
  await runConvex("skillsShMirror:claimBatchLeaseInternal", {
    runId: run.runId,
    page: 0,
    offset: 0,
    leaseToken,
  });
  const processed = await runConvex("skillsShMirror:processBatchInternal", {
    runId: run.runId,
    page: 0,
    offset: 0,
    leaseToken,
    pageLength: 1,
    hasMore: false,
    sourceTotal: 1,
    sourceRequests: 0,
    sourceBytes: 0,
    rows: [mirrorRow(state)],
  });
  const canceled = await runConvex("skillsShMirror:cancelRunInternal", {
    runId: run.runId,
    actor: "CLAW-603 permanent Test claim recovery",
    reason: "exact controlled row recovery complete",
    confirm: "cancel-skills-sh-mirror-test-run",
  });
  return { run, processed, canceled };
}

const startedAt = new Date().toISOString();
const statusBefore = await postMirror({ operation: "status" });
const activeRuns = statusBefore.runs.filter((run: Record<string, any>) =>
  ["running", "paused", "reconciling"].includes(run.status),
);
assert(activeRuns.length === 0, "skills.sh mirror recovery requires no active run");
const [mirrorBefore, sourceBefore, bookmarkBefore, queuesBefore, isolationBefore] =
  await Promise.all([
    postMirror({ operation: "read", externalId: EXTERNAL_ID }),
    sourceState(),
    proofBookmarkState(),
    queueState(),
    runConvex("skillsShMirror:getIsolationInternal", {}),
  ]);
assert(
  !queuesBefore.requestsTruncated && !queuesBefore.jobsTruncated,
  "scan queues were truncated",
);
assert(mirrorBefore.digest?.claimStatus === "promoted", "controlled claim is not promoted");
assert(
  mirrorBefore.digest?.publicVisible === false,
  "controlled claimed row is unexpectedly public",
);
assert(sourceBefore?.source?.repo === REPO, "controlled native source is missing");
const htmlBefore = sourceBefore.skills.find(
  (skill: Record<string, any>) => skill.githubPath === PATH,
);
assert(htmlBefore, "controlled native source is missing the HTML skill");
const proofBookmarkPresent = bookmarkBefore.star !== null;
const recoveryPhase = classifyClaimRecoveryState({
  mirrorCommit: mirrorBefore.digest.githubCommit,
  nativeCommit: htmlBefore.githubCurrentCommit,
  pendingCandidate: Boolean(htmlBefore.githubPendingCandidateId),
  proofBookmark: proofBookmarkPresent,
  restoredCommit: COMMIT_A,
  contaminatingCommit: COMMIT_B,
});
assert(
  mirrorBefore.digest.sourceContentHash ===
    (mirrorBefore.digest.githubCommit === COMMIT_A ? HASH_A : HASH_B),
  "controlled mirror residue hash mismatch",
);
assert(
  htmlBefore.githubCurrentContentHash ===
    (htmlBefore.githubCurrentCommit === COMMIT_A ? HASH_A : HASH_B),
  "controlled native residue hash mismatch",
);
const pending = sourceBefore.candidates.find(
  (candidate: Record<string, any>) => candidate?._id === htmlBefore.githubPendingCandidateId,
);
assertControlledMirrorRecoveryMetadata({
  mirror: mirrorBefore,
  expected: EXPECTED_MIRROR_RECOVERY_METADATA,
});
if (proofBookmarkPresent) {
  assertControlledProofBookmark({
    star: bookmarkBefore.star,
    expected: PROOF_BOOKMARK,
    currentSkillStars: bookmarkBefore.skill?.statsStars,
    baselineSkillStars: 0,
  });
} else {
  assert(bookmarkBefore.skill?.statsStars === 0, "controlled Bookmark count is not restored");
}

let discovered: ReturnType<typeof buildControlledCandidateContent> | null = null;
if (htmlBefore.githubCurrentCommit === COMMIT_B) {
  assert(pending?.githubCommit === COMMIT_A, "restoration candidate commit mismatch");
  assert(pending?.githubContentHash === HASH_A, "restoration candidate hash mismatch");
  assert(pending?.scanStatus === "clean", "restoration candidate verdict is not clean");
  assert(pending?.lifecycleStatus === "pending", "restoration candidate is not pending");
  discovered = buildControlledCandidateContent({
    mirror: mirrorBefore,
    expectedExternalId: EXTERNAL_ID,
    expectedPath: PATH,
    expectedFileHash: FILE_HASH_A,
    candidateCommit: COMMIT_A,
    candidateContentHash: HASH_A,
  });
  if (pending.skillMarkdown !== undefined) {
    assert(
      pending.skillMarkdownPath === discovered.skillMarkdownPath &&
        pending.skillMarkdown === discovered.skillMarkdown,
      "cached restoration candidate content mismatch",
    );
  }
}

const mirrorRecovery =
  mirrorBefore.digest.githubCommit === COMMIT_B
    ? await restoreMirror(mirrorBefore)
    : { skipped: true, reason: "mirror already restored" };
let contentRecovery: Record<string, any> = {
  skipped: true,
  reason: "native candidate already restored",
};
if (discovered) {
  contentRecovery = await runConvex("githubSkillSync:upsertGitHubSkillCandidateContentInternal", {
    candidateId: pending._id,
    discovered,
    commit: COMMIT_A,
  });
  assert(contentRecovery.promoted === true, "cached restoration candidate did not promote");
}
const restoredSource = await sourceState();
const restoredHtml = restoredSource.skills.find(
  (skill: Record<string, any>) => skill.githubPath === PATH,
);
assert(restoredHtml?.githubCurrentCommit === COMMIT_A, "native source commit was not restored");
assert(restoredHtml?.githubCurrentContentHash === HASH_A, "native source hash was not restored");
assert(!restoredHtml?.githubPendingCandidateId, "native source still has a pending candidate");

const starRestoration = proofBookmarkPresent
  ? await runConvex("stars:removeStarInternal", {
      userId: PROOF_BOOKMARK.userId,
      skillId: PROOF_BOOKMARK.skillId,
    })
  : { skipped: true, reason: "proof Bookmark already restored" };
if (proofBookmarkPresent) {
  assert(starRestoration.unstarred === true, "exact proof Bookmark was not removed");
}
const [
  mirrorAfter,
  sourceAfter,
  bookmarkAfter,
  queuesAfter,
  isolationAfter,
  alias,
  installResponse,
] = await Promise.all([
  postMirror({ operation: "read", externalId: EXTERNAL_ID }),
  sourceState(),
  proofBookmarkState(),
  queueState(),
  runConvex("skillsShMirror:getIsolationInternal", {}),
  runConvex("skillsShMirrorPublic:getByRoute", {
    owner: "patrick-erichsen",
    repo: "skills",
    slug: "html",
  }),
  fetch(`${PUBLIC_SITE}/api/v1/skills-sh/${EXTERNAL_ID}/install`).then(async (response) => ({
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  })),
]);
const htmlAfter = sourceAfter.skills.find(
  (skill: Record<string, any>) => skill.githubPath === PATH,
);
assert(mirrorAfter.digest?.claimStatus === "promoted", "restored mirror claim changed");
assert(mirrorAfter.digest?.githubCommit === COMMIT_A, "restored mirror commit mismatch");
assert(mirrorAfter.digest?.sourceContentHash === HASH_A, "restored mirror hash mismatch");
assert(mirrorAfter.digest?.publicVisible === false, "restored claimed mirror became public");
assert(htmlAfter?.githubCurrentCommit === COMMIT_A, "final native commit mismatch");
assert(htmlAfter?.githubCurrentContentHash === HASH_A, "final native hash mismatch");
assert(bookmarkAfter.star === null, "controlled proof Bookmark still exists");
assert(bookmarkAfter.skill?.statsStars === 0, "controlled Bookmark count was not restored");
assert(alias.kind === "redirect", "restored compatibility route is not a redirect");
assert(installResponse.status === 200, "restored compatibility install failed");
assert(installResponse.body?.github?.commit === COMMIT_A, "restored install commit mismatch");
assert(installResponse.body?.github?.contentHash === HASH_A, "restored install hash mismatch");
assert(JSON.stringify(queuesAfter) === JSON.stringify(queuesBefore), "scan queues changed");
assert(
  JSON.stringify(isolationAfter) === JSON.stringify(isolationBefore),
  "scan isolation changed",
);

const proof = {
  ok: true,
  startedAt,
  completedAt: new Date().toISOString(),
  target: { environment: "permanent Test", productionWrites: 0 },
  resumedFromProofRun: PREVIOUS_PROOF_RUN,
  recoveryPhase,
  recoveryBoundary: "exact pending commit-A candidate content cache and normal promotion",
  restoration: {
    contentRecovery,
    restoredSource,
    mirrorRecovery,
    restoredObservation: mirrorAfter,
  },
  bookmarkBefore,
  final: { mirrorAfter, sourceAfter, bookmarkAfter, alias, installResponse, starRestoration },
  isolationBefore,
  isolationAfter,
  queuesBefore,
  queuesAfter,
  scansPlanned: 0,
  scansAdmitted: 0,
  paidScans: 0,
};
await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(proof)}\n`);
