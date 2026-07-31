import { describe, expect, it } from "vitest";
import {
  assertControlledMirrorRecoveryMetadata,
  assertControlledProofBookmark,
  buildControlledCandidateContent,
  classifyClaimRecoveryState,
} from "./claw-603-claim-proof-helpers";

describe("CLAW-603 claim proof candidate content", () => {
  it("binds cached markdown to the exact controlled candidate after validating the pinned file hash", () => {
    const content = "# HTML\n";
    const result = buildControlledCandidateContent({
      mirror: {
        digest: {
          externalId: "patrick-erichsen/skills/html",
          slug: "html",
          displayName: "HTML",
          githubPath: "skills/html",
        },
        detail: {
          path: "skills/html/SKILL.md",
          content,
        },
      },
      expectedExternalId: "patrick-erichsen/skills/html",
      expectedPath: "skills/html",
      expectedFileHash: "50361c318c6720f33fe0e061bd4bc97e0fcc7d135b676701a9a2ef626e830339",
      candidateCommit: "a".repeat(40),
      candidateContentHash: "b".repeat(64),
    });

    expect(result).toEqual({
      slug: "html",
      displayName: "HTML",
      path: "skills/html",
      skillMarkdownPath: "skills/html/SKILL.md",
      skillMarkdown: content,
      contentHash: "b".repeat(64),
    });
  });

  it("rejects markdown that is not the exact pinned controlled source", () => {
    expect(() =>
      buildControlledCandidateContent({
        mirror: {
          digest: {
            externalId: "patrick-erichsen/skills/html",
            slug: "html",
            displayName: "HTML",
            githubPath: "skills/html",
          },
          detail: {
            path: "skills/html/SKILL.md",
            content: "# changed\n",
          },
        },
        expectedExternalId: "patrick-erichsen/skills/html",
        expectedPath: "skills/html",
        expectedFileHash: "50361c318c6720f33fe0e061bd4bc97e0fcc7d135b676701a9a2ef626e830339",
        candidateCommit: "a".repeat(40),
        candidateContentHash: "b".repeat(64),
      }),
    ).toThrow("controlled candidate markdown hash mismatch");
  });

  it("requires every replayed mirror field to match the captured recovery fixture", () => {
    const mirror = {
      digest: {
        externalId: "patrick-erichsen/skills/html",
        sourceType: "github",
        upstreamSourceType: "controlled-github",
        owner: "patrick-erichsen",
        repo: "skills",
        slug: "html",
        displayName: "HTML",
        sourceUrl: "https://www.skills.sh/patrick-erichsen/skills/html",
        canonicalRepoUrl: "https://github.com/patrick-erichsen/skills",
        githubPath: "skills/html",
        upstreamInstalls: 123,
        upstreamScanners: { socket: { status: "unavailable" } },
        inferredCategories: ["other"],
        inferredTopics: [],
        inferredCategoryConfidence: "low",
        inferredTopicConfidence: "low",
        inferredClassifierVersion: "taxonomy-v1",
        inferredTopicClassifierVersion: "topic-v1",
        inferredInputHash: "input",
        inferredTopicInputHash: "topic-input",
        inferredAt: 1234,
      },
      detail: {
        contentKind: "skill-md",
        path: "skills/html/SKILL.md",
        content: "# HTML\n",
        contentBytes: 7,
        sourceBytes: 7,
        sourceFileCount: 1,
        truncated: false,
      },
    };
    const expected = {
      digest: { ...mirror.digest },
      detail: {
        contentKind: "skill-md",
        path: "skills/html/SKILL.md",
        contentSha256: "50361c318c6720f33fe0e061bd4bc97e0fcc7d135b676701a9a2ef626e830339",
        contentBytes: 7,
        sourceBytes: 7,
        sourceFileCount: 1,
        truncated: false,
      },
    };

    expect(() => assertControlledMirrorRecoveryMetadata({ mirror, expected })).not.toThrow();
    expect(() =>
      assertControlledMirrorRecoveryMetadata({
        mirror: {
          ...mirror,
          digest: { ...mirror.digest, upstreamInstalls: 124 },
        },
        expected,
      }),
    ).toThrow("controlled mirror recovery metadata mismatch");
  });

  it("accepts only the exact Bookmark created by the interrupted proof", () => {
    const expected = {
      id: "stars:proof",
      skillId: "skills:html",
      userId: "users:owner",
      createdAt: 1234,
      hourlyStatsRecordedAt: 1234,
    };

    expect(() =>
      assertControlledProofBookmark({
        star: {
          _id: "stars:proof",
          skillId: "skills:html",
          userId: "users:owner",
          createdAt: 1234,
          hourlyStatsRecordedAt: 1234,
        },
        expected,
        currentSkillStars: 1,
        baselineSkillStars: 0,
      }),
    ).not.toThrow();
    expect(() =>
      assertControlledProofBookmark({
        star: {
          _id: "stars:someone-else",
          skillId: "skills:html",
          userId: "users:owner",
          createdAt: 1234,
          hourlyStatsRecordedAt: 1234,
        },
        expected,
        currentSkillStars: 1,
        baselineSkillStars: 0,
      }),
    ).toThrow("controlled proof Bookmark does not match the interrupted proof");
  });

  it.each([
    {
      expected: "candidate-pending",
      mirrorCommit: "b",
      nativeCommit: "b",
      pendingCandidate: true,
      proofBookmark: true,
    },
    {
      expected: "native-restored",
      mirrorCommit: "b",
      nativeCommit: "a",
      pendingCandidate: false,
      proofBookmark: true,
    },
    {
      expected: "mirror-restored-candidate-pending",
      mirrorCommit: "a",
      nativeCommit: "b",
      pendingCandidate: true,
      proofBookmark: true,
    },
    {
      expected: "mirror-restored",
      mirrorCommit: "a",
      nativeCommit: "a",
      pendingCandidate: false,
      proofBookmark: true,
    },
    {
      expected: "complete",
      mirrorCommit: "a",
      nativeCommit: "a",
      pendingCandidate: false,
      proofBookmark: false,
    },
  ])("recognizes the retry-safe recovery phase $expected", (fixture) => {
    expect(
      classifyClaimRecoveryState({
        ...fixture,
        restoredCommit: "a",
        contaminatingCommit: "b",
      }),
    ).toBe(fixture.expected);
  });

  it("rejects recovery state outside the exact monotonic path", () => {
    expect(() =>
      classifyClaimRecoveryState({
        mirrorCommit: "b",
        nativeCommit: "a",
        pendingCandidate: true,
        proofBookmark: true,
        restoredCommit: "a",
        contaminatingCommit: "b",
      }),
    ).toThrow("controlled claim recovery state is not resumable");
  });
});
