/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * vaapiCapture.ts: Hardware-accelerated VAAPI capture for PrismCast.
 */
import type { AcquireCaptureStreamContext, CaptureStream, CaptureStreamOptions } from "./tabCapture.ts";
import { LOG, formatError, realClock, resolveFFmpegPath, startTimer } from "../utils/index.ts";
import { CAPTURE_SOURCE_UNAVAILABLE_MESSAGE } from "../types/index.ts";
import { CONFIG } from "../config/index.ts";
import type { ChildProcess } from "node:child_process";
import type { Clock } from "../utils/index.ts";
import type { Nullable } from "../types/index.ts";
import type { Page } from "puppeteer-core";
import { PassThrough } from "node:stream";
import { fullscreenWindow } from "./cdp.ts";
import { spawn } from "node:child_process";

/* This module is the second implementation of the capture contract that tabCapture.ts defines, and it exists because the first one cannot reach the GPU.
 *
 * Chrome's in-browser encoders are software-only on Linux. Both paths were measured on Intel UHD 620 (Whiskey Lake, Gen9.5) with Chrome 152: MediaRecorder spends
 * 145-206% CPU encoding a single 720p60 capture, and WebCodecs VideoEncoder reports `supported: false` for hardwareAcceleration "prefer-hardware" at every H.264
 * profile and level. Both remain so with --enable-features=AcceleratedVideoEncoder and --ignore-gpu-blocklist set, and with chrome://gpu reporting
 * `video_encode: enabled` - that status reflects a capability the browser advertises but does not hand to any web-facing encoder. During a live capture the
 * hardware video engine sits at 0.00% utilization with the GPU in its deepest sleep state, so no browser-side configuration recovers it.
 *
 * Encoding therefore has to happen outside Chrome. This backend grabs the X display and encodes it with FFmpeg's VAAPI encoder, which reaches the same silicon
 * the browser declines to use: the identical 720p60 workload measures ~49% CPU and 19-24% of the hardware video engine.
 *
 * Two properties of this approach shape everything below, and both are why it is opt-in rather than the default.
 *
 * It captures a DISPLAY, not a tab. The whole screen is grabbed rather than a rectangle derived from the window, because a capture page's emulated surface and its
 * on-screen window are independent - Chrome renders the page at the emulated viewport whatever size the window happens to be - so a rectangle composed from the
 * window's origin and the surface's dimensions describes no real region and is rejected outright once it crosses a screen edge. What is on screen instead is
 * arranged to be the page and nothing else: presentCaptureDisplay puts the window full screen and brings the capture page to the front of it before the grab
 * starts, and the window-visibility policy keeps it there for the length of the stream. So the display is what gets grabbed, and the deployment requirement is
 * that the browser owns it - a display sized to the capture surface, with nothing else contending for the screen, screen blanking off, and no second window that
 * can stack above the capture.
 *
 * It admits one capture at a time. PrismCast shows one tab at a time in a shared window, so a second simultaneous grab would record the first one's video. Config
 * validation pins maxConcurrentStreams to 1 whenever this backend is selected rather than letting that failure happen silently at the second tune.
 */

// The pixel format conversion runs on the CPU because the iHD driver on Gen9.5 exposes no VAEntrypointVideoProc, so scale_vaapi cannot do it on the GPU. The i965
// driver does expose it, but its H.264 encoder aborts on this hardware (intel_enc_hw_context_init assertion), so iHD with a CPU-side convert is the combination
// that actually runs.
export const VAAPI_PIXEL_FORMAT = "format=nv12,hwupload";

// Rate control mode. The iHD driver exposes only VAEntrypointEncSliceLP for H.264 on Gen9.5, whose sole supported mode is CQP; asking for a bitrate-targeted mode
// fails the encoder open with "Driver does not support any RC mode compatible with selected options".
export const VAAPI_RC_MODE = "CQP";

// How long a stopping capture is given to finalize its container before it is killed outright. FFmpeg writes the Matroska cues and flushes its muxer on SIGINT, so
// the grace period buys a well-formed tail rather than a truncated one.
export const VAAPI_STOP_GRACE_MS = 2000;

