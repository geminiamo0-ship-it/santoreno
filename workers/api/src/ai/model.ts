import type { SantoBindings, WorkersAiLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";
import type { GroundedModelDraft, ModelPort } from "./types";

export const GROUNDED_MODEL_POLICY = {
  temperature: 0.1,
  // Headroom for evidence-supported mechanisms; simple facts remain brief by prompt policy.
  maxTokens: 1500,
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

  if (typeof root.output_text === "string") return root.output_text;
  if (Array.isArray(root.output)) {
    const parts: string[] = [];
    for (const output of root.output) {
      const message = asRecord(output);
      if (message?.type !== "message" || !Array.isArray(message.content)) continue;
      for (const item of message.content) {
        const content = asRecord(item);
        if (content?.type === "output_text" && typeof content.text === "string") {
          parts.push(content.text);
        }
      }
    }
    if (parts.length) return parts.join("");
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
              "You are Santo, a source-grounded medical tutor. In grounded mode, explain and synthesize rather than copy, but never introduce claims not supported by the provided evidence. In explicitly declared GENERAL_MEDICAL_KNOWLEDGE mode only, explain from general medical knowledge without claiming to have verified Santo sources or making up citations. Return only the requested structured JSON; never invent source identifiers. Follow the requested Markdown formatting inside the answer string.",
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

/** Third-party Cloudflare AI Gateway model; staging-only preview until live safety gates pass. */
export class CloudflareLunaModel implements ModelPort {
  constructor(private readonly ai: WorkersAiLike | undefined) {}

  async generate(prompt: string): Promise<GroundedModelDraft> {
    if (!this.ai) {
      throw new GroundedAiError(503, "AI_NOT_CONFIGURED", "AI binding is required");
    }
    try {
      // Cloudflare's GPT-6 Luna uses the Responses format, not the
      // legacy Workers AI response_format / max_tokens fields.
      const raw = await this.ai.run("openai/gpt-6-luna", {
        input: prompt,
        instructions:
          "You are Santo Medical Education Copilot, an expert medical tutor. Teach clearly and adapt your depth to the question. For Arabic questions use warm, natural Egyptian Arabic while preserving precise English medical terms; for English questions use professional medical English. In grounded mode rely ONLY on supplied evidence, never invent source IDs, diagnoses, images or links. Answer valid JSON only and use citation_ids only from the supplied evidence. For explicitly declared GENERAL_MEDICAL_KNOWLEDGE use no Santo citations. Refuse to invent missing evidence.",
        max_output_tokens: GROUNDED_MODEL_POLICY.maxTokens,
        reasoning: { effort: "none" },
        service_tier: "fast",
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "santo_grounded",
            strict: true,
            schema: groundedResponseSchema,
          },
        },
      });
      const text = modelText(raw);
      if (!text) {
        throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Model returned no text");
      }
      return parseDraft(text);
    } catch (error) {
      if (error instanceof GroundedAiError) throw error;
      throw new GroundedAiError(502, "MODEL_FAILED", "Luna preview model request failed");
    }
  }
}

export function createGroundedModel(
  env: Pick<SantoBindings, "AI" | "SANTO_AI_MODEL" | "SANTO_ENV" | "SANTO_LUNA_PREVIEW">,
): ModelPort {
  if (env.SANTO_ENV === "staging" && env.SANTO_LUNA_PREVIEW === "true") {
    return new CloudflareLunaModel(env.AI);
  }
  return new CloudflareWorkersAiModel(env.AI, env.SANTO_AI_MODEL);
}
