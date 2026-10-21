import type {
  QuotaConfigureRequest,
  QuotaFinalizeRequest,
  QuotaOperationResponse,
  QuotaReadRequest,
  QuotaReleaseRequest,
  QuotaReserveRequest,
  QuotaSnapshot,
  Tenant,
} from "@santo/contracts";
import { GroundedAiStreamEventSchema } from "@santo/contracts/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaService } from "../quota/types";
import type { SantoBindings } from "../runtime/bindings";
import type { SourceSnapshotWriter } from "../sources/store";
import type {
  ExternalUserRecord,
  ExternalUserRepository,
  UpsertExternalUserInput,
} from "../session/repository";
import { SantoSessionTokenService } from "../session/token";
import type { TenantMembership, TenantRepository } from "../tenancy/repository";
import { createGroundedAiHandler } from "./handler";
import type { AiTelemetryEvent, AiTelemetryPort, ModelPort, RetrievalPort } from "./types";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "58392";
const SIGNING_KEY = "test-signing-key-that-is-longer-than-thirty-two-characters";
const SOURCE_ID = "medical:chunk-1";

const tenant: Tenant = {
  id: TENANT_ID,
  slug: "medpark",
  name: "MedPark",
  status: "active",
  workosOrgId: "org_test",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const user: ExternalUserRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  tenantId: TENANT_ID,
  externalUserId: USER_ID,
  email: null,
  displayName: null,
  status: "active",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

function snapshot(used: number, reserved: number): QuotaSnapshot {
  return {
    tenantId: TENANT_ID,
    externalUserId: USER_ID,
    cycleStartAt: "2026-10-01T00:00:00.000Z",
    cycleEndAt: "2026-11-01T00:00:00.000Z",
    expiresAt: null,
    tenantStatus: "active",
    userStatus: "active",
    tenant: { limit: 10, used, reserved, remaining: Math.max(0, 10 - used - reserved) },
    user: { limit: 10, used, reserved, remaining: Math.max(0, 10 - used - reserved) },
  };
}

class FakeQuotaService implements QuotaService {
  reserveCalls = 0;
  finalizeCalls = 0;
  releaseCalls = 0;
  used = 0;
  exhausted = false;
  private readonly finalized = new Set<string>();
  private readonly reserved = new Set<string>();

  configure(_request: QuotaConfigureRequest): Promise<QuotaSnapshot> {
    return Promise.resolve(snapshot(this.used, this.reserved.size));
  }

  read(_request: QuotaReadRequest): Promise<QuotaSnapshot> {
    return Promise.resolve(snapshot(this.used, this.reserved.size));
  }

  reserve(request: QuotaReserveRequest): Promise<QuotaOperationResponse> {
    this.reserveCalls += 1;
    if (this.exhausted) {
      return Promise.resolve({
        allowed: false,
        reservationStatus: "denied",
        denialReason: "USER_EXHAUSTED",
        snapshot: snapshot(this.used, this.reserved.size),
      });
    }
    if (this.finalized.has(request.idempotencyKey)) {
      return Promise.resolve({
        allowed: true,
        reservationStatus: "finalized",
        denialReason: null,
        snapshot: snapshot(this.used, this.reserved.size),
      });
    }
    this.reserved.add(request.idempotencyKey);
    return Promise.resolve({
      allowed: true,
      reservationStatus: "reserved",
      denialReason: null,
      snapshot: snapshot(this.used, this.reserved.size),
    });
  }

  finalize(request: QuotaFinalizeRequest): Promise<QuotaOperationResponse> {
    this.finalizeCalls += 1;
    if (!this.finalized.has(request.idempotencyKey)) {
      this.finalized.add(request.idempotencyKey);
      this.reserved.delete(request.idempotencyKey);
      this.used += 1;
    }
    return Promise.resolve({
      allowed: true,
      reservationStatus: "finalized",
      denialReason: null,
      snapshot: snapshot(this.used, this.reserved.size),
    });
  }

  release(request: QuotaReleaseRequest): Promise<QuotaOperationResponse> {
    this.releaseCalls += 1;
    this.reserved.delete(request.idempotencyKey);
    return Promise.resolve({
      allowed: false,
      reservationStatus: "released",
      denialReason: "RESERVATION_RELEASED",
      snapshot: snapshot(this.used, this.reserved.size),
    });
  }
}

function tenantRepository(): TenantRepository {
  return {
    createTenantWithOwner: async () => tenant,
    findTenantById: async (tenantId) => (tenantId === TENANT_ID ? tenant : null),
    findTenantByWorkOSOrgId: async () => tenant,
    findMembership: async (): Promise<TenantMembership | null> => null,
    updateTenantName: async () => tenant,
  };
}

function externalUserRepository(): ExternalUserRepository {
  return {
    upsertExternalUser: async (_input: UpsertExternalUserInput) => user,
    findByTenantAndExternalId: async (tenantId, externalUserId) =>
      tenantId === TENANT_ID && externalUserId === USER_ID ? user : null,
  };
}

function request(
  token: string,
  idempotencyKey = "query-1",
  query = "What is the normal serum sodium range?",
  libraryId?: string,
): Request {
  return new Request("https://santo.test/v1/ai/query", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      idempotency_key: idempotencyKey,
      ...(libraryId ? { library_id: libraryId } : {}),
    }),
  });
}