/**
 * Renders the x11grab input specifier for a display.
 *
 * x11grab addresses a screen rather than a display, so a bare ":0" is not a valid input where ":0.0" is - and DISPLAY is very often set to the bare form. A value
 * that already names a screen is left alone; one that does not gets the default screen appended. The grab starts at the origin and, with no size given, covers the
 * whole screen, which is the region the full-screened browser occupies on a display it owns.
 * @param display - The X display, in DISPLAY form (e.g. ":0", ":0.0", "host:1.0").
 * @returns The input specifier, e.g. ":0.0+0,0".
 */
export function toX11GrabInput(display: string): string {

  const colon = display.lastIndexOf(":");
  const namesScreen = (colon !== -1) && display.slice(colon).includes(".");

  return (namesScreen ? display : (display + ".0")) + "+0,0";
}

/**
 * Builds the FFmpeg argument vector for one capture. Exported and pure so the argument construction can be asserted without an X server, a GPU, or a browser -
 * the three things that make this backend otherwise untestable in CI.
 * @param options - The capture request, supplying the surface dimensions, the frame rate band, and the audio bitrate.
 * @param display - The X display to grab from, in DISPLAY form (e.g. ":0").
 * @returns The argument vector, excluding the binary itself.
 */
export function buildVaapiCaptureArgs(options: CaptureStreamOptions, display: string): string[] {

  // The grab runs at the constraint band's ceiling. The floor is the encoder's business, not the grabber's: x11grab emits frames at a fixed cadence, so a floor
  // below the ceiling would only mean discarding frames that were already captured and paid for.
  const frameRate = options.videoConstraints.mandatory.maxFrameRate;

  /* A keyframe every two seconds. The HLS segmenter downstream cuts on keyframes, so the interval bounds how finely it can cut and therefore how quickly a newly
   * tuning client can join. Two seconds matches what the browser's own encoder was producing, which keeps segment durations unchanged across a backend switch.
   */
  const keyframeInterval = frameRate * 2;

  /* The scale holds the output to the configured surface whatever the display measures, so a display sized differently from the quality preset still produces the
   * resolution every consumer downstream expects. On a display sized to the preset - the documented deployment - the scale is an identity and costs nothing. It
   * runs on the CPU for the same reason the format conversion does: this driver offers no VPP entrypoint to run it on the GPU.
   */
  const { maxHeight, maxWidth } = options.videoConstraints.mandatory;
  const args = [

    "-hide_banner", "-loglevel", "error",
    "-vaapi_device", CONFIG.streaming.vaapiDevice,
    "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(frameRate),
    "-i", toX11GrabInput(display)
  ];

  // The audio source is the PulseAudio device carrying the browser's output. On a display the browser owns that is the whole of what the machine is playing, which
  // is exactly the capture's audio - the same single-capture assumption the concurrency ceiling already enforces.
  if(options.audio) {

    args.push("-f", "pulse", "-i", CONFIG.streaming.vaapiAudioSource);
  }

  args.push("-vf", "scale=" + String(maxWidth) + ":" + String(maxHeight) + "," + VAAPI_PIXEL_FORMAT,
    "-c:v", "h264_vaapi", "-rc_mode", VAAPI_RC_MODE, "-qp", String(CONFIG.streaming.vaapiQp), "-g", String(keyframeInterval));

  if(options.audio) {

    args.push("-c:a", "libopus", "-b:a", String(options.audioBitsPerSecond ?? CONFIG.streaming.audioBitsPerSecond));
  }

  // Matroska with H.264 and Opus, which is byte-for-byte the container shape the extension backend produces, so the remux downstream needs no branch of its own.
  args.push("-f", "matroska", "-flush_packets", "1", "pipe:1");

  return args;
}

/**
 * Presents a page as the display's whole content, which is the precondition every frame of this backend's output depends on.
 *
 * Two things have to be true, and neither is true of the window PrismCast keeps for tab capture. The window has to be full screen, or the grab returns a page
 * shrunken into the profile's persisted placement with a tab strip above it and desktop around it. And the page has to be the front tab of a raised window, which
 * is what activation buys: a fullscreen window the desktop stacks below its other windows returns those windows in the frames, and - measured on this hardware -
 * a capture page that is not the visible tab never reaches a playable video at all, because the page is hidden and a provider's player will not start against a
 * hidden document. Both were observed as distinct failures of the same tune: black frames from a fullscreen window nothing had raised, and a video that stayed at
 * readyState 0 for the whole eleven-second wait until the tab was brought forward.
 *
 * Activation is this backend's own business rather than the window-visibility executor's, because it is the page that gets activated and only the caller holding
 * the capture page knows which page that is. The executor resolves whatever page it can reach for its CDP session, which is routinely another one.
 *
 * Neither step is allowed to fail the capture. A grab against a badly presented display is a bad stream where a thrown error is no stream, and both primitives
 * report their own faults.
 * @param page - The capture page, which becomes the front tab of the full screen window.
 * @param clock - Clock driving the full screen confirmation. Defaults to realClock; tests inject a fake.
 */
