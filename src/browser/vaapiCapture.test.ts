/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * vaapiCapture.test.ts: Unit tests for the VAAPI capture backend's argument construction in vaapiCapture.ts. The acquisition itself needs an X server, a
 * VAAPI-capable GPU, and a live browser, none of which exist in CI - so the module deliberately factors the decision-making into two pure functions, and these
 * tests pin the argument vector that decides what FFmpeg actually does. The encoder settings asserted here are not stylistic: the CQP rate control and the
 * CPU-side pixel format conversion are the only combination the Gen9.5 low-power H.264 entrypoint accepts, so a change to either is a regression that would
 * otherwise surface only as a failed encoder open on real hardware.
 */
import { VAAPI_PIXEL_FORMAT, VAAPI_RC_MODE, attachCaptureRetirement, buildVaapiCaptureArgs, fitSurfaceToDisplay, presentCaptureDisplay,
  toX11GrabInput } from "./vaapiCapture.ts";
import { describe, test } from "node:test";
import { CONFIG } from "../config/index.ts";
import type { CaptureStreamOptions } from "./tabCapture.ts";
import type { LogEntry } from "../utils/index.ts";
import type { Nullable } from "../types/index.ts";
import type { Page } from "puppeteer-core";
import { PassThrough } from "node:stream";
import { TestClock } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { subscribeToLogs } from "../utils/index.ts";

/* Reads the value FFmpeg would take for a flag, so an assertion names the flag it cares about rather than an index into the vector. Returns null when the flag is
 * absent, which is the distinction several tests below turn on.
 */
function valueOf(args: string[], flag: string): string | null {

  const index = args.indexOf(flag);

  return ((index === -1) || ((index + 1) >= args.length)) ? null : args[index + 1]!;
}

// A capture request with the fields this backend reads. Tests override only what they are about.
function makeOptions(overrides: Partial<CaptureStreamOptions> = {}): CaptureStreamOptions {

  return {

    audio: true,
    audioBitsPerSecond: 256000,
    mimeType: "video/x-matroska;codecs=h264,opus",
    video: true,
    videoBitsPerSecond: 12000000,
    videoConstraints: { mandatory: { maxFrameRate: 60, maxHeight: 720, maxWidth: 1280, minFrameRate: 30, minHeight: 720, minWidth: 1280 } },
    ...overrides
  };
}

describe("toX11GrabInput", () => {

  test("qualifies a bare display with the default screen, because x11grab addresses a screen and not a display", () => {

    assert.equal(toX11GrabInput(":0"), ":0.0+0,0");
    assert.equal(toX11GrabInput(":1"), ":1.0+0,0");
  });

  test("leaves a display that already names a screen alone", () => {

    assert.equal(toX11GrabInput(":0.0"), ":0.0+0,0");
    assert.equal(toX11GrabInput(":1.2"), ":1.2+0,0");
  });

  test("does not mistake a dotted hostname for a screen number", () => {

    assert.equal(toX11GrabInput("kiosk.local:0"), "kiosk.local:0.0+0,0");
  });
});

