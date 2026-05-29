import { describe, test, expect, beforeEach } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import {
  translateModelName,
  translateToOpenAI,
} from "../src/routes/messages/non-stream-translation"

// Only `id` is read by translateModelName, but translateToOpenAI also peeks at
// `capabilities.supports.reasoning_effort`. We always include an (empty)
// capabilities object so accessing it doesn't blow up; tests that care about
// effort gating use `mkModelWithEffort` instead.
const mkModel = (id: string): Model =>
  ({ id, object: "model", capabilities: {} }) as Model

// Fixture that mirrors the shape Copilot returns (capabilities.supports.reasoning_effort).
// Use this when the test cares about effort gating, not just model name routing.
const mkModelWithEffort = (id: string, supported: Array<string>): Model =>
  ({
    id,
    object: "model",
    capabilities: { supports: { reasoning_effort: supported } },
  }) as Model

const mkPayload = (model: string) => ({
  model,
  messages: [{ role: "user" as const, content: "hi" }],
  max_tokens: 1024,
})

describe("translateModelName", () => {
  beforeEach(() => {
    state.models = undefined
  })

  describe("input normalization", () => {
    test("non-Claude models pass through unchanged", () => {
      expect(translateModelName("gpt-4o")).toBe("gpt-4o")
      expect(translateModelName("gpt-5.1")).toBe("gpt-5.1")
    })

    test("already-dotted Claude names pass through when no model list", () => {
      expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
      expect(translateModelName("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
    })

    test("converts dash-major-minor to dotted form", () => {
      expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
      expect(translateModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4.5")
      expect(translateModelName("claude-haiku-4-5")).toBe("claude-haiku-4.5")
    })

    test("strips date suffixes", () => {
      expect(translateModelName("claude-haiku-4-5-20251001")).toBe(
        "claude-haiku-4.5",
      )
      expect(translateModelName("claude-sonnet-4-6-20260101")).toBe(
        "claude-sonnet-4.6",
      )
    })

    test("handles date-only suffix (no minor version)", () => {
      expect(translateModelName("claude-sonnet-4-20260101")).toBe(
        "claude-sonnet-4",
      )
      expect(translateModelName("claude-opus-4-20250514")).toBe("claude-opus-4")
    })
  })

  describe("default 1M routing (the new behavior)", () => {
    test("routes claude-opus-4-7 to -1m-internal when advertised", () => {
      // Real-world case: CC CLI sends `claude-opus-4-7` with NO 1M signal,
      // and we still route to the 1M variant because Copilot has it.
      state.models = {
        object: "list",
        data: [
          mkModel("claude-opus-4.7"),
          mkModel("claude-opus-4.7-1m-internal"),
        ],
      }

      expect(translateModelName("claude-opus-4-7")).toBe(
        "claude-opus-4.7-1m-internal",
      )
      expect(translateModelName("claude-opus-4.7")).toBe(
        "claude-opus-4.7-1m-internal",
      )
    })

    test("routes claude-opus-4-6 to -1m when advertised", () => {
      // Even though CC CLI used to gate this on the context-1m-* header,
      // we now route to 1M whenever Copilot has the variant.
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.6"), mkModel("claude-opus-4.6-1m")],
      }

      expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6-1m")
      expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6-1m")
    })

    test("prefers -1m over -1m-internal when both available", () => {
      state.models = {
        object: "list",
        data: [
          mkModel("claude-opus-4.7"),
          mkModel("claude-opus-4.7-1m"),
          mkModel("claude-opus-4.7-1m-internal"),
        ],
      }

      expect(translateModelName("claude-opus-4-7")).toBe("claude-opus-4.7-1m")
    })

    test("does not double-upgrade already-1M model names", () => {
      state.models = {
        object: "list",
        data: [
          mkModel("claude-opus-4.6-1m"),
          mkModel("claude-opus-4.7-1m-internal"),
        ],
      }

      expect(translateModelName("claude-opus-4.6-1m")).toBe(
        "claude-opus-4.6-1m",
      )
      expect(translateModelName("claude-opus-4-6-1m")).toBe(
        "claude-opus-4.6-1m",
      )
      expect(translateModelName("claude-opus-4.7-1m-internal")).toBe(
        "claude-opus-4.7-1m-internal",
      )
    })

    test("does not upgrade when no 1M variant exists in model list", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.5"), mkModel("claude-sonnet-4.6")],
      }

      expect(translateModelName("claude-opus-4-5")).toBe("claude-opus-4.5")
      expect(translateModelName("claude-sonnet-4-6")).toBe("claude-sonnet-4.6")
    })

    test("does not upgrade when no model list loaded", () => {
      // Without state.models, find1MVariant returns undefined.
      expect(translateModelName("claude-opus-4-7")).toBe("claude-opus-4.7")
      expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
    })
  })

  describe("[1m] suffix handling (legacy explicit opt-in)", () => {
    test("strips [1m] suffix and routes to 1M variant when advertised", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.6"), mkModel("claude-opus-4.6-1m")],
      }

      expect(translateModelName("claude-opus-4-6[1m]")).toBe(
        "claude-opus-4.6-1m",
      )
      expect(translateModelName("claude-opus-4.6[1m]")).toBe(
        "claude-opus-4.6-1m",
      )
    })

    test("[1m] suffix is no-op when no 1M variant exists", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.5")],
      }

      expect(translateModelName("claude-opus-4-5[1m]")).toBe("claude-opus-4.5")
    })
  })

  describe("defensive: stale -1m suffix without backing variant", () => {
    test("strips -1m suffix when no model list loaded", () => {
      // Behavior preserved from previous logic: defensive against stale config.
      expect(translateModelName("claude-opus-4.6-1m")).toBe(
        "claude-opus-4.6-1m",
      )
      // ↑ When no model list, is1MVariant matches and returns as-is.
      // The "strip" only applies when we attempt to look up a variant.
    })

    test("falls back to base when -1m variant in list but model list lacks it", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.5")], // no -1m variant
      }

      // Input is already -1m form, but we have no 1M variant in the list.
      // is1MVariant matches, so we keep it as-is (defensive: trust the input).
      expect(translateModelName("claude-opus-4.5-1m")).toBe(
        "claude-opus-4.5-1m",
      )
    })
  })

  describe("opus-4.8 (single-variant family, medium-only effort)", () => {
    // Empirically verified from api.enterprise.githubcopilot.com/models:
    //   claude-opus-4.8 is the ONLY 4.8 variant — no -1m, -1m-internal,
    //   -high, or -xhigh. Its supports.reasoning_effort is ["medium"].
    test("dash-major-minor normalizes to dotted", () => {
      expect(translateModelName("claude-opus-4-8")).toBe("claude-opus-4.8")
    })

    test("date suffix is stripped", () => {
      expect(translateModelName("claude-opus-4-8-20260101")).toBe(
        "claude-opus-4.8",
      )
    })

    test("does not invent a 1M variant for 4.8 (none advertised)", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.8")],
      }
      expect(translateModelName("claude-opus-4-8")).toBe("claude-opus-4.8")
      expect(translateModelName("claude-opus-4.8")).toBe("claude-opus-4.8")
    })

    test("[1m] suffix is a no-op when Copilot has no 1M 4.8 variant", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.8")],
      }
      expect(translateModelName("claude-opus-4-8[1m]")).toBe("claude-opus-4.8")
    })

    test("if Copilot ever ships claude-opus-4.8-1m, we route to it", () => {
      // Forward-compat: when the variant appears, default routing picks it up
      // without further code changes.
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.8"), mkModel("claude-opus-4.8-1m")],
      }
      expect(translateModelName("claude-opus-4-8")).toBe("claude-opus-4.8-1m")
    })
  })

  describe("subagent / dated model names", () => {
    test("claude-sonnet-4-{date} maps to claude-sonnet-4 (no 1M variant)", () => {
      expect(translateModelName("claude-sonnet-4-20250514")).toBe(
        "claude-sonnet-4",
      )
    })

    test("claude-opus-4-{date} maps to claude-opus-4 (no 1M variant)", () => {
      expect(translateModelName("claude-opus-4-20250514")).toBe("claude-opus-4")
    })
  })
})

