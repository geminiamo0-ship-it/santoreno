import type { SantoEnvironment } from "@santo/contracts";

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

export interface R2ObjectBodyLike {
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export interface R2BucketLike {
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string): Promise<void>;
}

export interface DurableObjectStubLike {
  fetch(input: Request | string): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface QueueLike {
  send(message: unknown): Promise<void>;
}

export interface AnalyticsEngineDatasetLike {
  writeDataPoint(event: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface AiSearchNamespaceLike {
  list(): Promise<unknown>;
  search(input: unknown): Promise<unknown>;
}

export interface WorkersAiLike {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface QueueMessageLike<T = unknown> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface QueueBatchLike<T = unknown> {
  messages: readonly QueueMessageLike<T>[];
}

export interface SantoBindings {
  SANTO_ENV?: SantoEnvironment;
  INFRA_SMOKE_TOKEN?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_ISSUER?: string;
  WORKOS_JWKS_URL?: string;
  SANTO_SUPER_ADMIN_USER_IDS?: string;
  SANTO_SESSION_SIGNING_KEY?: string;
  SANTO_SESSION_TTL_SECONDS?: string;
  SANTO_AI_MODEL?: string;
  SANTO_LUNA_PREVIEW?: string;
  SANTO_RESEARCH_ENABLED?: string;
  SANTO_RESEARCH_QWEN_V1?: string;
  NCBI_API_KEY?: string;
  OPENALEX_API_KEY?: string;
  SANTO_SINGLE_PASS_GENERATION_V1?: string;
  SANTO_COMPACT_CITATION_ALIASES_V1?: string;
  SANTO_PLAIN_TEXT_LUNA_V1?: string;
  SANTO_LUNA_UNIFIED_PROMPT_V1?: string;
  SANTO_NATIVE_STREAMING_V1?: string;
  SANTO_AI_SEARCH_INSTANCE_IDS?: string;
  SANTO_COPILOT_ROUTING_V1?: string;
  SANTO_GENERAL_MEDICAL_FALLBACK?: string;
  SANTO_MEDICAL_RETRIEVAL_V2?: string;
  SANTO_AI_SEARCH_SINGLE_REQUEST_V1?: string;
  SANTO_MEDICAL_QUERY_REWRITE_V1?: string;
  SANTO_AMBOSS_ADJACENT_R2_V1?: string;
  SANTO_QWEN_ROUTING_V1?: string;
  SANTO_LUNA_RICH_IMAGES_V1?: string;
  SANTO_GALLERY_IMAGES_V1?: string;
  SANTO_ANKING_CARDS_V1?: string;
  SANTO_ANKING_V12_FULL_SEARCH_V1?: string;
  SANTO_SEARCH_FAST_PATH_V1?: string;
  SANTO_EXCLUSIVE_SOURCE_MODES_V1?: string;
  SANTO_ANKING_RIGHTS_CLEARED_V1?: string;
  SANTO_LIBRARY_READER_V1?: string;
  CONTROL_DB?: D1DatabaseLike;
  CONTENT_BUCKET?: R2BucketLike;
  TENANT_METER?: DurableObjectNamespaceLike;
  CONVERSATION?: DurableObjectNamespaceLike;
  EVENT_QUEUE?: QueueLike;
  USAGE_ANALYTICS?: AnalyticsEngineDatasetLike;
  AI_SEARCH?: AiSearchNamespaceLike;
  AI?: WorkersAiLike;
}