describe("buildVaapiCaptureArgs", () => {

  test("grabs the whole display at the constraint band's ceiling", () => {

    const args = buildVaapiCaptureArgs(makeOptions(), ":1");

    assert.equal(valueOf(args, "-f"), "x11grab");
    assert.equal(valueOf(args, "-i"), ":1.0+0,0");

    // No -video_size: x11grab then covers the whole screen, which is what the full-screened browser occupies on a display it owns. Naming a size instead would
    // make the grab fail outright the moment the region crossed a screen edge.
    assert.equal(valueOf(args, "-video_size"), null);

    // The ceiling, not the floor: x11grab emits at a fixed cadence, so grabbing at the floor would discard frames already captured.
    assert.equal(valueOf(args, "-framerate"), "60");
  });

  test("holds the output to the configured surface whatever the display measures", () => {

    assert.equal(valueOf(buildVaapiCaptureArgs(makeOptions(), ":0"), "-vf"), "scale=1280:720," + VAAPI_PIXEL_FORMAT);

    const uhd = makeOptions({ videoConstraints: { mandatory: { maxFrameRate: 60, maxHeight: 1080, maxWidth: 1920, minFrameRate: 30, minHeight: 1080,
      minWidth: 1920 } } });

    assert.equal(valueOf(buildVaapiCaptureArgs(uhd, ":0"), "-vf"), "scale=1920:1080," + VAAPI_PIXEL_FORMAT);
  });

  test("encodes on the GPU with the only rate control the low-power entrypoint accepts", () => {

    const args = buildVaapiCaptureArgs(makeOptions(), ":0");

    assert.equal(valueOf(args, "-c:v"), "h264_vaapi");
    assert.equal(valueOf(args, "-rc_mode"), VAAPI_RC_MODE);
    assert.equal(valueOf(args, "-qp"), String(CONFIG.streaming.vaapiQp));
    assert.equal(valueOf(args, "-vaapi_device"), CONFIG.streaming.vaapiDevice);
  });

  test("asks for a keyframe every two seconds so segment durations match the extension backend's", () => {

    assert.equal(valueOf(buildVaapiCaptureArgs(makeOptions(), ":0"), "-g"), "120");

    const halfRate = makeOptions({ videoConstraints: { mandatory: { maxFrameRate: 30, maxHeight: 720, maxWidth: 1280, minFrameRate: 30, minHeight: 720,
      minWidth: 1280 } } });

    assert.equal(valueOf(buildVaapiCaptureArgs(halfRate, ":0"), "-g"), "60");
  });

  test("produces the same container shape the extension backend does, so the remux needs no branch", () => {

    const args = buildVaapiCaptureArgs(makeOptions(), ":0");

    assert.equal(args.at(-1), "pipe:1");
    assert.ok(args.includes("matroska"));
    assert.equal(valueOf(args, "-c:a"), "libopus");
    assert.equal(valueOf(args, "-b:a"), "256000");
  });

  test("omits the audio input and codec entirely for a video-only capture", () => {

    const args = buildVaapiCaptureArgs(makeOptions({ audio: false }), ":0");

    assert.ok(!args.includes("pulse"));
    assert.ok(!args.includes("-c:a"));
    assert.ok(!args.includes("libopus"));

    // The video half is untouched by the absence of audio.
    assert.equal(valueOf(args, "-c:v"), "h264_vaapi");
  });

  test("falls back to the configured audio bitrate when the request names none", () => {

    assert.equal(valueOf(buildVaapiCaptureArgs(makeOptions({ audioBitsPerSecond: undefined }), ":0"), "-b:a"),
      String(CONFIG.streaming.audioBitsPerSecond));
  });
});

/* A Page double carrying only what the presentation touches: the closed test both window primitives take first, the CDP session the full screen command goes out
 * on, and the activation. Every call is recorded in order, because the order is the contract - a page brought to the front of a window that is not yet full screen
 * is a raised small window, which is exactly the frame this backend must not produce.
 */
function makePresentationPage(options: { bringToFrontError?: Error; windowStates?: readonly string[] } = {}): { calls: string[]; page: Page } {

  const calls: string[] = [];
  const states = options.windowStates ?? [ "normal", "fullscreen" ];

  let reads = 0;

  const session = {

    detach: async (): Promise<void> => undefined,
    send: async (method: string, params?: unknown): Promise<unknown> => {

      if(method === "Browser.getWindowForTarget") {

        return { windowId: 7 };
      }

      if(method === "Browser.getWindowBounds") {

        const state = states[Math.min(reads, states.length - 1)];

        reads++;

        return { bounds: { windowState: state } };
      }

      if(method === "Browser.setWindowBounds") {

        calls.push("setWindowBounds:" + String((params as { bounds?: { windowState?: string } }).bounds?.windowState));
      }

      return undefined;
    }
  };

  const page = {

    bringToFront: async (): Promise<void> => {

      calls.push("bringToFront");

      if(options.bringToFrontError) {

        throw options.bringToFrontError;
      }
    },
    createCDPSession: async (): Promise<unknown> => session,
    isClosed: (): boolean => false
  };

  return { calls, page: page as unknown as Page };
}

describe("presentCaptureDisplay", () => {

  test("puts the window full screen before bringing the page to the front", async () => {

    /* Both steps, in this order. The grab reads the display, so a page that is not the front tab of a raised full screen window puts something else in the frames
     * - and a hidden capture page does not merely look wrong, it never reaches a playable video at all.
     */
    const { calls, page } = makePresentationPage();
    const clock = new TestClock();

    await presentCaptureDisplay(page, clock);

    assert.deepEqual(calls, [ "setWindowBounds:fullscreen", "bringToFront" ], "the window is presented, then the page is raised into it");
  });

  test("stages a minimized window through normal on the way to full screen", async () => {

    // The window is minimized between streams, and Chrome refuses a move out of that state that does not pass through normal.
    const { calls, page } = makePresentationPage({ windowStates: [ "minimized", "normal", "fullscreen" ] });
    const clock = new TestClock();

    await presentCaptureDisplay(page, clock);

    assert.deepEqual(calls, [ "setWindowBounds:normal", "setWindowBounds:fullscreen", "bringToFront" ], "the restore precedes the full screen command");
  });

  test("a failed activation warns and returns rather than failing the capture", async () => {

    // A badly presented grab is a bad stream; a thrown error here is no stream. The fault is named in the log and the capture proceeds.
    const { calls, page } = makePresentationPage({ bringToFrontError: new Error("synthetic activation failure") });
    const clock = new TestClock();

    await assert.doesNotReject(() => presentCaptureDisplay(page, clock), "the presentation absorbs an activation failure");
    assert.deepEqual(calls, [ "setWindowBounds:fullscreen", "bringToFront" ], "the activation was attempted");
  });
});