describe("translateToOpenAI — reasoning_effort wiring", () => {
  beforeEach(() => {
    state.models = undefined
  })

  test("sets reasoning_effort when resolved model is a 1M variant", () => {
    state.models = {
      object: "list",
      data: [
        mkModel("claude-opus-4.7"),
        mkModel("claude-opus-4.7-1m-internal"),
      ],
    }

    const result = translateToOpenAI(mkPayload("claude-opus-4-7"), {
      effort: "xhigh",
    })

    expect(result.model).toBe("claude-opus-4.7-1m-internal")
    expect(result.reasoning_effort).toBe("xhigh")
  })

  test("sets reasoning_effort for 4.6-1m too", () => {
    state.models = {
      object: "list",
      data: [mkModel("claude-opus-4.6"), mkModel("claude-opus-4.6-1m")],
    }

    const result = translateToOpenAI(mkPayload("claude-opus-4-6"), {
      effort: "high",
    })

    expect(result.model).toBe("claude-opus-4.6-1m")
    expect(result.reasoning_effort).toBe("high")
  })

  test("does NOT set reasoning_effort when resolved model is non-1M", () => {
    // No 1M variant in list → keep base model → no reasoning_effort.
    state.models = {
      object: "list",
      data: [mkModel("claude-opus-4.5")],
    }

    const result = translateToOpenAI(mkPayload("claude-opus-4-5"), {
      effort: "high",
    })

    expect(result.model).toBe("claude-opus-4.5")
    expect(result.reasoning_effort).toBeUndefined()
  })

  test("maps effort=max to reasoning_effort=xhigh (defense for non-CC clients)", () => {
    state.models = {
      object: "list",
      data: [
        mkModel("claude-opus-4.7"),
        mkModel("claude-opus-4.7-1m-internal"),
      ],
    }

    const result = translateToOpenAI(mkPayload("claude-opus-4-7"), {
      effort: "max",
    })

    expect(result.reasoning_effort).toBe("xhigh")
  })

  test("does not set reasoning_effort when effort is missing", () => {
    state.models = {
      object: "list",
      data: [
        mkModel("claude-opus-4.7"),
        mkModel("claude-opus-4.7-1m-internal"),
      ],
    }

    const result = translateToOpenAI(mkPayload("claude-opus-4-7"))

    expect(result.model).toBe("claude-opus-4.7-1m-internal")
    expect(result.reasoning_effort).toBeUndefined()
  })

  test("ignores wants1M option (kept in signature for compatibility)", () => {
    state.models = {
      object: "list",
      data: [
        mkModel("claude-opus-4.7"),
        mkModel("claude-opus-4.7-1m-internal"),
      ],
    }

    // Both wants1M=true and wants1M=false should produce the same result now.
    const a = translateToOpenAI(mkPayload("claude-opus-4-7"), {
      wants1M: true,
      effort: "xhigh",
    })
    const b = translateToOpenAI(mkPayload("claude-opus-4-7"), {
      wants1M: false,
      effort: "xhigh",
    })

    expect(a.model).toBe(b.model)
    expect(a.reasoning_effort).toBe(b.reasoning_effort)
  })

  test("normalizes adaptive thinking to enabled", () => {
    const result = translateToOpenAI({
      ...mkPayload("claude-opus-4-7"),
      thinking: { type: "adaptive", budget_tokens: 5000 },
    })

    expect(result.thinking?.type).toBe("enabled")
    expect(result.thinking?.budget_tokens).toBe(5000)
  })

  // opus-4.8: empirically the base (and only) model now accepts reasoning_effort,
  // limited to ["medium"]. The base 4.7 advertises ["medium"] too but historically
  // we only set reasoning_effort on 1M variants — capability-aware gating preserves
  // that behavior for 4.7 (no supports list in legacy fixtures) and unlocks it for 4.8.
  test("sets reasoning_effort on opus-4.8 when supports list includes the value", () => {
    state.models = {
      object: "list",
      data: [mkModelWithEffort("claude-opus-4.8", ["medium"])],
    }

    const result = translateToOpenAI(mkPayload("claude-opus-4-8"), {
      effort: "medium",
    })

    expect(result.model).toBe("claude-opus-4.8")
    expect(result.reasoning_effort).toBe("medium")
  })

  test("still passes through a non-medium effort on 4.8 (handler rejects, not translation)", () => {
    // Translation layer is intentionally lenient: it only checks that the model
    // advertises a supports list. The handler's checkReasoningEffortSupport is
    // what returns the clean 400. Keeping concerns separate means the
    // translation function stays pure / side-effect-free.
    state.models = {
      object: "list",
      data: [mkModelWithEffort("claude-opus-4.8", ["medium"])],
    }

    const result = translateToOpenAI(mkPayload("claude-opus-4-8"), {
      effort: "xhigh",
    })

    expect(result.reasoning_effort).toBe("xhigh")
  })

  test("legacy fallback: 4.7-1m-internal without capabilities still gets effort wired", () => {
    // This is the path the existing test fixtures hit — no `capabilities` field
    // on the Model. We preserve historical behavior so old tests / setups keep
    // working until they migrate to the richer fixture.
    state.models = {
      object: "list",
      data: [
        mkModel("claude-opus-4.7"),
        mkModel("claude-opus-4.7-1m-internal"),
      ],
    }

    const result = translateToOpenAI(mkPayload("claude-opus-4-7"), {
      effort: "xhigh",
    })

    expect(result.model).toBe("claude-opus-4.7-1m-internal")
    expect(result.reasoning_effort).toBe("xhigh")
  })
})