export async function presentCaptureDisplay(page: Page, clock: Clock = realClock): Promise<void> {

  await fullscreenWindow(page, clock);

  /* Raises the window and selects this tab within it. Puppeteer's activation is Page.bringToFront, which is the page-level command the tab-selection executor
   * cannot express: that executor hands the selection back when its body ends, and this selection has to outlive the acquisition and hold for the stream.
   */
  try {

    await page.bringToFront();
  } catch(error) {

    LOG.warn("VAAPI capture could not bring the capture page to the front; the grab will record whatever the display shows instead: %s.", formatError(error));
  }
}

/**
 * Wires the paths that end a capture nobody called stop() on.
 *
 * An owner retires a capture by destroying the stream and waiting for its stopped promise - that is the contract every caller holds, and the only one they hold.
 * A PassThrough on its own answers neither half: destroying it severs the pipe without telling the child anything, and the child then blocks forever writing to a
 * pipe with no reader, so the stopped promise it was supposed to settle never does. Every capture retired that way leaks an FFmpeg holding the display and the
 * audio source, and the audio server runs out of client slots long before the machine runs out of anything else - at which point every subsequent tune fails at
 * its audio input, on channels that have nothing to do with whatever leaked.
 *
 * A page that closes is the same retirement arriving from the other side: a capture whose page is gone has nothing left to grab.
 * @param stream - The capture stream handed to the owner. Its close is the owner's retirement signal.
 * @param page - The page being captured. Its close retires the capture too.
 * @param stop - The capture's own stop, which is idempotent and does the actual ending.
 */
export function attachCaptureRetirement(stream: PassThrough, page: Pick<Page, "once">, stop: () => Promise<void>): void {

  page.once("close", () => { void stop(); });
  stream.once("close", () => { void stop(); });
}

/**
 * Acquires a hardware-encoded screen capture for a page: an FFmpeg child grabbing the X display the browser is full-screened on and encoding it on the GPU, its
 * Matroska output arriving as a readable stream, and the two controls that end it.
 *
 * The returned stream satisfies the same contract acquireCaptureStream returns, so a caller holding one cannot tell which backend produced it.
 * @param page - The page being captured. Unused beyond its identity: this backend grabs the display the page is presented on rather than the page itself.
 * @param options - What the capture is asked for.
 * @param context - The clock and the caller's abort signal. Defaults to the real clock with no signal.
 * @returns The started capture.
 * @throws When FFmpeg cannot be resolved or the caller abandoned the acquisition.
 */