describe("attachCaptureRetirement", () => {

  /* A page whose close handler can be fired on demand, which is how a test stands in for a browser tab dying under a live capture. */
  function makeClosablePage(): { close: () => void; page: Pick<Page, "once"> } {

    const handlers: (() => void)[] = [];

    return {

      // Honors once: the handlers fire at most one time each, as they do on a real page, so a test can ask twice and see what a second close would really do.
      close: (): void => handlers.splice(0).forEach((handler) => handler()),
      page: { once: (_event: string, handler: () => void): unknown => (handlers.push(handler), null) } as unknown as Pick<Page, "once">
    };
  }

  test("stops the capture when the owner destroys the stream", async () => {

    /* This is the whole contract an owner has for retiring a capture: destroy the stream, then wait for stopped. Without this path the destroy severs the pipe and
     * tells the FFmpeg child nothing, which leaves it alive holding the display and the audio source - and a leaked capture per retirement exhausts the audio
     * server's client slots, after which every tune fails at its audio input regardless of channel.
     */
    const stream = new PassThrough();
    const { page } = makeClosablePage();
    let stops = 0;

    attachCaptureRetirement(stream, page, async (): Promise<void> => { stops++; });

    stream.destroy();
    await new Promise((resolve) => stream.once("close", resolve));

    assert.equal(stops, 1, "destroying the stream stopped the capture");
  });

  test("stops the capture when the page closes", async () => {

    // A capture whose page is gone has nothing left to grab, and nobody is coming to retire it through the stream.
    const stream = new PassThrough();
    const { close, page } = makeClosablePage();
    let stops = 0;

    attachCaptureRetirement(stream, page, async (): Promise<void> => { stops++; });
    close();

    assert.equal(stops, 1, "the page's death stopped the capture");
  });

  test("stops once when both paths fire", async () => {

    // The ordinary shutdown fires both: the page closes and the stream it fed ends with it. stop() is idempotent, and each path registers once.
    const stream = new PassThrough();
    const { close, page } = makeClosablePage();
    let stops = 0;

    attachCaptureRetirement(stream, page, async (): Promise<void> => { stops++; });

    close();
    close();
    stream.destroy();
    await new Promise((resolve) => stream.once("close", resolve));

    assert.equal(stops, 2, "each path fires once, and neither repeats");
  });
});