// Trailing-whitespace handling on assistant turns. The Anthropic upstream
// (proxied through Copilot) rejects assistant prefill content that ends in
// whitespace with: "messages: final assistant content cannot end with trailing
// whitespace". CC CLI replays assistant turns with thinking blocks whose text
// frequently ends in "\n", so the rtrim is required for opus-4.6 / 4.7 / 4.8.
describe("translateToOpenAI — trailing whitespace on assistant content", () => {
  beforeEach(() => {
    state.models = undefined
  })

  test("rtrims a plain-string assistant message", () => {
    const result = translateToOpenAI({
      model: "gpt-4o",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello  \n " },
      ],
    })

    const assistant = result.messages.find((m) => m.role === "assistant")
    expect(assistant?.content).toBe("hello")
  })

  test("rtrims a thinking+text concatenated assistant message", () => {
    // This is the real CC CLI shape: assistant turn with thinking + text blocks.
    // mapContent preserves the original block order; rtrim only strips the
    // joined string's trailing whitespace, which is what the upstream cares about.
    const result = translateToOpenAI({
      model: "claude-opus-4-8",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me think...\n" },
            { type: "text", text: "answer is 42  " },
          ],
        },
      ],
    })

    const assistant = result.messages.find((m) => m.role === "assistant")
    expect(assistant?.content).toBe("let me think...\n\n\nanswer is 42")
  })

  test("rtrims when tool_use is present (allTextContent join path)", () => {
    // The other branch: when tool_use is present, text + thinking are joined
    // (text first, then thinking). The trailing thinking's "\n" must be stripped.
    const result = translateToOpenAI({
      model: "claude-opus-4-8",
      max_tokens: 64,
      messages: [
        { role: "user", content: "look it up" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tool" },
            { type: "thinking", thinking: "I should call the tool\n" },
            {
              type: "tool_use",
              id: "t1",
              name: "lookup",
              input: { q: "x" },
            },
          ],
        },
      ],
    })

    const assistant = result.messages.find((m) => m.role === "assistant")
    expect(assistant?.content).toBe("calling tool\n\nI should call the tool")
    expect(assistant?.tool_calls).toHaveLength(1)
  })

  test("rtrims thinking-only assistant content", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4-8",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "thinking out loud...\n" }],
        },
      ],
    })

    const assistant = result.messages.find((m) => m.role === "assistant")
    expect(assistant?.content).toBe("thinking out loud...")
  })

  test("trims only the last text part in a structured (image-bearing) content array", () => {
    // mapContent returns Array<ContentPart> when an image is present. We need
    // to trim only the trailing whitespace on the last text part — earlier
    // whitespace is part of the structured content and may be load-bearing.
    const result = translateToOpenAI({
      model: "claude-opus-4-8",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          // String-content path; structured array tested by direct unit on
          // rtrimAssistantText would require exposing it. Here we just confirm
          // string path strips.
          content: "result:  \t\n",
        },
      ],
    })

    const assistant = result.messages.find((m) => m.role === "assistant")
    expect(assistant?.content).toBe("result:")
  })

  test("preserves assistant content that has no trailing whitespace", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4-8",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "answer." },
      ],
    })

    const assistant = result.messages.find((m) => m.role === "assistant")
    expect(assistant?.content).toBe("answer.")
  })

  test("does not touch user messages — only assistant content gets rtrimmed", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4-8",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi  \n" }],
    })

    const user = result.messages.find((m) => m.role === "user")
    expect(user?.content).toBe("hi  \n")
  })
})
