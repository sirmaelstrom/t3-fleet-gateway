import * as z from 'zod';
import { threadLink, threadLinkTarget } from '../threadId.js';
import { responseThreadIdSchema } from './threadId.ts';

/** The fields of `t3_environment_read` the gateway relies on. Extra fields are kept, not validated. */
export const environmentSchema = z.looseObject({
  environmentId: z.string(),
  serverVersion: z.string(),
  platform: z.looseObject({ os: z.string(), arch: z.string() }),
});
export type T3Environment = z.infer<typeof environmentSchema>;

export const projectSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  deletedAt: z.string().nullable().optional(),
  pinnedAt: z.string().nullish(),
  archivedAt: z.string().nullish(),
  /** The folder the project points at on its host. Only the workspace probe uses it; never shown to agents or logged. */
  workspaceRoot: z.string().nullish(),
  /** The model T3 uses for a launch that passes no `modelSelection`; without one, such a launch is refused. */
  defaultModelSelection: z.unknown().optional(),
});
export type T3Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.looseObject({
  projects: z.array(projectSchema),
  nextCursor: z.number().int().nullable().optional(),
});

/** The fields of `orchestrator_capabilities` the gateway relies on; T3's result has more (features, inherited model). */
export const capabilitiesSchema = z.looseObject({
  providers: z.array(
    z.looseObject({
      providerInstanceId: z.string().min(1),
      driverKind: z.string(),
      displayName: z.string().nullish(),
      // Parse entries independently after transport validation: one bad model must not hide its siblings.
      models: z.array(z.unknown()),
      omittedModels: z.number().int().nonnegative().optional(),
      runtimeModes: z.array(z.string()).nullish(),
      /** Whether this provider may run a delegated child task inside T3: metadata, not proof that a top-level launch works. */
      canRunChildTask: z.boolean().nullish(),
      canRunCrossProviderChildTask: z.boolean().nullish(),
      constraints: z.array(z.string()).nullish(),
    }),
  ),
});
export type T3Capabilities = z.infer<typeof capabilitiesSchema>;

/**
 * Thread and run status values T3 documents. Outputs are parsed as plain strings so that a status
 * added by a newer T3 does not break watching; the job layer treats unrecognised values as active.
 */
export const THREAD_STATUSES = [
  'idle',
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
] as const;

/** A run is still going (or about to) in these statuses. `waiting` means it is blocked on the user. */
export const ACTIVE_RUN_STATUSES: readonly string[] = ['preparing', 'queued', 'starting', 'running', 'waiting'];

export const RUNTIME_MODE_VALUES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;

/** The `workspaceStrategy` forms of `t3_thread_launch` the gateway sends: a fresh worktree, or the project's own folder. */
export type LaunchWorkspaceStrategy =
  | { type: 'worktree'; baseRef: string; branch: string; startFromOrigin: boolean }
  | { type: 'root' };

/** Input of `t3_thread_launch` as the gateway sends it (a subset of what T3 accepts). */
export type LaunchThreadInput = {
  clientRequestId?: string;
  title: string;
  runtimeMode: (typeof RUNTIME_MODE_VALUES)[number];
  modelSelection?: Record<string, unknown>;
  message: string;
  attachments?: T3Attachment[];
} & (
  | { projectId: string; workspaceStrategy: LaunchWorkspaceStrategy; scratch?: never }
  // T3's own scratch workspace: T3 files the thread under its scratch project and gives it a folder of its own. T3 refuses
  // `scratch` together with `projectId` or `workspaceStrategy`, so a scratch launch sends neither.
  | { scratch: true; projectId?: never; workspaceStrategy?: never }
);

/** Prefer T3's usable link (v2 names its environment); missing or unusable links get a canonical v1 fallback. */
function withThreadLink<T extends { threadId: string; link?: string | null }>(thread: T) {
  const canonical = threadLink(thread.threadId);
  return { ...thread, link: canonical === null ? null : threadLinkTarget(thread.link) ?? canonical };
}

export const launchResultSchema = z.looseObject({
  threadId: responseThreadIdSchema,
  link: z.string().nullish(),
  projectId: z.string(),
  runId: z.string().nullable(),
  status: z.string().nullable(),
}).transform(withThreadLink);
export type LaunchResult = z.infer<typeof launchResultSchema>;

