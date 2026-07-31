#!/usr/bin/env bun

/* oxlint-disable typescript/no-explicit-any -- Test-only proof decodes live Convex JSON. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { buildControlledCandidateContent } from "./claw-603-claim-proof-helpers";

const EXTERNAL_ID = "patrick-erichsen/skills/html";
const REPO = "patrick-erichsen/skills";
const PATH = "skills/html";
const COMMIT_A = "050daba89f6b6636470add5cb300aac46a412cf8";
const HASH_A = "a47adb2c1ac33c088f664b5187971b63d2b958a7b9f01516d26005ca941a108f";
const FILE_HASH_A = "42d2e89358ea927441dfede45c3b0cf89a21603bc7c32246f098d24a9cbea1ff";
const COMMIT_B = "1111111111111111111111111111111111111111";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COMMIT_C = "2222222222222222222222222222222222222222";
const HASH_C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const PUBLIC_SITE = "https://academic-chihuahua-392.convex.site";
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

async function fetchCapture(url: string, init?: RequestInit) {
  const startedAt = performance.now();
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return {
    status: response.status,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    body,
  };
}

const operatorToken = requireEnv("CLAWHUB_TEST_OPERATOR_TOKEN");
const mirrorGateUrl = requireEnv("CLAWHUB_TEST_MIRROR_GATE_URL");
const outputPath = resolve(
  process.env.CLAWHUB_CLAIM_PROOF_OUTPUT?.trim() || "claw-603-claim-proof.json",
);
const checkpointPath = `${outputPath}.checkpoints.jsonl`;

async function postMirror(body: Record<string, unknown>) {
  const response = await fetchCapture(mirrorGateUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${operatorToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert(response.status === 200, `mirror ${String(body.operation)} returned ${response.status}`);
  return response.body as Record<string, any>;
}

async function readMirror() {
  return await postMirror({ operation: "read", externalId: EXTERNAL_ID });
}

async function queueState() {
  const state = await runInline(`
    const requests = await ctx.db.query("skillScanRequests").take(1001);
    const jobs = await ctx.db.query("securityScanJobs").take(1001);
    return {
      skillScanRequests: requests.map(request => ({
        _id: request._id,
        sourceKind: request.sourceKind,
        status: request.status,
        securityScanJobId: request.securityScanJobId ?? null,
        githubSkillScanId: request.githubSkillScanId ?? null,
        skillsShCatalogAttemptId: request.skillsShCatalogAttemptId ?? null,
        skillId: request.skillId ?? null,
        skillVersionId: request.skillVersionId ?? null,
        runId: request.runId ?? null,
        completedAt: request.completedAt ?? null,
        updatedAt: request.updatedAt,
      })),
      skillScanRequestsTruncated: requests.length > 1000,
      securityScanJobs: jobs,
      securityScanJobsTruncated: jobs.length > 1000,
      jobStatuses: jobs.reduce((counts, job) => {
        counts[job.status] = (counts[job.status] ?? 0) + 1;
        return counts;
      }, {}),
    };
  `);
  assert(
    state.skillScanRequestsTruncated === false && state.securityScanJobsTruncated === false,
    "scan queue proof exceeded the bounded complete read",
  );
  const stableDigest = (rows: Record<string, any>[]) =>
    createHash("sha256")
      .update(JSON.stringify([...rows].sort((left, right) => left._id.localeCompare(right._id))))
      .digest("hex");
  return {
    skillScanRequests: state.skillScanRequests.length,
    skillScanRequestsSha256: stableDigest(state.skillScanRequests),
    securityScanJobs: state.securityScanJobs.length,
    securityScanJobsSha256: stableDigest(state.securityScanJobs),
    jobStatuses: state.jobStatuses,
  };
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
    return {
      source,
      skills: skills.map(skill => ({
        _id: skill._id,
        slug: skill.slug,
        displayName: skill.displayName,
        summary: skill.summary,
        ownerUserId: skill.ownerUserId,
        ownerPublisherId: skill.ownerPublisherId,
        githubPath: skill.githubPath,
        githubCurrentCommit: skill.githubCurrentCommit,
        githubCurrentContentHash: skill.githubCurrentContentHash,
        githubScanStatus: skill.githubScanStatus,
        githubPendingCandidateId: skill.githubPendingCandidateId,
        githubCurrentCandidateId: skill.githubCurrentCandidateId,
        statsStars: skill.statsStars,
        statsSkillsShInstalls: skill.statsSkillsShInstalls,
      })),
    };
  `);
}

let checkpointSequence = 0;

async function writeCheckpoint(stage: string, details: Record<string, unknown> = {}) {
  const capture = async (read: () => Promise<unknown>) => {
    try {
      return { ok: true, value: await read() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const mirror = await capture(readMirror);
  const source = await capture(sourceState);
  const queues = await capture(queueState);
  const isolation = await capture(() => runConvex("skillsShMirror:getIsolationInternal", {}));
  const status = await capture(() => postMirror({ operation: "status" }));
  checkpointSequence += 1;
  const captures = { mirror, source, queues, isolation, status };
  await appendFile(
    checkpointPath,
    `${JSON.stringify({
      sequence: checkpointSequence,
      stage,
      observedAt: new Date().toISOString(),
      details,
      ...captures,
    })}\n`,
    "utf8",
  );
  const failedReads = Object.entries(captures)
    .filter(([, captureResult]) => !captureResult.ok)
    .map(([name]) => name);
  assert(failedReads.length === 0, `checkpoint ${stage} failed reads: ${failedReads.join(", ")}`);
}

function buildSnapshot(source: Record<string, any>, commit: string, htmlContentHash: string) {
  return {
    repo: REPO,
    defaultBranch: source.source.defaultBranch ?? "main",
    commit,
    manifestStatus: "missing",
    skills: source.skills.map((skill: Record<string, any>) => ({
      slug: skill.slug,
      displayName: skill.displayName,
      ...(skill.summary ? { summary: skill.summary } : {}),
      path: skill.githubPath,
      skillMarkdownPath: `${skill.githubPath}/SKILL.md`,
      contentHash: skill.githubPath === PATH ? htmlContentHash : skill.githubCurrentContentHash,
    })),
  };
}

async function applyClaimedSnapshot(
  source: Record<string, any>,
  commit: string,
  contentHash: string,
) {
  const html = source.skills.find((skill: Record<string, any>) => skill.githubPath === PATH);
  assert(html, "controlled native HTML skill is missing");
  return await runConvex("skillsShClaims:applyClaimedGitHubSkillSourceSyncInternal", {
    sourceId: source.source._id,
    repo: REPO,
    ownerUserId: html.ownerUserId,
    ownerPublisherId: html.ownerPublisherId,
    ...(source.source.githubRepositoryId
      ? { githubRepositoryId: source.source.githubRepositoryId }
      : {}),
    ...(source.source.githubOwnerId ? { githubOwnerId: source.source.githubOwnerId } : {}),
    skillsShClaimPath: PATH,
    skillsShClaim: { externalId: EXTERNAL_ID, path: PATH, commit, contentHash },
    snapshot: buildSnapshot(source, commit, contentHash),
  });
}

async function applyNativeSnapshot(
  source: Record<string, any>,
  commit: string,
  contentHash: string,
) {
  const html = source.skills.find((skill: Record<string, any>) => skill.githubPath === PATH);
  assert(html, "controlled native HTML skill is missing");
  return await runConvex("githubSkillSync:applyGitHubSkillSourceSyncInternal", {
    sourceId: source.source._id,
    repo: REPO,
    ownerUserId: html.ownerUserId,
    ownerPublisherId: html.ownerPublisherId,
    ...(source.source.githubRepositoryId
      ? { githubRepositoryId: source.source.githubRepositoryId }
      : {}),
    ...(source.source.githubOwnerId ? { githubOwnerId: source.source.githubOwnerId } : {}),
    snapshot: buildSnapshot(source, commit, contentHash),
  });
}

async function cacheControlledPendingCandidateContent(
  source: Record<string, any>,
  mirror: Record<string, any>,
  commit: string,
  contentHash: string,
) {
  const html = source.skills.find((skill: Record<string, any>) => skill.githubPath === PATH);
  assert(html?.githubPendingCandidateId, "controlled native candidate is not pending");
  const discovered = buildControlledCandidateContent({
    mirror,
    expectedExternalId: EXTERNAL_ID,
    expectedPath: PATH,
    expectedFileHash: FILE_HASH_A,
    candidateCommit: commit,
    candidateContentHash: contentHash,
  });
  return await runConvex("githubSkillSync:upsertGitHubSkillCandidateContentInternal", {
    candidateId: html.githubPendingCandidateId,
    discovered,
    commit,
  });
}

function mirrorRow(
  state: Record<string, any>,
  commit: string,
  contentHash: string,
  upstreamInstalls: number,
) {
  const digest = state.digest;
  const detail = state.detail;
  assert(digest && detail, "controlled mirror row and detail are required");
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
    githubCommit: commit,
    sourceContentHash: contentHash,
    upstreamInstalls,
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

async function observeCorrectedMirror(
  baseState: Record<string, any>,
  commit: string,
  contentHash: string,
  upstreamInstalls: number,
  label: string,
) {
  await runConvex("skillsShMirror:configureInternal", {
    actor: "CLAW-603 permanent Test claim proof",
    reason: `${label} observation`,
    confirm: "enable-skills-sh-mirror-test",
    enabled: true,
    maxRowsPerRun: 50000,
    maxRowsPerBatch: 50,
    maxDetailBytes: 65536,
  });
  await writeCheckpoint(`${label}:configured`);
  const run = await runConvex("skillsShMirror:startRunInternal", {
    actor: "CLAW-603 permanent Test claim proof",
    reason: `${label} observation`,
    snapshotId: `claw-603-claim-proof:${label}:${Date.now()}`,
    sourceTotal: 1,
    sourcePageSize: 1,
    sourceMeasuredAt: new Date().toISOString(),
    sourceRequests: 0,
    sourceDurationMs: 0,
  });
  await writeCheckpoint(`${label}:run-started`, { run });
  const leaseToken = `claw-603-${label}-${Date.now()}`;
  await runConvex("skillsShMirror:claimBatchLeaseInternal", {
    runId: run.runId,
    page: 0,
    offset: 0,
    leaseToken,
  });
  await writeCheckpoint(`${label}:lease-claimed`, { runId: run.runId, page: 0, offset: 0 });
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
    rows: [mirrorRow(baseState, commit, contentHash, upstreamInstalls)],
  });
  await writeCheckpoint(`${label}:row-processed`, { runId: run.runId, processed });
  const canceled = await runConvex("skillsShMirror:cancelRunInternal", {
    runId: run.runId,
    actor: "CLAW-603 permanent Test claim proof",
    reason: `${label} row-scoped observation complete`,
    confirm: "cancel-skills-sh-mirror-test-run",
  });
  await writeCheckpoint(`${label}:run-canceled`, { runId: run.runId, canceled });
  await runConvex("skillsShMirror:configureInternal", {
    actor: "CLAW-603 permanent Test claim proof",
    reason: `${label} observation complete`,
    confirm: "enable-skills-sh-mirror-test",
    enabled: false,
    maxRowsPerRun: 50000,
    maxRowsPerBatch: 50,
    maxDetailBytes: 65536,
  });
  await writeCheckpoint(`${label}:control-disabled`, { runId: run.runId });
  return { run, processed, canceled };
}

const startedAt = new Date().toISOString();
const isolationBefore = await runConvex("skillsShMirror:getIsolationInternal", {});
const queuesBefore = await queueState();
const mirrorBefore = await readMirror();
assert(mirrorBefore.digest?.claimStatus === undefined, "controlled mirror claim is not fresh");
assert(mirrorBefore.digest?.publicVisible === true, "controlled mirror is not publicly visible");
const nativeBefore = await sourceState();
assert(
  nativeBefore?.source && nativeBefore.skills?.length === 4,
  "controlled native source mismatch",
);
const htmlBefore = nativeBefore.skills.find(
  (skill: Record<string, any>) => skill.githubPath === PATH,
);
assert(htmlBefore, "controlled HTML skill is missing");
assert(htmlBefore.githubCurrentCommit === COMMIT_A, "controlled HTML commit mismatch");
assert(htmlBefore.githubCurrentContentHash === HASH_A, "controlled HTML hash mismatch");
await writeCheckpoint("pre-mutation-baseline", {
  isolationBefore,
  queuesBefore,
  mirrorBefore,
  nativeBefore,
});

const star = await runConvex("stars:addStarInternal", {
  userId: htmlBefore.ownerUserId,
  skillId: htmlBefore._id,
});
await writeCheckpoint("bookmark-added", { star });
const initialClaim = await applyClaimedSnapshot(nativeBefore, COMMIT_A, HASH_A);
await writeCheckpoint("first-claim-pending", { initialClaim });
const pendingMirror = await readMirror();
const pendingSearch = await fetchCapture(
  `${PUBLIC_SITE}/api/v1/search?q=${encodeURIComponent(`skills-sh:${EXTERNAL_ID}`)}&mode=exact&limit=10`,
);
const pendingDetail = await fetchCapture(`${PUBLIC_SITE}/api/v1/skills-sh/${EXTERNAL_ID}`);
const pendingInstall = await fetchCapture(`${PUBLIC_SITE}/api/v1/skills-sh/${EXTERNAL_ID}/install`);
assert(pendingMirror.digest?.claimStatus === "pending", "first claim did not become pending");
assert(pendingMirror.digest?.claimAttempt === 1, "first claim attempt was not one");
assert(pendingMirror.digest?.publicVisible === true, "first pending claim was hidden");
assert(
  pendingDetail.status === 200 && pendingInstall.status === 200,
  "first pending claim is not public",
);

const firstFailure = await runConvex("skillsShClaims:applyTestVerdictInternal", {
  externalId: EXTERNAL_ID,
  phase: "first-claim",
  verdict: "fail",
  confirm: "fail-skills-sh-test-claim",
});
await writeCheckpoint("first-claim-failed", { firstFailure });
const failedMirror = await readMirror();
const failedDetail = await fetchCapture(`${PUBLIC_SITE}/api/v1/skills-sh/${EXTERNAL_ID}`);
assert(
  failedMirror.digest?.claimStatus === "failed",
  "explicit first-claim failure was not recorded",
);
assert(failedMirror.digest?.publicVisible === false, "failed mirror remained visible");
assert(failedDetail.status === 404, "failed mirror public detail did not disappear");

const correctedInstalls = Number(mirrorBefore.digest.upstreamInstalls) + 123;
const correctedObservation = await observeCorrectedMirror(
  mirrorBefore,
  COMMIT_B,
  HASH_B,
  correctedInstalls,
  "corrected",
);
const sourceAfterFailure = await sourceState();
const correctedClaim = await applyClaimedSnapshot(sourceAfterFailure, COMMIT_B, HASH_B);
await writeCheckpoint("corrected-claim-pending", { correctedClaim });
const correctedPendingSource = await sourceState();
const correctedContent = await cacheControlledPendingCandidateContent(
  correctedPendingSource,
  mirrorBefore,
  COMMIT_B,
  HASH_B,
);
await writeCheckpoint("corrected-claim-content-cached", { correctedContent });
const retryMirror = await readMirror();
assert(retryMirror.digest?.claimStatus === "pending", "corrected claim did not become pending");
assert(retryMirror.digest?.claimAttempt === 2, "corrected claim attempt was not two");
assert(retryMirror.digest?.publicVisible === false, "corrected retry became public before verdict");

const correctedPass = await runConvex("skillsShClaims:applyTestVerdictInternal", {
  externalId: EXTERNAL_ID,
  phase: "first-claim",
  verdict: "pass",
  confirm: "pass-skills-sh-test-claim",
});
await writeCheckpoint("corrected-claim-passed", { correctedPass });
const promotedMirror = await readMirror();
const promotedAlias = await runConvex("skillsShMirrorPublic:getByRoute", {
  owner: "patrick-erichsen",
  repo: "skills",
  slug: "html",
});
const promotedInstall = await fetchCapture(
  `${PUBLIC_SITE}/api/v1/skills-sh/${EXTERNAL_ID}/install`,
);
const nativePromoted = await sourceState();
const htmlPromoted = nativePromoted.skills.find(
  (skill: Record<string, any>) => skill.githubPath === PATH,
);
assert(promotedMirror.digest?.claimStatus === "promoted", "corrected claim did not promote");
assert(promotedAlias.kind === "redirect", "promoted mirror did not become a canonical redirect");
assert(promotedInstall.status === 200, "promoted alias install did not resolve");
assert(
  promotedInstall.body?.github?.commit === COMMIT_B &&
    promotedInstall.body?.github?.contentHash === HASH_B,
  "promoted alias did not resolve the corrected candidate",
);
assert(
  htmlPromoted?.statsStars === Number(htmlBefore.statsStars ?? 0) + (star.alreadyStarred ? 0 : 1),
  "bookmark count changed during promotion",
);
assert(
  htmlPromoted?.statsSkillsShInstalls === correctedInstalls,
  "skills.sh installs were not preserved separately",
);

const nativeFollowup = await applyNativeSnapshot(nativePromoted, COMMIT_C, HASH_C);
await writeCheckpoint("native-followup-pending", { nativeFollowup });
const nativeFollowupPendingSource = await sourceState();
const nativeFollowupContent = await cacheControlledPendingCandidateContent(
  nativeFollowupPendingSource,
  promotedMirror,
  COMMIT_C,
  HASH_C,
);
await writeCheckpoint("native-followup-content-cached", { nativeFollowupContent });
const followupFailure = await runConvex("skillsShClaims:applyTestVerdictInternal", {
  externalId: EXTERNAL_ID,
  phase: "native-followup",
  verdict: "fail",
  confirm: "fail-skills-sh-test-native-followup",
});
await writeCheckpoint("native-followup-failed", { followupFailure });
const aliasAfterFollowupFailure = await runConvex("skillsShMirrorPublic:getByRoute", {
  owner: "patrick-erichsen",
  repo: "skills",
  slug: "html",
});
const installAfterFollowupFailure = await fetchCapture(
  `${PUBLIC_SITE}/api/v1/skills-sh/${EXTERNAL_ID}/install`,
);
assert(aliasAfterFollowupFailure.kind === "redirect", "native follow-up failure removed redirect");
assert(
  installAfterFollowupFailure.body?.github?.commit === COMMIT_B &&
    installAfterFollowupFailure.body?.github?.contentHash === HASH_B,
  "native follow-up failure replaced the last passing candidate",
);

const sourceAfterFollowupFailure = await sourceState();
const restoration = await applyNativeSnapshot(sourceAfterFollowupFailure, COMMIT_A, HASH_A);
await writeCheckpoint("native-restoration-pending", { restoration });
const restorationPass = await runConvex("skillsShClaims:applyTestVerdictInternal", {
  externalId: EXTERNAL_ID,
  phase: "native-followup",
  verdict: "pass",
  confirm: "pass-skills-sh-test-native-followup",
});
await writeCheckpoint("native-restoration-passed", { restorationPass });
const restorationPendingSource = await sourceState();
const restorationContent = await cacheControlledPendingCandidateContent(
  restorationPendingSource,
  promotedMirror,
  COMMIT_A,
  HASH_A,
);
await writeCheckpoint("native-restoration-content-cached", { restorationContent });
const restoredSource = await sourceState();
const restoredHtml = restoredSource.skills.find(
  (skill: Record<string, any>) => skill.githubPath === PATH,
);
assert(restorationPass.phase === "native-followup", "restoration verdict phase mismatch");
assert(restoredHtml?.githubCurrentCommit === COMMIT_A, "native source commit was not restored");
assert(restoredHtml?.githubCurrentContentHash === HASH_A, "native source hash was not restored");
assert(restoredHtml?.githubScanStatus === "clean", "restored native source is not clean");
assert(
  restoredHtml?.githubPendingCandidateId === undefined,
  "restored native source still has a pending candidate",
);
const restoredObservation = await observeCorrectedMirror(
  promotedMirror,
  COMMIT_A,
  HASH_A,
  correctedInstalls,
  "restored",
);
const finalMirror = await readMirror();
const finalAlias = await runConvex("skillsShMirrorPublic:getByRoute", {
  owner: "patrick-erichsen",
  repo: "skills",
  slug: "html",
});
const finalInstall = await fetchCapture(`${PUBLIC_SITE}/api/v1/skills-sh/${EXTERNAL_ID}/install`);
const starRestoration = star.alreadyStarred
  ? { ok: true, unstarred: false, alreadyUnstarred: false, skipped: true }
  : await runConvex("stars:removeStarInternal", {
      userId: htmlBefore.ownerUserId,
      skillId: htmlBefore._id,
    });
await writeCheckpoint("bookmark-restored", { starRestoration });
const sourceAfterStarRestoration = await sourceState();
const htmlAfterStarRestoration = sourceAfterStarRestoration.skills.find(
  (skill: Record<string, any>) => skill.githubPath === PATH,
);
const isolationAfter = await runConvex("skillsShMirror:getIsolationInternal", {});
const queuesAfter = await queueState();

assert(finalMirror.digest?.githubCommit === COMMIT_A, "mirror commit was not restored");
assert(finalMirror.digest?.sourceContentHash === HASH_A, "mirror hash was not restored");
assert(finalMirror.digest?.claimStatus === "promoted", "final mirror claim is not settled");
assert(finalAlias.kind === "redirect", "final compatibility redirect is missing");
assert(
  finalInstall.body?.github?.commit === COMMIT_A,
  "final install does not resolve restored commit",
);
assert(
  finalInstall.body?.github?.contentHash === HASH_A,
  "final install does not resolve restored hash",
);
assert(
  htmlAfterStarRestoration?.statsStars === htmlBefore.statsStars,
  "bookmark count was not restored after claim proof",
);
assert(
  JSON.stringify(isolationAfter) === JSON.stringify(isolationBefore),
  "catalog or native scan isolation changed during claim proof",
);
assert(
  JSON.stringify(queuesAfter) === JSON.stringify(queuesBefore),
  "paid or automatic scan queues changed during claim proof",
);

const proof = {
  ok: true,
  startedAt,
  completedAt: new Date().toISOString(),
  target: { environment: "permanent Test", productionWrites: 0 },
  exactSource: {
    externalId: EXTERNAL_ID,
    repo: REPO,
    path: PATH,
    commit: COMMIT_A,
    contentHash: HASH_A,
  },
  isolationBefore,
  queuesBefore,
  star,
  firstClaim: { initialClaim, pendingMirror, pendingSearch, pendingDetail, pendingInstall },
  explicitFailure: { firstFailure, failedMirror, failedDetail },
  correctedCandidate: {
    commit: COMMIT_B,
    contentHash: HASH_B,
    upstreamInstalls: correctedInstalls,
    observation: correctedObservation,
    correctedClaim,
    retryMirror,
    correctedPass,
    promotedMirror,
    promotedAlias,
    promotedInstall,
    nativePromoted,
  },
  nativeFollowupFailure: {
    candidateCommit: COMMIT_C,
    candidateContentHash: HASH_C,
    nativeFollowup,
    followupFailure,
    aliasAfterFollowupFailure,
    installAfterFollowupFailure,
  },
  restoration: {
    restoration,
    restorationPass,
    restorationContent,
    restoredSource,
    restoredObservation,
  },
  final: {
    finalMirror,
    finalAlias,
    finalInstall,
    starRestoration,
    sourceAfterStarRestoration,
  },
  isolationAfter,
  queuesAfter,
  scansPlanned: 0,
  scansAdmitted: 0,
  paidScans: 0,
};

await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(proof)}\n`);
