import type { SantoBindings, WorkersAiLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";
import type { GroundedModelDraft, ModelPort } from "./types";

export const GROUNDED_MODEL_POLICY = {
  temperature: 0.1,
  maxTokens: 900,
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function modelText(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }

  const root = asRecord(raw);
  if (!root) {
    return null;
  }

  const response = root.response;
  if (typeof response === "string") {
    return response;
  }
  if (asRecord(response)) {
    return JSON.stringify(response);
  }

  const choices = root.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = asRecord(choices[0]);
    const message = asRecord(first?.message);
    const content = message?.content;
    if (typeof content === "string") {
      return content;
    }
  }

  return null;
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parseDraft(text: string): GroundedModelDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Model did not return valid JSON");
  }

  const record = asRecord(parsed);
  const answer = record?.answer;
  const citationIds = record?.citation_ids;
  if (
    typeof answer !== "string" ||
    answer.trim().length === 0 ||
    !Array.isArray(citationIds) ||
    !citationIds.every((value) => typeof value === "string" && value.length > 0)
  ) {
    throw new GroundedAiError(
      502,
      "MODEL_RESPONSE_INVALID",
      "Model response does not match the grounded answer contract",
    );
  }

  return {
    answer: answer.trim(),
    citationIds: citationIds.slice(0, 10),
  };
}

const groundedResponseSchema = {
  type: "object",
  properties: {
    answer: { type: "string" },
    citation_ids: {
      type: "array",
      items: { type: "string" },
      maxItems: 5,
    },
  },
  required: ["answer", "citation_ids"],
  additionalProperties: false,
} as const;

export class CloudflareWorkersAiModel implements ModelPort {
  constructor(
    private readonly ai: WorkersAiLike | undefined,
    private readonly model: string | undefined,
  ) {}

  async generate(prompt: string): Promise<GroundedModelDraft> {
    const model = this.model?.trim();
    if (!this.ai || !model) {
      throw new GroundedAiError(503, "AI_NOT_CONFIGURED", "Workers AI model binding is required");
    }

    try {
      const raw = await this.ai.run(model, {
        messages: [
          {
            role: "system",
            content:
              "Return only the grounded JSON object requested by the user prompt. Never invent source identifiers.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: groundedResponseSchema,
        },
        temperature: GROUNDED_MODEL_POLICY.temperature,
        max_tokens: GROUNDED_MODEL_POLICY.maxTokens,
      });
      const text = modelText(raw);
      if (!text) {
        throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Model returned no text response");
      }
      return parseDraft(text);
    } catch (error) {
      if (error instanceof GroundedAiError) {
        throw error;
      }
      throw new GroundedAiError(502, "MODEL_FAILED", "Workers AI model request failed");
    }
  }
}

export function createGroundedModel(env: Pick<SantoBindings, "AI" | "SANTO_AI_MODEL">): ModelPort {
  return new CloudflareWorkersAiModel(env.AI, env.SANTO_AI_MODEL);
}
