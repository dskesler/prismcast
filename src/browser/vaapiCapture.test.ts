/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * vaapiCapture.test.ts: Unit tests for the VAAPI capture backend's argument construction in vaapiCapture.ts. The acquisition itself needs an X server, a
 * VAAPI-capable GPU, and a live browser, none of which exist in CI - so the module deliberately factors the decision-making into two pure functions, and these
 * tests pin the argument vector that decides what FFmpeg actually does. The encoder settings asserted here are not stylistic: the CQP rate control and the
 * CPU-side pixel format conversion are the only combination the Gen9.5 low-power H.264 entrypoint accepts, so a change to either is a regression that would
 * otherwise surface only as a failed encoder open on real hardware.
 */
import { VAAPI_PIXEL_FORMAT, VAAPI_RC_MODE, buildVaapiCaptureArgs, presentCaptureDisplay, toX11GrabInput } from "./vaapiCapture.ts";
import { describe, test } from "node:test";
import { CONFIG } from "../config/index.ts";
import type { CaptureStreamOptions } from "./tabCapture.ts";
import type { Page } from "puppeteer-core";
import assert from "node:assert/strict";
import { makeFakeClock } from "../utils/clock.helpers.ts";

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
    const { clock } = makeFakeClock();

    await presentCaptureDisplay(page, clock);

    assert.deepEqual(calls, [ "setWindowBounds:fullscreen", "bringToFront" ], "the window is presented, then the page is raised into it");
  });

  test("stages a minimized window through normal on the way to full screen", async () => {

    // The window is minimized between streams, and Chrome refuses a move out of that state that does not pass through normal.
    const { calls, page } = makePresentationPage({ windowStates: [ "minimized", "normal", "fullscreen" ] });
    const { clock } = makeFakeClock();

    await presentCaptureDisplay(page, clock);

    assert.deepEqual(calls, [ "setWindowBounds:normal", "setWindowBounds:fullscreen", "bringToFront" ], "the restore precedes the full screen command");
  });

  test("a failed activation warns and returns rather than failing the capture", async () => {

    // A badly presented grab is a bad stream; a thrown error here is no stream. The fault is named in the log and the capture proceeds.
    const { calls, page } = makePresentationPage({ bringToFrontError: new Error("synthetic activation failure") });
    const { clock } = makeFakeClock();

    await assert.doesNotReject(() => presentCaptureDisplay(page, clock), "the presentation absorbs an activation failure");
    assert.deepEqual(calls, [ "setWindowBounds:fullscreen", "bringToFront" ], "the activation was attempted");
  });
});