describe("grounded AI handler", () => {
  let env: SantoBindings;
  let quota: FakeQuotaService;
  let retrieval: RetrievalPort;
  let model: ModelPort;
  let telemetryEvents: AiTelemetryEvent[];
  let telemetry: AiTelemetryPort;
  let token: string;
  let stageTimeouts: { retrievalMs: number; modelMs: number };

  beforeEach(async () => {
    env = {
      SANTO_ENV: "local",
      SANTO_SESSION_SIGNING_KEY: SIGNING_KEY,
      SANTO_SESSION_TTL_SECONDS: "900",
    };
    quota = new FakeQuotaService();
    stageTimeouts = { retrievalMs: 15000, modelMs: 90000 };
    retrieval = {
      retrieve: vi.fn(async () => [
        {
          sourceId: SOURCE_ID,
          libraryId: "medical",
          instanceId: "medical",
          itemKey: "electrolytes.md",
          title: "Electrolytes",
          page: 12,
          section: "Sodium disorders",
          text: "Normal serum sodium is generally 135 to 145 mmol/L.",
          score: 0.91,
        },
      ]),
    };
    model = {
      generate: vi.fn(async () => ({
        answer: "The cited source gives a normal serum sodium range of 135–145 mmol/L.",
        citationIds: [SOURCE_ID],
      })),
    };
    telemetryEvents = [];
    telemetry = {
      record: (event) => telemetryEvents.push(event),
    };
    token = (
      await new SantoSessionTokenService(env).issue({
        tenantId: TENANT_ID,
        externalUserId: USER_ID,
      })
    ).token;
  });

  function handler(sourceStore?: SourceSnapshotWriter) {
    return createGroundedAiHandler({
      tenantRepositoryFactory: () => tenantRepository(),
      externalUserRepositoryFactory: () => externalUserRepository(),
      quotaServiceFactory: () => quota,
      retrievalFactory: () => retrieval,
      modelFactory: () => model,
      telemetryFactory: () => telemetry,
      stageTimeouts,
      sourceStoreFactory: () => sourceStore ?? null,
    });
  }

  it("answers unambiguous CHAT from Qwen without invoking Luna, retrieval or source snapshots", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_QWEN_ROUTING_V1 = "true";
    retrieval.route = vi.fn(async () => ({ intent: "chat" as const, answer: "Hello from Qwen!" }));
    retrieval.retrieve = vi.fn(async () => {
      throw new Error("medical retrieval must not run");
    });
    const save = vi.fn(async () => undefined);
    const response = await handler({ save })(request(token, "social-1", "Hi"), env);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.answer).toBe("Hello from Qwen!");
    expect(payload.citations).toEqual([]);
    expect(payload.groundingMode).toBe("general");
    expect(quota.reserveCalls).toBe(1);
    expect(quota.finalizeCalls).toBe(1);
    expect(quota.releaseCalls).toBe(0);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(model.generate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("records request-correlated Qwen routing outcomes without student text", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_QWEN_ROUTING_V1 = "true";
    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => undefined);
    retrieval.route = vi.fn(async (request) => {
      request.onRouteDiagnostic?.("success_chat", 43);
      return { intent: "chat" as const, answer: "Hello!" };
    });
    try {
      const response = await handler()(request(token, "diag-1", "hi"), env);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.answer).toBe("Hello!");
      expect(model.generate).not.toHaveBeenCalled();
      expect(diagnostics).toHaveBeenCalledWith(
        "santo_qwen_route_outcome",
        expect.objectContaining({
          requestId: expect.any(String),
          outcome: "success_chat",
          milliseconds: 43,
        }),
      );
      const events = diagnostics.mock.calls.filter(
        ([event]) => event === "santo_qwen_route_outcome",
      );
      expect(JSON.stringify(events)).not.toContain("Hello!");
      expect(quota.finalizeCalls).toBe(1);
    } finally {
      diagnostics.mockRestore();
    }
  });

  it("persistently finalizes a Qwen CLARIFY question without Luna or medical retrieval", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_QWEN_ROUTING_V1 = "true";
    retrieval.route = vi.fn(async () => ({
      intent: "clarify" as const,
      question: "Do you mean diagnosis or treatment?",
    }));
    retrieval.retrieve = vi.fn(async () => {
      throw new Error("retrieval must wait for clarification");
    });
    const save = vi.fn(async () => undefined);
    const response = await handler({ save })(request(token, "clarify-1", "ttt?"), env);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.answer).toBe("Do you mean diagnosis or treatment?");
    expect(payload.citations).toEqual([]);
    expect(payload.groundingMode).toBe("general");
    expect(quota.reserveCalls).toBe(1);
    expect(quota.finalizeCalls).toBe(1);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(model.generate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("uses Qwen's prepared MEDICAL query without a second rewrite and preserves citation verification", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_QWEN_ROUTING_V1 = "true";
    retrieval.route = vi.fn(async () => ({
      intent: "medical" as const,
      searchQuery: "aortic stenosis diagnosis",
    }));
    const response = await handler()(request(token, "medical-1", "تشخيص ضيق الصمام"), env);
    expect(response.status).toBe(200);
    expect(retrieval.route).toHaveBeenCalledTimes(1);
    expect(retrieval.retrieve).toHaveBeenCalledWith({
      query: "تشخيص ضيق الصمام",
      libraryId: null,
      preparedQuery: "aortic stenosis diagnosis",
    });
    expect(model.generate).toHaveBeenCalledTimes(1);
    const payload = await response.json();
    expect(payload.citations).toHaveLength(1);
    expect(quota.finalizeCalls).toBe(1);
  });

  it("removes old instructional blocks from the source prompt in unified staging", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_LUNA_PREVIEW = "true";
    env.SANTO_SINGLE_PASS_GENERATION_V1 = "true";
    env.SANTO_PLAIN_TEXT_LUNA_V1 = "true";
    env.SANTO_LUNA_UNIFIED_PROMPT_V1 = "true";
    const response = await handler()(request(token, "unified-1k-staging"), env);
    expect(response.status).toBe(200);
    const prompt = vi.mocked(model.generate).mock.calls[0]?.[0] as string;
    expect(prompt).toContain("USER_QUESTION_JSON");
    expect(prompt).toContain("EVIDENCE_JSON");
    expect(prompt).not.toContain("Teach, do not merely retrieve");
    expect(prompt).not.toContain("OUTPUT CONTRACT");
    expect(prompt).not.toContain("citation markers");
    expect(quota.used).toBe(1);
  });

  it("passes one consistent sourced Markdown contract to staging Luna", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_LUNA_PREVIEW = "true";
    env.SANTO_SINGLE_PASS_GENERATION_V1 = "true";
    env.SANTO_PLAIN_TEXT_LUNA_V1 = "true";
    model.generate = vi.fn(async () => ({
      answer: "The provided medical evidence supports this answer.",
      citationIds: [SOURCE_ID],
    }));
    const response = await handler()(request(token), env);
    expect(response.status).toBe(200);
    expect(model.generate).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(model.generate).mock.calls[0]?.[0] as string;
    expect(prompt).toContain("OUTPUT CONTRACT: Write the teaching response directly in Markdown");
    expect(prompt).toContain("using [[N]]");
    expect(prompt).not.toContain("Return JSON only");
    expect(prompt).not.toContain("citation_ids");
    expect(quota.finalizeCalls).toBe(1);
  });

  it("sends real source HTML figure metadata to Luna and renders selected image IDs inline", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_LUNA_PREVIEW = "true";
    env.SANTO_SINGLE_PASS_GENERATION_V1 = "true";
    env.SANTO_PLAIN_TEXT_LUNA_V1 = "true";
    env.SANTO_LUNA_RICH_IMAGES_V1 = "true";
    const media = "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/valve.png";
    const sourceId = "amboss:chunk-valve";
    const article = {
      schemaVersion: 1,
      libraryId: "amboss",
      articleId: "aortic-stenosis",
      title: "Aortic stenosis",
      category: "Cardiology",
      source: "AMBOSS",
      sections: [
        {
          id: "s-0001",
          heading: "Diagnosis",
          text: "Doppler measures valve gradients",
          images: [{ src: media, alt: "Aortic valve Doppler" }],
        },
      ],
      contentHtml:
        '<h2>Diagnosis</h2><figure><img id="echo-7" src="' +
        media +
        '" alt="Doppler"><figcaption>Continuous wave Doppler across stenotic valve</figcaption></figure>',
    };
    const get = vi.fn(async (key: string) =>
      key === "medical-articles/v1/amboss/aortic-stenosis.json"
        ? { text: async () => JSON.stringify(article) }
        : null,
    );
    env.CONTENT_BUCKET = { get, put: async () => undefined, delete: async () => undefined };
    retrieval.retrieve = vi.fn(async () => [
      {
        sourceId,
        libraryId: "amboss",
        instanceId: "amboss",
        itemKey: "medical-search/v1/amboss/aortic-stenosis/s-0001.md",
        title: "Aortic stenosis",
        section: "Diagnosis",
        text: "Doppler echocardiography",
        page: null,
        score: 0.94,
      },
    ]);
    model.generate = vi.fn(async () => ({
      answer: "## Diagnosis\nDoppler confirms valve obstruction [[1]].\n\n[[IMG_001]]",
      citationIds: [sourceId],
    }));
    const save = vi.fn(async () => undefined);
    const output = await handler({ save })(
      request(token, "valve-image", "Aortic stenosis echo"),
      env,
    );
    expect(output.status).toBe(200);
    const body = await output.json();
    expect(body.answer).toContain(
      "![Continuous wave Doppler across stenotic valve](" + media + ")",
    );
    expect(body.answer).toContain("Source: Aortic stenosis — Diagnosis");
    expect(body.answer).not.toContain("[[IMG_001]]");
    expect(body.citations).toMatchObject([{ sourceId }]);
    expect(get).toHaveBeenCalledWith("medical-articles/v1/amboss/aortic-stenosis.json");
    expect(model.generate).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(model.generate).mock.calls[0]![0] as string;
    expect(prompt).toContain("AVAILABLE_ORIGINAL_ARTICLE_IMAGES");
    expect(prompt).toContain("Continuous wave Doppler across stenotic valve");
    expect(prompt).toContain("echo-7");
    expect(prompt).toContain("IMG_001");
    expect(save).toHaveBeenCalledTimes(1);
    expect(quota.finalizeCalls).toBe(1);
  });

  it("hydrates source-verified article and gallery images concurrently without changing citations or IDs", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_LUNA_PREVIEW = "true";
    env.SANTO_SINGLE_PASS_GENERATION_V1 = "true";
    env.SANTO_PLAIN_TEXT_LUNA_V1 = "true";
    env.SANTO_LUNA_RICH_IMAGES_V1 = "true";
    env.SANTO_GALLERY_IMAGES_V1 = "true";
    env.SANTO_AI_SEARCH_SINGLE_REQUEST_V1 = "true";

    const media = "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/";
    const sourceId = "amboss:chunk-parallel";
    const articleKey = "medical-articles/v1/amboss/aortic-stenosis.json";
    const manifestKey = "gallery/v1/santo_image_manifest.json";
    const article = {
      schemaVersion: 1,
      libraryId: "amboss",
      articleId: "aortic-stenosis",
      title: "Aortic stenosis",
      category: "Cardiology",
      source: "AMBOSS",
      sections: [
        {
          id: "s-0001",
          heading: "Diagnosis",
          text: "Doppler determines valve gradients",
          images: [{ src: media + "valve.webp", alt: "Doppler valve" }],
        },
      ],
      contentHtml: "",
    };
    const gallery = {
      img_000001: {
        image_url: media + "ecg.webp",
        title: "Aortic stenosis ECG",
        visual_caption: "ECG finding",
        primary_system: "Cardiology",
        source_name: "Medical image gallery",
      },
    };
    let releaseArticle!: () => void;
    let releaseGallery!: () => void;
    const articleGate = new Promise<void>((resolve) => {
      releaseArticle = resolve;
    });
    const galleryGate = new Promise<void>((resolve) => {
      releaseGallery = resolve;
    });
    const reads: string[] = [];
    env.CONTENT_BUCKET = {
      get: vi.fn(async (key: string) => {
        reads.push(key);
        if (key === articleKey) {
          await articleGate;
          return { text: async () => JSON.stringify(article) };
        }
        if (key === manifestKey) {
          await galleryGate;
          return { text: async () => JSON.stringify(gallery) };
        }
        return null;
      }),
      put: async () => undefined,
      delete: async () => undefined,
    };
    retrieval.retrieveWithGallery = vi.fn(async () => ({
      evidence: [
        {
          sourceId,
          libraryId: "amboss",
          instanceId: "amboss",
          itemKey: "medical-search/v1/amboss/aortic-stenosis/s-0001.md",
          title: "Aortic stenosis",
          section: "Diagnosis",
          text: "Doppler imaging is used in diagnosis.",
          page: null,
          score: 0.96,
        },
      ],
      galleryHits: [{ imageId: "img_000001", score: 0.89 }],
    }));
    model.generate = vi.fn(async () => ({
      answer: "## Diagnosis\nDoppler [[1]].\n\n[[IMG_001]]\n\n[[IMG_301]]",
      citationIds: [sourceId],
    }));

    const running = handler()(request(token, "parallel-figures", "Aortic stenosis ECG"), env);
    try {
      await vi.waitFor(() => expect(reads).toContain(articleKey));
      // Both requests must start BEFORE either R2 operation is unblocked.
      await vi.waitFor(() => expect(reads).toContain(manifestKey), { timeout: 600 });
    } finally {
      releaseArticle();
      releaseGallery();
    }

    const response = await running;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.answer).toContain(media + "valve.webp");
    expect(body.answer).toContain(media + "ecg.webp");
    expect(body.answer).not.toContain("[[IMG_001]]");
    expect(body.answer).not.toContain("[[IMG_081]]");
    expect(body.relatedPics ?? []).toHaveLength(0); // Already inline: no duplication.
    expect(body.citations).toMatchObject([{ sourceId }]);
    expect(retrieval.retrieveWithGallery).toHaveBeenCalledTimes(1);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(model.generate).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(model.generate).mock.calls[0]![0] as string;
    expect(prompt).toContain("IMG_001");
    expect(prompt).toContain("IMG_081");
    expect(quota.finalizeCalls).toBe(1);

    // Next question uses the SAME search + same original Luna image prompt,
    // but Luna doesn't select the verified gallery image inline.
    model.generate = vi.fn(async () => ({
      answer: "## Diagnosis\\nDoppler [[1]].",
      citationIds: [sourceId],
    }));
    const second = await handler()(request(token, "related-pics", "Aortic stenosis ECG"), env);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.relatedPics).toEqual([
      {
        src: media + "ecg.webp",
        alt: "Aortic stenosis ECG",
        caption: "ECG finding",
        sourceName: "Medical image gallery",
      },
    ]);
    expect(secondBody.answer).not.toContain("ecg.webp");
    expect(secondBody.citations).toMatchObject([{ sourceId }]);
    expect(retrieval.retrieveWithGallery).toHaveBeenCalledTimes(2);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(quota.finalizeCalls).toBe(2);
  });

  it("passes an uncited Markdown contract to staging when retrieval is empty", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_LUNA_PREVIEW = "true";
    env.SANTO_SINGLE_PASS_GENERATION_V1 = "true";
    env.SANTO_PLAIN_TEXT_LUNA_V1 = "true";
    env.SANTO_GENERAL_MEDICAL_FALLBACK = "true";
    retrieval.retrieve = vi.fn(async () => []);
    model.generate = vi.fn(async () => ({
      answer: "General medical education without library citations.",
      citationIds: [],
    }));
    const response = await handler()(request(token), env);
    expect(response.status).toBe(200);
    expect(model.generate).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(model.generate).mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Write the medical education answer directly in Markdown");
    expect(prompt).not.toContain("Return exactly valid JSON");
    expect(prompt).not.toContain("citation_ids");
    expect(quota.finalizeCalls).toBe(1);
  });

  it("preserves the JSON contract for non-Luna production models", async () => {
    env.SANTO_ENV = "production";
    env.SANTO_PLAIN_TEXT_LUNA_V1 = "true";
    model.generate = vi.fn(async () => ({
      answer: "Clinical answer supported by the source.",
      citationIds: [SOURCE_ID],
    }));
    const response = await handler()(request(token), env);
    expect(response.status).toBe(200);
    const prompt = vi.mocked(model.generate).mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Return JSON only");
    expect(prompt).toContain("citation_ids");
  });

  it("keeps completed Luna teaching without pretending retrieved articles were used", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_LUNA_PREVIEW = "true";
    env.SANTO_SINGLE_PASS_GENERATION_V1 = "true";
    env.SANTO_PLAIN_TEXT_LUNA_V1 = "true";
    model.generate = vi.fn(async () => ({
      answer: "Aortic stenosis can require valve replacement.",
      citationIds: [],
      sourcePresentation: "related" as const,
    }));
    const save = vi.fn(async () => undefined);
    const response = await handler({ save })(request(token), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      groundingMode: "general",
      citations: [],
      usage: { unitsCharged: 1 },
    });
    expect(save).not.toHaveBeenCalled();
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(quota.finalizeCalls).toBe(1);
  });

  it("lets Luna clarify without falsely attaching medical articles", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_LUNA_PREVIEW = "true";
    env.SANTO_SINGLE_PASS_GENERATION_V1 = "true";
    env.SANTO_PLAIN_TEXT_LUNA_V1 = "true";
    model.generate = vi.fn(async () => ({
      answer: "What condition do you mean?",
      citationIds: [],
      sourcePresentation: "none" as const,
    }));
    const save = vi.fn(async () => undefined);
    const response = await handler({ save })(request(token), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      groundingMode: "general",
      citations: [],
      usage: { unitsCharged: 1 },
    });
    expect(save).not.toHaveBeenCalled();
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(quota.finalizeCalls).toBe(1);
  });

  it("completes a real fifteen-citation AMBOSS answer with persisted verified sources", async () => {
    const evidence = Array.from({ length: 15 }, (_, index) => ({
      sourceId: "amboss:r2-" + String(index).padStart(32, "0"),
      libraryId: "amboss",
      instanceId: "amboss",
      itemKey:
        "medical-search/v1/amboss/unnamed-2746/s-" + String(index + 15).padStart(4, "0") + ".md",
      title: "Aortic valve stenosis",
      page: null,
      section: index === 0 ? "Treatment" : "Approach",
      text: "Verified AMBOSS aortic stenosis teaching for section " + index,
      score: index === 0 ? 0.91 : 0,
    }));
    retrieval.retrieve = vi.fn(async () => evidence);
    model.generate = vi.fn(async () => ({
      answer:
        "Severity and management " +
        evidence.map((_, index) => "[[" + (index + 1) + "]]").join(" "),
      citationIds: evidence.map((item) => item.sourceId),
    }));
    const save = vi.fn(async () => undefined);
    const response = await handler({ save })(request(token, "amboss-fifteen-source-fix"), env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.citations).toHaveLength(15);
    expect(body.citations.map((item: { sourceId: string }) => item.sourceId)).toEqual(
      evidence.map((item) => item.sourceId),
    );
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      expect.any(Object),
      evidence.map((item) => expect.objectContaining({ sourceId: item.sourceId })),
    );
    expect(quota.used).toBe(1);
    expect(quota.releaseCalls).toBe(0);
  });

  it("saves only verified citation metadata before finalizing quota", async () => {
    const save = vi.fn(async () => undefined);
    const response = await handler({ save })(request(token), env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(save).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, externalUserId: USER_ID, messageId: body.messageId },
      [
        {
          sourceId: SOURCE_ID,
          libraryId: "medical",
          instanceId: "medical",
          itemKey: "electrolytes.md",
          title: "Electrolytes",
          page: 12,
          section: "Sodium disorders",
        },
      ],
    );
    expect(quota.used).toBe(1);
  });

  it("does not finalize quota if verified source persistence fails", async () => {
    const save = vi.fn(async () => {
      throw new Error("R2 is unavailable");
    });
    const result = await handler({ save })(request(token), env);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "SOURCE_SNAPSHOT_FAILED" });
    expect(quota.used).toBe(0);
    expect(quota.releaseCalls).toBe(1);
  });

  it("keeps already finalized charge identity on a failed regeneration", async () => {
    const first = await handler()(request(token, "charge-identity"), env);
    expect(first.status).toBe(200);
    expect(quota.used).toBe(1);
    model.generate = vi.fn(async () => {
      throw new Error("model retry unavailable");
    });
    const second = await handler()(request(token, "charge-identity"), env);
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({ error: "CHARGED_GENERATION_RETRY_FAILED" });
    expect(quota.used).toBe(1);
    expect(quota.releaseCalls).toBe(0);
  });

  it("runs session -> quota -> retrieval -> model -> verified citation -> finalize", async () => {
    const response = await handler()(request(token), env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      answer: "The cited source gives a normal serum sodium range of 135–145 mmol/L.",
      citations: [{ sourceId: SOURCE_ID, title: "Electrolytes", page: 12 }],
      usage: { unitsCharged: 1, remaining: 9 },
    });
    expect(retrieval.retrieve).toHaveBeenCalledWith({
      query: "What is the normal serum sodium range?",
      libraryId: null,
    });
    expect(quota.reserveCalls).toBe(1);
    expect(quota.finalizeCalls).toBe(1);
    expect(quota.releaseCalls).toBe(0);
    expect(telemetryEvents.at(-1)?.status).toBe("success");
  });

  it("sends actual PubMed evidence into the SAME Luna model and shared quota without Qwen", async () => {
    env.SANTO_RESEARCH_ENABLED = "true";
    retrieval.route = vi.fn(async () => ({ intent: "chat" as const, answer: "Qwen-only answer" }));
    const originalGenerate = model.generate;
    model.generate = vi.fn(async () => ({
      answer: "This medical trial helps explain aortic stenosis treatment.",
      citationIds: ["pubmed:123"],
    }));
    const net = vi.fn(async (raw: RequestInfo | URL) => {
      const url = String(raw);
      if (url.includes("esearch.fcgi")) {
        return Response.json({ esearchresult: { idlist: ["123"] } });
      }
      if (url.includes("efetch.fcgi") && url.includes("db=pubmed")) {
        return new Response(`<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID>
          <Article><ArticleTitle>Severe aortic stenosis randomized treatment trial</ArticleTitle>
          <Abstract><AbstractText>Aortic stenosis randomized treatment trial shows outcomes.</AbstractText></Abstract>
          </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`);
      }
      return new Response("provider unavailable", { status: 503 });
    });
    vi.stubGlobal("fetch", net);
    try {
      const old = request(token, "real-research", "aortic stenosis treatment");
      const payload = JSON.parse(await old.clone().text()) as Record<string, unknown>;
      payload.source_mode = "research";
      const req = new Request(old.url, {
        method: "POST",
        headers: old.headers,
        body: JSON.stringify(payload),
      });
      const response = await handler()(req, env);
      expect(response.status).toBe(200);
      const result = (await response.json()) as { citations: Array<{ sourceId: string }> };
      expect(result.citations.map((x) => x.sourceId)).toContain("pubmed:123");
      expect(model.generate).toHaveBeenCalledTimes(1);
      expect(retrieval.route).not.toHaveBeenCalled();
      expect(retrieval.retrieve).not.toHaveBeenCalled();
      expect(quota.used).toBe(1);

      // The existing Libraries route is unchanged and uses the SAME quota engine.
      model.generate = originalGenerate;
      const libraries = await handler()(request(token, "old-libraries", "serum sodium"), env);
      expect(libraries.status).toBe(200);
      expect(retrieval.retrieve).toHaveBeenCalledTimes(1);
      expect(quota.used).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes a validated library filter into retrieval", async () => {
    const response = await handler()(request(token, "library-key", "sodium", "mrcp"), env);

    expect(response.status).toBe(200);
    expect(retrieval.retrieve).toHaveBeenCalledWith({ query: "sodium", libraryId: "mrcp" });
  });

  it("rejects an invalid session before quota, search, or model work", async () => {
    const response = await handler()(request("invalid-token"), env);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "INVALID_SESSION_TOKEN" });
    expect(quota.reserveCalls).toBe(0);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("denies exhausted quota before search or model work", async () => {
    quota.exhausted = true;
    const response = await handler()(request(token), env);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "USER_QUOTA_EXHAUSTED" });
    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("releases the reservation when no evidence is retrieved", async () => {
    retrieval.retrieve = vi.fn(async () => []);
    const response = await handler()(request(token), env);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "INSUFFICIENT_EVIDENCE" });
    expect(quota.releaseCalls).toBe(1);
    expect(quota.used).toBe(0);
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("uses transparent medical knowledge when RAG has no relevant evidence and feature is on", async () => {
    env.SANTO_GENERAL_MEDICAL_FALLBACK = "true";
    retrieval.retrieve = vi.fn(async () => []);
    model.generate = vi.fn(async () => ({
      answer: "## Key takeaway\\nHyponatraemia is low serum sodium.",
      citationIds: [],
    }));
    const save = vi.fn(async () => undefined);
    const response = await handler({ save })(request(token), env);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      groundingMode: "general",
      answer: "## Key takeaway\\nHyponatraemia is low serum sodium.",
      citations: [],
      usage: { unitsCharged: 1, remaining: 9 },
    });
    expect(vi.mocked(model.generate).mock.calls[0]?.[0]).toContain("GENERAL_MEDICAL_KNOWLEDGE");
    expect(save).not.toHaveBeenCalled();
    expect(quota.finalizeCalls).toBe(1);
    expect(quota.releaseCalls).toBe(0);
  });

  it("tries general mode only when the grounded model explicitly reports insufficient evidence", async () => {
    env.SANTO_GENERAL_MEDICAL_FALLBACK = "true";
    model.generate = vi
      .fn()
      .mockResolvedValueOnce({ answer: "INSUFFICIENT_EVIDENCE", citationIds: [] })
      .mockResolvedValueOnce({ answer: "General medical explanation", citationIds: [] });
    const response = await handler()(request(token), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      groundingMode: "general",
      citations: [],
      answer: "General medical explanation",
    });
    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(quota.finalizeCalls).toBe(1);
  });

  it("staging cost guard makes no second paid model call after an insufficient-evidence response", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_SINGLE_PASS_GENERATION_V1 = "true";
    env.SANTO_GENERAL_MEDICAL_FALLBACK = "true";
    model.generate = vi.fn(async () => ({
      answer: "INSUFFICIENT_EVIDENCE",
      citationIds: [],
    }));
    const response = await handler()(request(token), env);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "INSUFFICIENT_EVIDENCE" });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(quota.finalizeCalls).toBe(0);
    expect(quota.releaseCalls).toBe(1);
    expect(quota.used).toBe(0);
  });

  it("staging cost guard still answers with one general-model request when retrieval is empty", async () => {
    env.SANTO_ENV = "staging";
    env.SANTO_SINGLE_PASS_GENERATION_V1 = "true";
    env.SANTO_GENERAL_MEDICAL_FALLBACK = "true";
    retrieval.retrieve = vi.fn(async () => []);
    model.generate = vi.fn(async () => ({
      answer: "A safe, explicitly uncited medical teaching answer.",
      citationIds: [],
    }));
    const response = await handler()(request(token), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      groundingMode: "general",
      citations: [],
      usage: { unitsCharged: 1 },
    });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(quota.finalizeCalls).toBe(1);
  });

  it("production never enables staging-only cost guard even if the variable is supplied", async () => {
    env.SANTO_ENV = "production";
    env.SANTO_SINGLE_PASS_GENERATION_V1 = "true";
    env.SANTO_GENERAL_MEDICAL_FALLBACK = "true";
    model.generate = vi
      .fn()
      .mockResolvedValueOnce({ answer: "INSUFFICIENT_EVIDENCE", citationIds: [] })
      .mockResolvedValueOnce({ answer: "Legacy production general response", citationIds: [] });
    const response = await handler()(request(token), env);
    expect(response.status).toBe(200);
    expect(model.generate).toHaveBeenCalledTimes(2);
  });

  it("never turns retrieval outages into uncited medical assertions", async () => {
    env.SANTO_GENERAL_MEDICAL_FALLBACK = "true";
    retrieval.retrieve = vi.fn(async () => {
      throw new Error("Search offline");
    });
    const response = await handler()(request(token), env);
    expect(response.status).toBe(502);
    expect(model.generate).not.toHaveBeenCalled();
    expect(quota.releaseCalls).toBe(1);
  });

  it("rejects invented citations even in general fallback mode", async () => {
    env.SANTO_GENERAL_MEDICAL_FALLBACK = "true";
    retrieval.retrieve = vi.fn(async () => []);
    model.generate = vi.fn(async () => ({
      answer: "Unverified general text",
      citationIds: ["medical:imaginary"],
    }));
    const response = await handler()(request(token), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "CITATION_INVALID" });
    expect(quota.used).toBe(0);
  });

  it("rejects invented citations and releases the reservation", async () => {
    model.generate = vi.fn(async () => ({
      answer: "Unsupported answer",
      citationIds: ["medical:not-retrieved"],
    }));
    const response = await handler()(request(token), env);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "CITATION_INVALID" });
    expect(quota.releaseCalls).toBe(1);
    expect(quota.used).toBe(0);
  });

  it("does not double-charge when the same idempotency key is retried", async () => {
    const first = await handler()(request(token, "same-key"), env);
    const second = await handler()(request(token, "same-key"), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(quota.used).toBe(1);
    expect(quota.reserveCalls).toBe(2);
    expect(quota.finalizeCalls).toBe(2);
  });

  it("does charge distinct queries even when a client reuses the same key", async () => {
    const first = await handler()(request(token, "reused-key", "sodium"), env);
    const second = await handler()(request(token, "reused-key", "potassium"), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(quota.used).toBe(2);
  });

  it("does charge distinct library scopes when a client reuses the same key and query", async () => {
    const first = await handler()(request(token, "scope-key", "sodium", "mrcp"), env);
    const second = await handler()(request(token, "scope-key", "sodium", "usmle"), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(quota.used).toBe(2);
  });

  it("streams validated deltas and a final structured result only after charging", async () => {
    const req = request(token, "stream-key");
    req.headers.set("accept", "application/json, text/event-stream; charset=utf-8");
    const result = await handler()(req, env);

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    expect(quota.used).toBe(1);
    expect(quota.finalizeCalls).toBe(1);
    const events = (await result.text())
      .trim()
      .split("\n\n")
      .map((block) => {
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (!data) throw new Error("Missing SSE data");
        return GroundedAiStreamEventSchema.parse(JSON.parse(data.slice(6)));
      });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: {
        citations: [{ sourceId: SOURCE_ID }],
        usage: { unitsCharged: 1, remaining: 9 },
      },
    });
    expect(events.slice(0, -1).every((event) => event.type === "delta")).toBe(true);
    expect(events.map((event) => (event.type === "delta" ? event.text : "")).join("")).toBe(
      "The cited source gives a normal serum sodium range of 135–145 mmol/L.",
    );
  });

  it("never streams an answer if the model invents citations", async () => {
    model.generate = vi.fn(async () => ({
      answer: "Invented medical answer",
      citationIds: ["not-retrieved"],
    }));
    const req = request(token);
    req.headers.set("accept", "text/event-stream");
    const result = await handler()(req, env);

    expect(result.status).toBe(502);
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(await result.json()).toEqual({ error: "CITATION_INVALID" });
    expect(quota.used).toBe(0);
    expect(quota.releaseCalls).toBe(1);
  });

  it("does not stream before quota finalization succeeds", async () => {
    quota.finalize = vi.fn(async () => {
      throw new Error("temporary quota failure");
    });
    const req = request(token);
    req.headers.set("accept", "text/event-stream");
    const result = await handler()(req, env);

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "QUOTA_FINALIZE_FAILED" });
    expect(result.headers.get("content-type")).toContain("application/json");
  });

  it("releases quota after a model timeout rather than sending partial SSE", async () => {
    stageTimeouts = { retrievalMs: 200, modelMs: 5 };
    model.generate = vi.fn(() => new Promise<Awaited<ReturnType<ModelPort["generate"]>>>(() => {}));
    const req = request(token);
    req.headers.set("accept", "text/event-stream");
    const result = await handler()(req, env);

    expect(result.status).toBe(504);
    expect(await result.json()).toEqual({ error: "MODEL_TIMEOUT" });
    expect(quota.used).toBe(0);
    expect(quota.releaseCalls).toBe(1);
  });

  it("releases quota after a retrieval timeout without invoking the model", async () => {
    stageTimeouts = { retrievalMs: 5, modelMs: 200 };
    retrieval.retrieve = vi.fn(
      () => new Promise<Awaited<ReturnType<RetrievalPort["retrieve"]>>>(() => {}),
    );
    const result = await handler()(request(token), env);

    expect(result.status).toBe(504);
    expect(await result.json()).toEqual({ error: "SEARCH_TIMEOUT" });
    expect(model.generate).not.toHaveBeenCalled();
    expect(quota.used).toBe(0);
    expect(quota.releaseCalls).toBe(1);
  });

  it("cancels a pending model call and releases the reservation", async () => {
    const controller = new AbortController();
    let modelStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    model.generate = vi.fn(() => {
      modelStarted();
      return new Promise<Awaited<ReturnType<ModelPort["generate"]>>>(() => {});
    });
    const req = new Request(request(token), { signal: controller.signal });
    const pending = handler()(req, env);
    await started;
    controller.abort();
    const result = await pending;

    expect(result.status).toBe(499);
    expect(await result.json()).toEqual({ error: "REQUEST_CANCELLED" });
    expect(quota.releaseCalls).toBe(1);
    expect(quota.used).toBe(0);
  });

  it("streams idempotent retries without charging the same request twice", async () => {
    const firstReq = request(token, "stream-idempotent");
    firstReq.headers.set("accept", "text/event-stream");
    const secondReq = request(token, "stream-idempotent");
    secondReq.headers.set("accept", "text/event-stream");

    const first = await handler()(firstReq, env);
    const second = await handler()(secondReq, env);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(quota.used).toBe(1);
    expect(quota.reserveCalls).toBe(2);
    expect(quota.finalizeCalls).toBe(2);
    expect(await first.text()).toContain("event: complete");
    expect(await second.text()).toContain("event: complete");
  });
});
