/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * page.helpers.ts: A general Puppeteer Page double for tests that drive page-shaped production code without a browser.
 */
import type { HTTPResponse, Page } from "puppeteer-core";
import type { Clock } from "homebridge-plugin-utils";
import type { Nullable } from "../types/index.ts";
import { systemClock } from "homebridge-plugin-utils";

/* This is the general Page surface double: a stand-in for the handful of Page members that page-driving production code touches, with every asynchronous member
 * held open so the test decides when - and whether - it answers. Holding a call open is the point. A test that needs to observe what happens while an evaluate
 * is outstanding, or while a navigation is in flight, cannot get there with a double that answers immediately.
 *
 * The CDP-shaped double in cdp.helpers.ts is a separate thing: it stands in for a Page as the entry to a CDP session, where this one stands in for a Page as a
 * document to read and navigate.
 */

/**
 * One call the double received, held open for the test to settle. The timestamp is read at issue time, so a test driving a clock can assert when production code
 * chose to make the call.
 */
export interface PendingPageCall<T> {

  // The arguments the call was issued with, in order. A test reads these to assert what production code asked for - the URL of a navigation, the selector of a
  // wait - rather than only how many calls it made.
  readonly args: readonly unknown[];

  // The double's clock reading when the call was issued.
  readonly at: number;

  // Rejects the call with the supplied error.
  readonly reject: (error: unknown) => void;

  // Resolves the call with the supplied value.
  readonly resolve: (value: T) => void;
}

/**
 * Construction options for the Page double. Every handler receives the call as it is issued, along with its zero-based index in that member's call list; a
 * handler that settles the call decides the answer, and one that leaves it alone leaves the call pending for the test to settle later.
 */
export interface FakePageOptions {

  // The clock each call's issue timestamp is read from. A test driving production code on a virtual clock passes that clock, so the stamps it reads back sit on
  // the same timeline as the code it is driving. Defaults to the system clock.
  clock?: Clock;

  // What frames() reports. Defaults to an empty list.
  frames?: readonly unknown[];

  // Answers a $eval call as it is issued.
  onElementEvaluate?: (call: PendingPageCall<unknown>, index: number) => void;

  // Answers an evaluate call as it is issued.
  onEvaluate?: (call: PendingPageCall<unknown>, index: number) => void;

  // Answers a goto call as it is issued. Puppeteer's own goto resolves with a response or null, and the double mirrors that.
  onGoto?: (call: PendingPageCall<Nullable<HTTPResponse>>, index: number) => void;

  // Answers a mouse.click call as it is issued. Puppeteer's own mouse.click resolves with nothing, and the double mirrors that.
  onMouseClick?: (call: PendingPageCall<undefined>, index: number) => void;

  // Answers a reload call as it is issued.
  onReload?: (call: PendingPageCall<Nullable<HTTPResponse>>, index: number) => void;

  // Answers a waitForFrame call as it is issued.
  onWaitForFrame?: (call: PendingPageCall<unknown>, index: number) => void;

  // Answers a waitForFunction call as it is issued.
  onWaitForFunction?: (call: PendingPageCall<unknown>, index: number) => void;

  // Answers a waitForSelector call as it is issued.
  onWaitForSelector?: (call: PendingPageCall<unknown>, index: number) => void;

  // What browser().pages() resolves with. Defaults to an empty list.
  pages?: readonly unknown[];

  // What url() reports initially. Defaults to a placeholder test URL.
  url?: string;
}

/**
 * The double plus the handles a test drives it with.
 */
export interface FakePage {

  // Every $eval call received, in issue order.
  readonly elementEvaluations: PendingPageCall<unknown>[];

  // Every evaluate call received, in issue order.
  readonly evaluations: PendingPageCall<unknown>[];

  // Every waitForFrame call received, in issue order.
  readonly frameWaits: PendingPageCall<unknown>[];

  // Every waitForFunction call received, in issue order.
  readonly functionWaits: PendingPageCall<unknown>[];

  // Every event listener registered through on(), in registration order. Registration is synchronous, so these are recorded rather than held open.
  readonly listeners: { event: string; listener: (...args: unknown[]) => void }[];

  // Every mouse.click call received, in issue order, each carrying the coordinates it was issued with.
  readonly mouseClicks: PendingPageCall<undefined>[];

  // Every goto call received, in issue order.
  readonly navigations: PendingPageCall<Nullable<HTTPResponse>>[];

  // The Page-shaped double to hand to the code under test.
  readonly page: Page;

  // Every reload call received, in issue order.
  readonly reloads: PendingPageCall<Nullable<HTTPResponse>>[];

  // Every waitForSelector call received, in issue order.
  readonly selectorWaits: PendingPageCall<unknown>[];

  // Sets what isClosed() reports from here on.
  readonly setClosed: (closed: boolean) => void;

  // Sets what url() reports from here on.
  readonly setUrl: (url: string) => void;
}

/**
 * Records a call and hands back both the promise the double returns and the handle the test settles it with.
 * @param clock - The clock the issue timestamp is read from.
 * @param args - The arguments the call was issued with, stamped onto the handle for the test to read.
 * @returns The pending-call handle and the promise to hand back to the caller under test.
 */
