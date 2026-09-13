/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fetch.helpers.test.ts: Unit tests for the Response-shaped test fixtures for bounded fetches.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pendingBodyFetch } from "./fetch.helpers.ts";
import { settle } from "homebridge-plugin-utils/testing";

describe("pendingBodyFetch", () => {

  test("answers a 200 response whose headers are readable before any body work", () => {

    // The whole point of the fixture is the split between headers and body: the Response is built synchronously and reads as a success, so a consumer under
    // test gets past its status branch and into the body read, which is the wait the bound has to still be covering.
    const response = pendingBodyFetch(undefined);

    assert.equal(response.status, 200, "the stub answers 200");
    assert.equal(response.ok, true, "which reads as a successful response");
    assert.equal(response.bodyUsed, false, "with its body untouched and still open");
  });

  test("rejects a pending body read with the request signal's own reason object", async () => {

    // Identity rather than message is the contract that matters. A consumer that carries its own error as its bound's abort reason tells its lapse apart from
    // every other failure by reference, and this fixture is what lets a row exercise that comparison, so the object has to arrive unwrapped.
    const controller = new AbortController();
    const reason = new Error("the caller's own lapse");
    const response = pendingBodyFetch({ signal: controller.signal });
    const read = response.arrayBuffer();

    controller.abort(reason);

    await assert.rejects(read, (error: unknown): boolean => error === reason);
  });

  test("leaves the body read pending when the request carries no signal", async () => {

    // The negative half: nothing but the signal ends the read. A fixture whose body closed on its own would let a consumer that cancelled its bound too early
    // pass anyway, which is exactly the defect the rows built on this are meant to catch.
    const response = pendingBodyFetch(undefined);

    let outcome = "pending";

    void response.arrayBuffer().then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });

    await settle();

    assert.equal(outcome, "pending", "a body with nothing to end it stays open");
  });
});
