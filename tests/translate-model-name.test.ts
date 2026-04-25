import { describe, test, expect, beforeEach } from "bun:test"

import { state } from "../src/lib/state"
import { translateModelName } from "../src/routes/messages/non-stream-translation"

describe("translateModelName", () => {
  beforeEach(() => {
    // Reset model list before each test
    state.models = undefined
  })

  describe("pass-through", () => {
    test("non-Claude models pass through unchanged", () => {
      expect(translateModelName("gpt-4o")).toBe("gpt-4o")
      expect(translateModelName("gpt-5.1")).toBe("gpt-5.1")
    })

    test("already-dotted Claude names pass through when no model list", () => {
      expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
      expect(translateModelName("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
      expect(translateModelName("claude-opus-4.6-1m")).toBe(
        "claude-opus-4.6-1m",
      )
    })
  })

  describe("dash-to-dot conversion", () => {
    test("converts major-minor dashes to dots", () => {
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

    test("preserves non-date suffixes", () => {
      expect(translateModelName("claude-opus-4-6-1m")).toBe(
        "claude-opus-4.6-1m",
      )
    })

    test("handles date-only suffix (no minor version)", () => {
      expect(translateModelName("claude-sonnet-4-20260101")).toBe(
        "claude-sonnet-4",
      )
    })
  })

  describe("auto-upgrade to -1m (always, not just with [1m] suffix)", () => {
    test("auto-upgrades claude-opus-4-6 to -1m when available", () => {
      state.models = {
        data: [
          { id: "claude-opus-4.6", object: "model", type: "model", created: 0 },
          {
            id: "claude-opus-4.6-1m",
            object: "model",
            type: "model",
            created: 0,
          },
        ],
      }

      expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6-1m")
    })

    test("auto-upgrades claude-sonnet-4-6 to -1m when available", () => {
      state.models = {
        data: [
          {
            id: "claude-sonnet-4.6",
            object: "model",
            type: "model",
            created: 0,
          },
          {
            id: "claude-sonnet-4.6-1m",
            object: "model",
            type: "model",
            created: 0,
          },
        ],
      }

      expect(translateModelName("claude-sonnet-4-6")).toBe(
        "claude-sonnet-4.6-1m",
      )
    })

    test("auto-upgrades already-dotted claude-opus-4.6 to -1m when available", () => {
      state.models = {
        data: [
          { id: "claude-opus-4.6", object: "model", type: "model", created: 0 },
          {
            id: "claude-opus-4.6-1m",
            object: "model",
            type: "model",
            created: 0,
          },
        ],
      }

      expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6-1m")
    })

    test("auto-upgrades already-dotted claude-sonnet-4.6 to -1m when available", () => {
      state.models = {
        data: [
          {
            id: "claude-sonnet-4.6",
            object: "model",
            type: "model",
            created: 0,
          },
          {
            id: "claude-sonnet-4.6-1m",
            object: "model",
            type: "model",
            created: 0,
          },
        ],
      }

      expect(translateModelName("claude-sonnet-4.6")).toBe(
        "claude-sonnet-4.6-1m",
      )
    })

    test("does not upgrade when -1m variant not in model list", () => {
      state.models = {
        data: [
          { id: "claude-opus-4.6", object: "model", type: "model", created: 0 },
        ],
      }

      expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
    })

    test("does not upgrade when no model list loaded", () => {
      expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
    })

    test("does not double-upgrade already -1m names", () => {
      state.models = {
        data: [
          {
            id: "claude-opus-4.6-1m",
            object: "model",
            type: "model",
            created: 0,
          },
        ],
      }

      expect(translateModelName("claude-opus-4.6-1m")).toBe(
        "claude-opus-4.6-1m",
      )
      expect(translateModelName("claude-opus-4-6-1m")).toBe(
        "claude-opus-4.6-1m",
      )
    })
  })

  describe("[1m] suffix handling", () => {
    test("strips [1m] and converts model name", () => {
      expect(translateModelName("claude-opus-4-6[1m]")).toBe("claude-opus-4.6")
    })

    test("auto-upgrades to -1m when available in model list", () => {
      state.models = {
        data: [
          { id: "claude-opus-4.6", object: "model", type: "model", created: 0 },
          {
            id: "claude-opus-4.6-1m",
            object: "model",
            type: "model",
            created: 0,
          },
        ],
      }

      expect(translateModelName("claude-opus-4-6[1m]")).toBe(
        "claude-opus-4.6-1m",
      )
    })

    test("[1m] on already-dotted name", () => {
      state.models = {
        data: [
          {
            id: "claude-opus-4.6-1m",
            object: "model",
            type: "model",
            created: 0,
          },
        ],
      }

      expect(translateModelName("claude-opus-4.6[1m]")).toBe(
        "claude-opus-4.6-1m",
      )
    })
  })

  describe("subagent model names (stock behavior preserved)", () => {
    test("claude-sonnet-4-* maps to claude-sonnet-4", () => {
      expect(translateModelName("claude-sonnet-4-20250514")).toBe(
        "claude-sonnet-4",
      )
    })

    test("claude-opus-4-* maps to claude-opus-4", () => {
      expect(translateModelName("claude-opus-4-20250514")).toBe("claude-opus-4")
    })
  })
})

describe("translateModelName -1m-internal fallback", () => {
  beforeEach(() => {
    state.models = undefined
  })

  test("falls back to -1m-internal when -1m not present (e.g. claude-opus-4.7)", () => {
    state.models = {
      data: [
        { id: "claude-opus-4.7", object: "model", type: "model", created: 0 },
        {
          id: "claude-opus-4.7-1m-internal",
          object: "model",
          type: "model",
          created: 0,
        },
      ],
    }

    expect(translateModelName("claude-opus-4-7")).toBe(
      "claude-opus-4.7-1m-internal",
    )
    expect(translateModelName("claude-opus-4.7")).toBe(
      "claude-opus-4.7-1m-internal",
    )
  })

  test("prefers -1m over -1m-internal when both available", () => {
    state.models = {
      data: [
        { id: "claude-opus-4.7", object: "model", type: "model", created: 0 },
        {
          id: "claude-opus-4.7-1m",
          object: "model",
          type: "model",
          created: 0,
        },
        {
          id: "claude-opus-4.7-1m-internal",
          object: "model",
          type: "model",
          created: 0,
        },
      ],
    }

    expect(translateModelName("claude-opus-4-7")).toBe("claude-opus-4.7-1m")
  })

  test("passes through -1m-internal names without double-upgrade", () => {
    state.models = {
      data: [
        {
          id: "claude-opus-4.7-1m-internal",
          object: "model",
          type: "model",
          created: 0,
        },
      ],
    }

    expect(translateModelName("claude-opus-4.7-1m-internal")).toBe(
      "claude-opus-4.7-1m-internal",
    )
  })
})
