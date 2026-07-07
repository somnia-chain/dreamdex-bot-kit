/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { logger } from "../utils/logger.js";

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream?: false;
  format?: "json";
  options?: {
    temperature?: number;
    num_predict?: number;
    top_p?: number;
    seed?: number;
  };
}

export interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl?: string; model?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.model = opts.model ?? "llama3.2";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      const hasModel = body.models?.some((m) => m.name.startsWith(this.model)) ?? false;
      if (!hasModel) {
        return { ok: false, reason: `Model '${this.model}' not found. Run: ollama pull ${this.model}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    } finally {
      clearTimeout(t);
    }
  }

  async generate(prompt: string, opts: { json?: boolean; temperature?: number } = {}): Promise<string> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    const body: OllamaGenerateRequest = {
      model: this.model,
      prompt,
      stream: false,
      ...(opts.json ? { format: "json" as const } : {}),
      options: {
        temperature: opts.temperature ?? 0.3,
        num_predict: 256,
      },
    };
    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      const data = (await res.json()) as OllamaGenerateResponse;
      return data.response.trim();
    } finally {
      clearTimeout(t);
    }
  }

  async generateJson<T>(prompt: string, opts: { temperature?: number } = {}): Promise<T> {
    const raw = await this.generate(prompt, { json: true, temperature: opts.temperature });
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn({ raw, err: (err as Error).message }, "Ollama JSON parse failed, returning empty object");
      throw new Error(`Ollama did not return valid JSON: ${raw.slice(0, 200)}`);
    }
  }
}