export const threadSummarySchema = z.looseObject({
  threadId: responseThreadIdSchema,
  link: z.string().nullish(),
  title: z.string(),
  status: z.string(),
  latestRunId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  settled: z.boolean().optional(),
  settledAt: z.string().nullable().optional(),
  archived: z.boolean().optional(),
}).transform(withThreadLink);

export const threadListSchema = z.looseObject({
  projectId: z.string(),
  threads: z.array(threadSummarySchema),
  nextCursor: z.number().int().nullable(),
  total: z.number().int(),
});
// Catalog discovery validates individual rows after checking the raw page bounds. Other list consumers validate bounded opaque ids.
export const threadCatalogPageSchema = threadListSchema.extend({ threads: z.array(z.unknown()) });

export type ThreadList = z.infer<typeof threadListSchema>;

export const threadSearchSchema = z.looseObject({
  matches: z.array(
    z.looseObject({
      threadId: responseThreadIdSchema,
      projectId: z.string(),
      source: z.string(),
      snippet: z.string(),
    }),
  ),
});
export type ThreadSearch = z.infer<typeof threadSearchSchema>;

export const threadItemSchema = z.looseObject({
  position: z.number().int(),
  itemId: z.string(),
  runId: z.string().nullable(),
  createdBy: z.string().nullable(),
  creationSource: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  updatedAt: z.string(),
  /** Set on some item types: a `subagent` item's title is the delegated task's title. */
  title: z.string().nullable().optional(),
});
export type ThreadItem = z.infer<typeof threadItemSchema>;

export const threadRunSchema = z.looseObject({
  runId: z.string(),
  ordinal: z.number().int(),
  status: z.string(),
  completedAt: z.string().nullable(),
});

export const threadReadSchema = z.looseObject({
  thread: z.looseObject({
    threadId: responseThreadIdSchema,
    link: z.string().nullish(),
    projectId: z.string(),
    title: z.string(),
    status: z.string(),
    latestRunId: z.string().nullable(),
    activeRunId: z.string().nullable(),
    pendingRequestCount: z.number().int(),
    settled: z.boolean().optional(),
    settledAt: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    relationshipToParent: z.string().nullable().optional(),
    runtimeMode: z.string().optional(),
    branch: z.string().nullable(),
    updatedAt: z.string(),
  }).transform(withThreadLink),
  recentRuns: z.array(threadRunSchema),
  items: z.array(threadItemSchema),
  nextPosition: z.number().int().nullable(),
  hasMore: z.boolean(),
});
export type ThreadRead = z.infer<typeof threadReadSchema>;

export const sendResultSchema = z.looseObject({
  threadId: responseThreadIdSchema,
  messageId: z.string(),
  runId: z.string(),
  status: z.string(),
  delivery: z.string(),
});
export type SendResult = z.infer<typeof sendResultSchema>;

export const interruptResultSchema = z.looseObject({
  threadId: responseThreadIdSchema,
  runId: z.string().nullable(),
  status: z.string(),
});
export type InterruptResult = z.infer<typeof interruptResultSchema>;

/** Both legacy pending-request tools and t3_pending_request actions return these same payloads. */
export const pendingRequestListSchema = z.looseObject({ requestIds: z.array(z.string()) });

export const pendingRequestSchema = z.looseObject({
  requestId: z.string(),
  questions: z.array(
    z.looseObject({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      options: z.array(z.looseObject({ label: z.string(), description: z.string(), value: z.string().nullable().optional() })),
      multiSelect: z.boolean().nullable().optional(),
      allowCustomAnswer: z.boolean().nullable().optional(),
      required: z.boolean().nullable().optional(),
    }),
  ).nullable(),
});
export type PendingRequest = z.infer<typeof pendingRequestSchema>;

export const respondResultSchema = z.looseObject({ sequence: z.number().int() });

/** Metadata returned to T3 after its signed upload has received the bytes. */
export interface T3Attachment {
  id: string;
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  sizeBytes: number;
}
export const attachmentUploadSchema = z.object({
  attachmentId: z.string().min(1).max(256),
  relativeUrl: z.string().min(1).max(4096),
  expiresAt: z.number(),
});
export const attachmentSendSchema = z.object({
  threadId: z.string().min(1), messageId: z.string().min(1), runId: z.string().min(1), status: z.string(),
});
