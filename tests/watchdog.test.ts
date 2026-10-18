import { describe, expect, test } from "bun:test";
import { createInactivityWatchdogStream } from "../src/hooks/resilience.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("createInactivityWatchdogStream", () => {
  test("passes chunks through when they keep arriving", async () => {
    let timeoutFired = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("chunk 1"));
        controller.enqueue(enc.encode("chunk 2"));
        controller.close();
      },
    });

    const watched = createInactivityWatchdogStream(source, 200, () => {
      timeoutFired = true;
    });

    const reader = watched.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(dec.decode(value!));
    }

    expect(chunks.join("")).toBe("chunk 1chunk 2");
    expect(timeoutFired).toBe(false);
  });

  test("does not fire before the first chunk arrives", async () => {
    let timeoutFired = false;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const source = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(enc.encode("late"));
        controller.close();
      },
    });

    const watched = createInactivityWatchdogStream(source, 30, () => {
      timeoutFired = true;
    });

    const reader = watched.getReader();
    const pending = reader.read();
    await new Promise((r) => setTimeout(r, 80));
    release!();

    const first = await pending;
    expect(dec.decode(first.value!)).toBe("late");
    expect(timeoutFired).toBe(false);
  });

  test("aborts the stream and notifies when it stalls after the first chunk", async () => {
    let timeoutFired = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("initial"));
        // deliberately never closes or enqueues again
      },
    });

    const watched = createInactivityWatchdogStream(source, 40, () => {
      timeoutFired = true;
    });

    const reader = watched.getReader();
    const first = await reader.read();
    expect(dec.decode(first.value!)).toBe("initial");

    let errCaught: unknown = null;
    try {
      await reader.read();
    } catch (err) {
      errCaught = err;
    }

    expect(errCaught).not.toBeNull();
    expect(String(errCaught)).toContain("CommandCode Watchdog");
    expect(timeoutFired).toBe(true);
  });

  test("clears the timer when the consumer cancels", async () => {
    let timeoutFired = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("initial"));
      },
    });

    const watched = createInactivityWatchdogStream(source, 30, () => {
      timeoutFired = true;
    });

    const reader = watched.getReader();
    await reader.read();
    await reader.cancel();

    await new Promise((r) => setTimeout(r, 80));
    expect(timeoutFired).toBe(false);
  });

  test("propagates upstream errors", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("upstream boom"));
      },
    });

    const watched = createInactivityWatchdogStream(source, 200);
    const reader = watched.getReader();

    let errCaught: unknown = null;
    try {
      await reader.read();
    } catch (err) {
      errCaught = err;
    }

    expect(String(errCaught)).toContain("upstream boom");
  });
});