export async function acquireVaapiCaptureStream(page: Page, options: CaptureStreamOptions,
  context: AcquireCaptureStreamContext = {}): Promise<CaptureStream> {

  const { clock = realClock, signal } = context;
  const acquisitionElapsed = startTimer(clock);

  /* The grab and the remux can need different binaries. Channels DVR bundles an FFmpeg carrying h264_vaapi but no x11grab, and that build is the one the resolver
   * prefers on Linux, so a system with Channels DVR installed resolves an FFmpeg that can encode this capture but cannot grab it. The override names a fuller
   * binary for this backend alone, leaving the remux on whatever the resolver chose.
   */
  const ffmpegBin = CONFIG.streaming.vaapiFfmpegPath.length ? CONFIG.streaming.vaapiFfmpegPath : await resolveFFmpegPath();

  if(!ffmpegBin) {

    throw new Error(CAPTURE_SOURCE_UNAVAILABLE_MESSAGE);
  }

  const display = process.env["DISPLAY"] ?? ":0";

  /* The grab reads the display, so the page's presentation on it is the capture. Left alone, the window wears the placement Chrome persisted for the profile -
   * small, offset, and framed by a tab strip and toolbar - and the grab returns a shrunken page surrounded by desktop. Full screen presents the page at the
   * screen's dimensions with no chrome around it, which on a display sized to the capture surface is the pixel-for-pixel read this backend is for.
   *
   * A window that will not confirm is not a reason to abandon the capture: a badly presented stream is still a stream, and the warning the presentation logs
   * names the fault where a stream failure would not.
   */
  await presentCaptureDisplay(page, clock);

  const args = buildVaapiCaptureArgs(options, display);
  const stream = new PassThrough();
  const stopped = Promise.withResolvers<undefined>();

  let graceTimer: Nullable<NodeJS.Timeout> = null;
  let stopRequested = false;

  /* Settles the capture exactly once, whatever ended it: a clean exit, a crash, or a stop we asked for. The stopped promise never rejects - a caller bounds it
   * rather than catching it - so a failure exit is reported through the log and the stream's end, not through this promise.
   */
  const settle = (): void => {

    if(graceTimer) {

      clearTimeout(graceTimer);
      graceTimer = null;
    }

    // An owner retires a capture by destroying the stream, so the destroyed case is the ordinary one rather than the exception: ending a destroyed writable raises
    // ERR_STREAM_DESTROYED on a stream whose consumer is by then gone, where the error has nowhere to go but an unhandled event.
    if(!stream.destroyed) {

      stream.end();
    }

    stopped.resolve(undefined);
  };

  const child: ChildProcess = spawn(ffmpegBin, args, { stdio: [ "ignore", "pipe", "pipe" ] });

  child.stdout?.pipe(stream);

  // FFmpeg reports encoder and grabber faults on stderr. They are logged rather than thrown because the capture may well continue - a dropped frame warning is not
  // a dead stream - and the stall monitor downstream is what decides whether output has actually stopped.
  child.stderr?.on("data", (chunk: Buffer) => {

    const message = chunk.toString().trim();

    if(message.length) {

      LOG.warn("VAAPI capture: %s.", message);
    }
  });

  child.on("error", (error: Error) => {

    LOG.error("VAAPI capture failed to start: %s.", formatError(error));
    settle();
  });

  child.on("close", (code: Nullable<number>) => {

    if(!stopRequested && (code !== 0)) {

      LOG.error("VAAPI capture exited unexpectedly with code %s.", String(code));
    }

    settle();
  });

  /**
   * Asks the capture to end. Safe to call more than once: the signal goes out once and every call resolves to the same stopped promise.
   * @returns A promise resolving once the capture has genuinely finished.
   */
  const stop = async (): Promise<void> => {

    if(!stopRequested) {

      stopRequested = true;

      // SIGINT, not SIGTERM: FFmpeg treats SIGINT as "finish the file", flushing its muxer and writing the Matroska cues, where SIGTERM ends it where it stands.
      child.kill("SIGINT");

      /* A signal only reaches a process that can act on it. When the stop came from a destroyed stream the pipe lost its reader, and FFmpeg is blocked writing to
       * a full one - it takes the signal and blocks again on the very flush the signal asked it to make. Draining what it writes lets that shutdown finish. On a
       * stream still being consumed this changes nothing: the data goes where it was already going.
       */
      child.stdout?.resume();

      graceTimer = setTimeout(() => child.kill("SIGKILL"), VAAPI_STOP_GRACE_MS);
    }

    await stopped.promise;
  };

  /* The owner's retirement and the page's death both have to reach the child, and neither is expressible as a call to stop(): the owner destroys the stream it was
   * handed, and a dying page announces itself. Registered here, after stop() exists, because both paths call it.
   */
  attachCaptureRetirement(stream, page, stop);

  // The caller gave up while the child was starting. Retire it here rather than handing back a capture nobody is waiting for.
  if(signal?.aborted) {

    await stop();

    throw new Error(CAPTURE_SOURCE_UNAVAILABLE_MESSAGE);
  }

  LOG.debug("browser:capture", "VAAPI capture started: %dx%d at %dfps from %s in %ss.", options.videoConstraints.mandatory.maxWidth,
    options.videoConstraints.mandatory.maxHeight, options.videoConstraints.mandatory.maxFrameRate, display, acquisitionElapsed().toFixed(1));

  return Object.assign(stream, { stop, stopped: stopped.promise });
}
