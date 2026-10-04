import { GroundedAiModelOutputSchema, type GroundedAiModelOutput } from "@santo/contracts";

import type { WorkersAiLike } from "../runtime/bindings";
import { buildGroundedPrompt } from "./prompt";
import type { GroundedModel, GroundedModelInput } from "./types";

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class ModelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

function responseValue(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("response" in payload)) {
    throw new ModelError("MODEL_INVALID_RESPONSE", "Workers AI response is malformed");
  }

  const response = (payload as { response: unknown }).response;
  if (typeof response !== "string") {
    return response;
  }

  try {
    return JSON.parse(response) as unknown;
  } catch {
    throw new ModelError("MODEL_INVALID_RESPONSE", "Workers AI returned invalid JSON");
  }
}

export class WorkersAiGroundedModel implements GroundedModel {
  constructor(
    private readonly ai: WorkersAiLike,
    private readonly modelId: string = DEFAULT_MODEL,
  ) {}

  async generate(input: GroundedModelInput): Promise<GroundedAiModelOutput> {
    let payload: unknown;
    try {
      payload = await this.ai.run(this.modelId, {
        messages: [
          {
            role: "system",
            content:
              "You are Santo, a medical evidence assistant. Use only supplied evidence and never invent citations.",
          },
          { role: "user", content: buildGroundedPrompt(input) },
        ],
        temperature: 0.1,
        max_tokens: 800,
        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              answer: { type: "string" },
              citation_ids: {
                type: "array",
                minItems: 1,
                maxItems: 5,
                items: { type: "string" },
              },
            },
            required: ["answer", "citation_ids"],
          },
        },
      });
    } catch (error) {
      throw new ModelError(
        "MODEL_FAILED",
        error instanceof Error ? error.message : "Workers AI request failed",
      );
    }

    const parsed = GroundedAiModelOutputSchema.safeParse(responseValue(payload));
    if (!parsed.success) {
      throw new ModelError("MODEL_INVALID_RESPONSE", "Workers AI output failed schema validation");
    }

    return parsed.data;
  }
}
