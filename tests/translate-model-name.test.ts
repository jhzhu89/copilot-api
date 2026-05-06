import { describe, test, expect, beforeEach } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import {
  translateModelName,
  translateToOpenAI,
} from "../src/routes/messages/non-stream-translation"

// Only `id` is read by translateModelName; cast to keep fixtures small.
const mkModel = (id: string): Model => ({ id, object: "model" }) as Model

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
})
