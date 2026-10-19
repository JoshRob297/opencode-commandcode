import { describe, expect, test } from "bun:test";
import { describeRetryEvent, extractModelId, extractProviderId } from "../src/telemetry.ts";

// Forma real del evento `retry` capturada en OpenCode v2.0.32 con un servidor
// de prueba que corta el stream a mitad (verificacion de campo).
const REAL_EVENT = {
  sessionID: "ses_eaa6f80fbffe0Tv4gX6eSqfnGl",
  agent: "build",
  model: { id: "probe-model", providerID: "probe" },
  error: {
    type: "provider.transport",
    message:
      "Connection lost while reading the response: ECONNRESET: The socket connection was closed unexpectedly.",
    status: 200,
  },
  attempt: 2,
  decision: { retry: true, delay: 2281 },
};

describe("retry telemetry", () => {
  test("extrae el modelo desde model.id (no existe modelID)", () => {
    expect(extractModelId(REAL_EVENT as any)).toBe("probe-model");
    expect(extractProviderId(REAL_EVENT as any)).toBe("probe");
  });

  test("no pierde la atribucion cuando el evento trae modelID", () => {
    expect(extractModelId({ modelID: "legacy-model" } as any)).toBe("legacy-model");
    expect(extractModelId({ model: { modelID: "nested" } } as any)).toBe("nested");
    expect(extractModelId({ model: "plain-string" } as any)).toBe("plain-string");
  });

  test("normaliza el evento real a la linea de telemetria", () => {
    const t = describeRetryEvent(REAL_EVENT as any, "2026-10-19T19:08:20.424Z");
    expect(t.at).toBe("2026-10-19T19:08:20.424Z");
    expect(t.sessionID).toBe("ses_eaa6f80fbffe0Tv4gX6eSqfnGl");
    expect(t.agent).toBe("build");
    expect(t.providerID).toBe("probe");
    expect(t.modelID).toBe("probe-model");
    expect(t.type).toBe("provider.transport");
    expect(t.status).toBe(200);
    expect(t.attempt).toBe(2);
    expect(t.retry).toBe(true);
    expect(t.delayMs).toBe(2281);
    expect(t.message).toContain("ECONNRESET");
  });

  test("trunca el mensaje a 400 caracteres", () => {
    const long = { error: { type: "provider.transport", message: "x".repeat(900) } } as any;
    const t = describeRetryEvent(long);
    expect(t.message!.length).toBe(400);
  });

  test("tolera eventos incompletos sin lanzar", () => {
    const t = describeRetryEvent({} as any);
    expect(t.modelID).toBeUndefined();
    expect(t.type).toBeUndefined();
    expect(t.message).toBeUndefined();
  });

  test("soporta el formato plano (sin objeto model)", () => {
    const t = describeRetryEvent({
      sessionID: "s",
      modelID: "m",
      providerID: "p",
      type: "provider.internal",
      status: 503,
    } as any);
    expect(t.modelID).toBe("m");
    expect(t.providerID).toBe("p");
    expect(t.type).toBe("provider.internal");
    expect(t.status).toBe(503);
  });
});