describe("fitSurfaceToDisplay", () => {

  /* A page reporting a window frame and carrying an emulated surface, which is the whole of what the fit reads and writes. Bounds of null stand for a window whose
   * placement will not read completely - a closed page, a target with no window, a response missing one of its numbers.
   * @param options - The window frame to report and the surface the page starts emulated at.
   * @returns The page, plus the viewports set on it in order.
   */
  function makeFittablePage(options: { bounds: Nullable<{ height: number; width: number }>; viewport: Nullable<{ deviceScaleFactor: number; height: number;
    width: number; }>; }): { page: Page; viewports: { deviceScaleFactor?: number; height: number; width: number }[] } {

    const viewports: { deviceScaleFactor?: number; height: number; width: number }[] = [];
    let current = options.viewport;

    const session = {

      detach: async (): Promise<void> => undefined,
      send: async (method: string): Promise<unknown> => {

        if(method === "Browser.getWindowForTarget") {

          return { windowId: 7 };
        }

        if(method === "Browser.getWindowBounds") {

          // A full placement or none at all: readWindowPlacement requires all four numbers and the state, and answers null for anything less.
          return options.bounds ? { bounds: { height: options.bounds.height, left: 0, top: 0, width: options.bounds.width, windowState: "fullscreen" } } : {};
        }

        return undefined;
      }
    };

    const page = {

      createCDPSession: async (): Promise<unknown> => session,
      isClosed: (): boolean => false,
      setViewport: async (viewport: { deviceScaleFactor?: number; height: number; width: number }): Promise<void> => {

        viewports.push(viewport);
        current = { deviceScaleFactor: viewport.deviceScaleFactor ?? 1, height: viewport.height, width: viewport.width };
      },
      viewport: (): Nullable<{ deviceScaleFactor: number; height: number; width: number }> => current
    };

    return { page: page as unknown as Page, viewports };
  }

  /* Runs a body with the emitted warnings captured.
   * @param body - The work to run under capture.
   * @returns The warn-level entries emitted while the body ran.
   */
  async function captureWarnings(body: () => Promise<void>): Promise<LogEntry[]> {

    const captured: LogEntry[] = [];
    const unsubscribe = subscribeToLogs((entry) => { captured.push(entry); });

    try {

      await body();
    } finally {

      unsubscribe();
    }

    return captured.filter((entry) => entry.level === "warn");
  }

  test("emulates the surface at the display's dimensions when the preset does not match it", async () => {

    /* The failure this exists for. A 1280x720 surface on a 1920x1080 display paints two thirds of each axis, so the grab returns 45% picture on a field of the
     * browser's background - a well-formed stream at the right resolution that no health check can tell from a good one.
     */
    const { page, viewports } = makeFittablePage({ bounds: { height: 1080, width: 1920 }, viewport: { deviceScaleFactor: 1, height: 720, width: 1280 } });

    assert.equal(await fitSurfaceToDisplay(page), true, "the display was read and the surface fitted to it");
    assert.deepEqual(viewports, [{ deviceScaleFactor: 1, height: 1080, width: 1920 }], "the surface now covers the display the grab reads");
  });

  test("carries the declared density through the resize", async () => {

    // The density was read from the page and declared deliberately. This changes how much of the display the page covers, not how finely it rasters.
    const { page, viewports } = makeFittablePage({ bounds: { height: 1080, width: 1920 }, viewport: { deviceScaleFactor: 2, height: 720, width: 1280 } });

    await fitSurfaceToDisplay(page);

    assert.equal(viewports[0]?.deviceScaleFactor, 2, "the page's own density survived the fit");
  });

  test("issues no command when the surface already covers the display", async () => {

    // The documented deployment, and the common path: a display sized to the preset needs nothing done to it and must not pay a redundant re-layout per tune.
    const { page, viewports } = makeFittablePage({ bounds: { height: 720, width: 1280 }, viewport: { deviceScaleFactor: 1, height: 720, width: 1280 } });

    assert.equal(await fitSurfaceToDisplay(page), true, "the surface already matched");
    assert.deepEqual(viewports, [], "nothing was re-declared");
  });

  test("warns when it has to fit, naming both dimensions", async () => {

    /* A display that does not match the preset is a deployment fault with a running cost - a CPU scale on every frame for the length of the stream - and the
     * picture being correct either way is exactly why it would otherwise go unnoticed.
     */
    const { page } = makeFittablePage({ bounds: { height: 1080, width: 1920 }, viewport: { deviceScaleFactor: 1, height: 720, width: 1280 } });

    const warnings = await captureWarnings(async () => { await fitSurfaceToDisplay(page); });

    assert.equal(warnings.length, 1, "exactly one warning");
    assert.match(warnings[0]?.message ?? "", /1920x1080/, "the warning names the display");
    assert.match(warnings[0]?.message ?? "", /1280x720/, "the warning names the preset it is departing from");
  });

  test("leaves the surface alone when the display cannot be read", async () => {

    /* A placement that will not read completely is no measurement of the display, and a guess is worse than the preset - the preset is at least the size the page
     * was laid out and tuned at. The presentation already warns about the window it could not confirm, so this adds no second report of the same fault.
     */
    const { page, viewports } = makeFittablePage({ bounds: null, viewport: { deviceScaleFactor: 1, height: 720, width: 1280 } });

    const warnings = await captureWarnings(async () => {

      assert.equal(await fitSurfaceToDisplay(page), false, "the fit reports that it could not measure the display");
    });

    assert.deepEqual(viewports, [], "the surface was left as it was");
    assert.equal(warnings.length, 0, "the presentation's own warning is not duplicated here");
  });

  test("leaves a page carrying no surface alone", async () => {

    // A page PrismCast has not emulated has no surface to fit, and declaring one here would invent an emulation it never asked for.
    const { page, viewports } = makeFittablePage({ bounds: { height: 1080, width: 1920 }, viewport: null });

    assert.equal(await fitSurfaceToDisplay(page), true, "the display read fine; there was simply nothing to fit");
    assert.deepEqual(viewports, [], "no viewport was invented for it");
  });
});
