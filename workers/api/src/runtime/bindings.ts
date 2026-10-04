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
}

export interface R2BucketLike {
  put(key: string, value: string): Promise<unknown>;
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
  CONTROL_DB?: D1DatabaseLike;
  CONTENT_BUCKET?: R2BucketLike;
  TENANT_METER?: DurableObjectNamespaceLike;
  CONVERSATION?: DurableObjectNamespaceLike;
  EVENT_QUEUE?: QueueLike;
  USAGE_ANALYTICS?: AnalyticsEngineDatasetLike;
  AI_SEARCH?: AiSearchNamespaceLike;
}
