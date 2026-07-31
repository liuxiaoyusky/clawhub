import { createHash } from "node:crypto";

type ControlledMirrorState = {
  digest?: {
    externalId?: string;
    sourceType?: string;
    upstreamSourceType?: string;
    owner?: string;
    repo?: string;
    slug?: string;
    displayName?: string;
    sourceUrl?: string;
    canonicalRepoUrl?: string;
    githubPath?: string;
    upstreamInstalls?: number;
    upstreamScanners?: unknown;
    inferredCategories?: unknown;
    inferredTopics?: unknown;
    inferredCategoryConfidence?: string;
    inferredTopicConfidence?: string;
    inferredClassifierVersion?: string;
    inferredTopicClassifierVersion?: string;
    inferredInputHash?: string;
    inferredTopicInputHash?: string;
    inferredAt?: number;
    summary?: string;
  };
  detail?: {
    contentKind?: string;
    path?: string;
    content?: string;
    contentBytes?: number;
    sourceBytes?: number;
    sourceFileCount?: number;
    truncated?: boolean;
  };
};

type ControlledMirrorRecoveryMetadata = {
  digest: {
    externalId: unknown;
    sourceType: unknown;
    upstreamSourceType: unknown;
    owner: unknown;
    repo: unknown;
    slug: unknown;
    displayName: unknown;
    sourceUrl: unknown;
    canonicalRepoUrl: unknown;
    githubPath: unknown;
    upstreamInstalls: unknown;
    upstreamScanners: unknown;
    inferredCategories: unknown;
    inferredTopics: unknown;
    inferredCategoryConfidence: unknown;
    inferredTopicConfidence: unknown;
    inferredClassifierVersion: unknown;
    inferredTopicClassifierVersion: unknown;
    inferredInputHash: unknown;
    inferredTopicInputHash: unknown;
    inferredAt: unknown;
  };
  detail: {
    contentKind: unknown;
    path: unknown;
    contentSha256: string;
    contentBytes: unknown;
    sourceBytes: unknown;
    sourceFileCount: unknown;
    truncated: unknown;
  };
};

export function assertControlledMirrorRecoveryMetadata(args: {
  mirror: ControlledMirrorState;
  expected: ControlledMirrorRecoveryMetadata;
}) {
  const { digest, detail } = args.mirror;
  if (!digest || !detail || typeof detail.content !== "string") {
    throw new Error("controlled mirror recovery metadata is incomplete");
  }
  const actual: ControlledMirrorRecoveryMetadata = {
    digest: {
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
    },
    detail: {
      contentKind: detail.contentKind,
      path: detail.path,
      contentSha256: createHash("sha256").update(detail.content).digest("hex"),
      contentBytes: detail.contentBytes,
      sourceBytes: detail.sourceBytes,
      sourceFileCount: detail.sourceFileCount,
      truncated: detail.truncated,
    },
  };
  if (JSON.stringify(actual) !== JSON.stringify(args.expected)) {
    throw new Error("controlled mirror recovery metadata mismatch");
  }
}

export function assertControlledProofBookmark(args: {
  star: {
    _id?: string;
    skillId?: string;
    userId?: string;
    createdAt?: number;
    hourlyStatsRecordedAt?: number;
  } | null;
  expected: {
    id: string;
    skillId: string;
    userId: string;
    createdAt: number;
    hourlyStatsRecordedAt: number;
  };
  currentSkillStars: number;
  baselineSkillStars: number;
}) {
  const { star, expected } = args;
  if (
    !star ||
    star._id !== expected.id ||
    star.skillId !== expected.skillId ||
    star.userId !== expected.userId ||
    star.createdAt !== expected.createdAt ||
    star.hourlyStatsRecordedAt !== expected.hourlyStatsRecordedAt ||
    args.currentSkillStars !== args.baselineSkillStars + 1
  ) {
    throw new Error("controlled proof Bookmark does not match the interrupted proof");
  }
}

export function classifyClaimRecoveryState(args: {
  mirrorCommit: string;
  nativeCommit: string;
  pendingCandidate: boolean;
  proofBookmark: boolean;
  restoredCommit: string;
  contaminatingCommit: string;
}) {
  if (
    args.mirrorCommit === args.contaminatingCommit &&
    args.nativeCommit === args.contaminatingCommit &&
    args.pendingCandidate &&
    args.proofBookmark
  ) {
    return "candidate-pending" as const;
  }
  if (
    args.mirrorCommit === args.contaminatingCommit &&
    args.nativeCommit === args.restoredCommit &&
    !args.pendingCandidate &&
    args.proofBookmark
  ) {
    return "native-restored" as const;
  }
  if (
    args.mirrorCommit === args.restoredCommit &&
    args.nativeCommit === args.contaminatingCommit &&
    args.pendingCandidate &&
    args.proofBookmark
  ) {
    return "mirror-restored-candidate-pending" as const;
  }
  if (
    args.mirrorCommit === args.restoredCommit &&
    args.nativeCommit === args.restoredCommit &&
    !args.pendingCandidate
  ) {
    return args.proofBookmark ? ("mirror-restored" as const) : ("complete" as const);
  }
  throw new Error("controlled claim recovery state is not resumable");
}

export function buildControlledCandidateContent(args: {
  mirror: ControlledMirrorState;
  expectedExternalId: string;
  expectedPath: string;
  expectedFileHash: string;
  candidateCommit: string;
  candidateContentHash: string;
}) {
  const { digest, detail } = args.mirror;
  if (
    digest?.externalId !== args.expectedExternalId ||
    digest.githubPath !== args.expectedPath ||
    detail?.path !== `${args.expectedPath}/SKILL.md` ||
    typeof detail.content !== "string"
  ) {
    throw new Error("controlled candidate source does not match the exact fixture");
  }
  if (!/^[0-9a-f]{40}$/.test(args.candidateCommit)) {
    throw new Error("controlled candidate commit is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(args.candidateContentHash)) {
    throw new Error("controlled candidate content hash is invalid");
  }
  const fileHash = createHash("sha256").update(detail.content).digest("hex");
  if (fileHash !== args.expectedFileHash) {
    throw new Error("controlled candidate markdown hash mismatch");
  }
  if (!digest.slug || !digest.displayName) {
    throw new Error("controlled candidate display metadata is incomplete");
  }
  return {
    slug: digest.slug,
    displayName: digest.displayName,
    ...(digest.summary ? { summary: digest.summary } : {}),
    path: args.expectedPath,
    skillMarkdownPath: detail.path,
    skillMarkdown: detail.content,
    contentHash: args.candidateContentHash,
  };
}
