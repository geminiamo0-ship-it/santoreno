import { z } from "zod";
import { ApiErrorResponseSchema } from "@santo/contracts";
import type { SantoBindings } from "../runtime/bindings";
import { D1ExternalUserRepository } from "../session/repository";
import { SessionError, SessionExchangeService } from "../session/service";
import { SantoSessionTokenService, SessionTokenError } from "../session/token";
import { D1TenantRepository } from "../tenancy/repository";
import { findMoreAnkingCards } from "./anking-topic-finder";

const RequestSchema = z
  .object({
    topic: z.string().trim().min(3).max(250),
    cursor: z.number().int().min(0).max(150).optional(),
    excludeCardIds: z.array(z.number().int().positive().safe()).max(5).optional(),
  })
  .strict();
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function error(code: string, status: number): Response {
  return Response.json(ApiErrorResponseSchema.parse({ error: code }), { status, headers: HEADERS });
}

/** Separate authenticated study action; it never calls Luna, quota, or AI Search. */
export async function handleAnkingFindMore(
  request: Request,
  env: SantoBindings,
): Promise<Response> {
  if (
    env.SANTO_ENV !== "staging" ||
    env.SANTO_ANKING_CARDS_V1 !== "true" ||
    env.SANTO_ANKING_RIGHTS_CLEARED_V1 !== "true"
  )
    return error("ANKING_UNAVAILABLE", 404);
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", 405);
  const body = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return error("INVALID_FLASHCARD_SEARCH", 400);
  try {
    const tokens = new SantoSessionTokenService(env);
    const principal = await tokens.verifyBearerToken(
      request.headers.get("authorization") ?? undefined,
    );
    if (!env.CONTROL_DB || !env.CONTENT_BUCKET) return error("ANKING_UNAVAILABLE", 503);
    await new SessionExchangeService(
      new D1ExternalUserRepository(env.CONTROL_DB),
      new D1TenantRepository(env.CONTROL_DB),
      tokens,
    ).resolve(principal);
    const { topic, cursor = 0, excludeCardIds = [] } = body.data;
    const result = await findMoreAnkingCards(
      env.CONTENT_BUCKET,
      topic,
      cursor,
      excludeCardIds,
      // Only optional Arabic->English query normalization, on the FIRST page.
      env.AI,
    );
    return Response.json(result, { headers: HEADERS });
  } catch (caught) {
    if (caught instanceof SessionError || caught instanceof SessionTokenError) {
      return error(caught.code, caught.status);
    }
    return error("ANKING_TOPIC_UNAVAILABLE", 503);
  }
}
