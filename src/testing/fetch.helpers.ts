/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fetch.helpers.ts: Response-shaped test fixtures for bounded fetches.
 */

/**
 * Builds a Response whose headers are available at once and whose body never closes. The stream it carries only ever errors, and it errors with the request
 * signal's own reason the moment that signal aborts, which is how the platform ends a body read when a bound lapses after the headers have landed.
 *
 * A test drives a bounded fetch against this to prove the bound spans the body read rather than the request alone: a bound cancelled at header arrival leaves
 * the read pending forever, so the row hangs instead of passing by accident. A request carrying no signal gets a body that simply never settles, which is the
 * shape for asserting that nothing but the signal ends the read.
 * @param init - The request init the fetch stub received, whose signal the body's failure is wired to.
 * @returns A 200 Response whose body stays open until the request signal aborts.
 */
export function pendingBodyFetch(init: RequestInit | undefined): Response {

  const signal = init?.signal;

  const body = new ReadableStream<Uint8Array>({

    start(controller): void {

      signal?.addEventListener("abort", () => controller.error(signal.reason));
    }
  });

  return new Response(body, { status: 200 });
}