function openCall<T>(clock: Clock, ...args: unknown[]): { call: PendingPageCall<T>; promise: Promise<T> } {

  const { promise, reject, resolve } = Promise.withResolvers<T>();

  return { call: { args, at: clock.now(), reject, resolve }, promise };
}

/**
 * Builds a document-response double for a test that hands one to onGoto, for code under test that judges a document by what the server answered. The ok() answer
 * follows the HTTP definition of success rather than a caller-supplied flag, so a test states the status alone and the polarity cannot disagree with it.
 * @param status - The HTTP status the document response reports.
 * @returns The response double.
 */
export function makeDocumentResponse(status: number): HTTPResponse {

  return {

    ok: (): boolean => (status >= 200) && (status <= 299),
    status: (): number => status
  } as unknown as HTTPResponse;
}

/**
 * Builds a Page double covering the members page-driving production code reaches for: reading and navigating a document, waiting on the DOM, clicking with the mouse,
 * and registering event listeners. The cast through unknown is the established convention for these doubles: the double implements what the code under test calls and
 * nothing else, so a structural conformance to Puppeteer's full Page interface would be noise rather than safety.
 * @param options - Handlers and initial values for the double's members.
 * @returns The double and the handles for driving it.
 */
export function makeFakePage(options: FakePageOptions = {}): FakePage {

  const clock = options.clock ?? systemClock;
  const elementEvaluations: PendingPageCall<unknown>[] = [];
  const evaluations: PendingPageCall<unknown>[] = [];
  const frameWaits: PendingPageCall<unknown>[] = [];
  const functionWaits: PendingPageCall<unknown>[] = [];
  const listeners: FakePage["listeners"] = [];
  const mouseClicks: PendingPageCall<undefined>[] = [];
  const navigations: PendingPageCall<Nullable<HTTPResponse>>[] = [];
  const reloads: PendingPageCall<Nullable<HTTPResponse>>[] = [];
  const selectorWaits: PendingPageCall<unknown>[] = [];

  let closed = false;
  let currentUrl = options.url ?? "https://page.helpers.test/";

  // One object for the page's life, so a predicate that tests a frame's identity against mainFrame() sees the same frame each time; its url follows setUrl the
  // way Puppeteer's main frame carries the page's URL.
  const mainFrame = { url: (): string => currentUrl };

  const page = {

    $eval: (...args: unknown[]): Promise<unknown> => {

      const { call, promise } = openCall<unknown>(clock, ...args);

      elementEvaluations.push(call);
      options.onElementEvaluate?.(call, elementEvaluations.length - 1);

      return promise;
    },
    browser: (): unknown => ({ pages: async (): Promise<readonly unknown[]> => options.pages ?? [] }),
    evaluate: (...args: unknown[]): Promise<unknown> => {

      const { call, promise } = openCall<unknown>(clock, ...args);

      evaluations.push(call);
      options.onEvaluate?.(call, evaluations.length - 1);

      return promise;
    },
    frames: (): readonly unknown[] => options.frames ?? [],
    goto: (...args: unknown[]): Promise<Nullable<HTTPResponse>> => {

      const { call, promise } = openCall<Nullable<HTTPResponse>>(clock, ...args);

      navigations.push(call);
      options.onGoto?.(call, navigations.length - 1);

      return promise;
    },
    isClosed: (): boolean => closed,
    mainFrame: (): unknown => mainFrame,
    mouse: {

      click: (...args: unknown[]): Promise<undefined> => {

        const { call, promise } = openCall<undefined>(clock, ...args);

        mouseClicks.push(call);
        options.onMouseClick?.(call, mouseClicks.length - 1);

        return promise;
      }
    },

    // Listener registration is synchronous and returns the page, which is what production code chains on, so this member records rather than holding open.
    on: (event: string, listener: (...args: unknown[]) => void): unknown => {

      listeners.push({ event, listener });

      return page;
    },
    reload: (...args: unknown[]): Promise<Nullable<HTTPResponse>> => {

      const { call, promise } = openCall<Nullable<HTTPResponse>>(clock, ...args);

      reloads.push(call);
      options.onReload?.(call, reloads.length - 1);

      return promise;
    },
    url: (): string => currentUrl,
    waitForFrame: (...args: unknown[]): Promise<unknown> => {

      const { call, promise } = openCall<unknown>(clock, ...args);

      frameWaits.push(call);
      options.onWaitForFrame?.(call, frameWaits.length - 1);

      return promise;
    },
    waitForFunction: (...args: unknown[]): Promise<unknown> => {

      const { call, promise } = openCall<unknown>(clock, ...args);

      functionWaits.push(call);
      options.onWaitForFunction?.(call, functionWaits.length - 1);

      return promise;
    },
    waitForSelector: (...args: unknown[]): Promise<unknown> => {

      const { call, promise } = openCall<unknown>(clock, ...args);

      selectorWaits.push(call);
      options.onWaitForSelector?.(call, selectorWaits.length - 1);

      return promise;
    }
  } as unknown as Page;

  return {

    elementEvaluations,
    evaluations,
    frameWaits,
    functionWaits,
    listeners,
    mouseClicks,
    navigations,
    page,
    reloads,
    selectorWaits,
    setClosed: (value: boolean): void => {

      closed = value;
    },
    setUrl: (value: string): void => {

      currentUrl = value;
    }
  };
}
