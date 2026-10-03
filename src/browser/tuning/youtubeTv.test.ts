/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * youtubeTv.test.ts: Unit tests for the YouTube TV provider module. The EPG grid is not virtualized, so the strategy reads the entire lineup in one evaluate
 * round-trip - which is what makes the whole provider drivable from a page stub that hands back a canned guide read, with no browser and no DOM behind it.
 *
 * The describes split by behavior surface rather than by export: the module exports a single provider object, so a per-export organization would collapse into
 * one undifferentiated block. The tune flow, the discovery path, and the channel-cache lifecycle each get their own.
 *
 * The lifecycle block carries the assertion that matters most. Every guide read is complete, so the cache mirrors the read it was built from rather than accumulating
 * every lineup a browser session has ever seen: a channel dropped from the lineup has to be gone from discovery output after the next read. The tiered lookup's
 * alias keys are collateral of that replacement, which is why the affiliate resolve is asserted on both sides of a repopulation - the eviction has to stay
 * invisible to callers.
 */
import type { ChannelSelectionProfile, DiscoveredChannel, Nullable } from "../../types/index.ts";
import { afterEach, describe, test } from "node:test";
import { selectGuideChannels, yttvProvider } from "./youtubeTv.ts";
import type { Page } from "puppeteer-core";
import assert from "node:assert/strict";
import { makeProfile } from "../../config/profiles.helpers.ts";

// One raw guide row as the strategy reads it out of the EPG grid: the name carried in the thumbnail's aria-label, and the relative watch path from its anchor.
interface GuideRow {

  readonly name: string;
  readonly watchPath: string;
}

interface GuidePage {

  // Every URL the strategy navigated to, in order.
  readonly navigations: string[];

  // The Page-shaped stub to hand the provider.
  readonly page: Page;

  // How many times the guide grid was read through page.evaluate, which is what distinguishes a cache hit from a fresh walk.
  readonly reads: () => number;

  // Swaps the lineup the next guide read returns, standing in for a channel joining or leaving between two tunes.
  readonly setLineup: (rows: GuideRow[]) => void;
}

/* makeGuidePage returns a Page-shaped stub carrying the three surfaces the provider touches - the grid wait, the evaluate that reads the lineup, and the
 * navigation to a watch URL - plus a record of what it did with them. evaluateWithAbort only ever calls .evaluate() on the context it is handed, so a stub whose
 * evaluate ignores the page function and returns the canned lineup as guide tiles is a faithful stand-in for the whole read.
 */
function makeGuidePage(rows: GuideRow[] = []): GuidePage {

  const navigations: string[] = [];

  let lineup = rows;
  let reads = 0;

  const page = {

    // The page hands back raw tiles; the rows are rendered as the plain watch tiles a guide shows for them.
    evaluate: async (): Promise<{ href: string; joinLive: null; label: string }[]> => {

      reads++;

      await Promise.resolve();

      return lineup.map((row) => ({ href: row.watchPath, joinLive: null, label: "watch " + row.name }));
    },
    goto: async (url: string): Promise<null> => {

      navigations.push(url);

      await Promise.resolve();

      return null;
    },
    waitForSelector: async (): Promise<null> => {

      await Promise.resolve();

      return null;
    }
  } as unknown as Page;

  return {

    navigations,
    page,
    reads: (): number => reads,
    setLineup: (next: GuideRow[]): void => {

      lineup = next;
    }
  };
}

// makeYttvProfile narrows a neutral profile to what the strategy requires: the YouTube TV selection strategy and a non-null channel selector.
function makeYttvProfile(channelSelector: string): ChannelSelectionProfile {

  return makeProfile({ channelSelection: { strategy: "youtubeGrid" }, channelSelector }) as ChannelSelectionProfile;
}

// namesOf projects a discovery result down to the names it reports, which is the shape every lineup assertion below compares against.
function namesOf(channels: Nullable<DiscoveredChannel[]>): string[] {

  return (channels ?? []).map((channel) => channel.name);
}

// A guide read carrying two plainly-named channels and one local affiliate in the "{Network} {Number}" shape that the prefix-plus-digit lookup tier matches.
const FULL_LINEUP: GuideRow[] = [
  { name: "Alpha Channel", watchPath: "watch/alpha" },
  { name: "Beta Channel", watchPath: "watch/beta" },
  { name: "NBC 5", watchPath: "watch/nbc5" }
];

// The same guide read with one channel gone, standing in for a lineup that changed between two tunes.
const TRIMMED_LINEUP: GuideRow[] = [
  { name: "Alpha Channel", watchPath: "watch/alpha" },
  { name: "NBC 5", watchPath: "watch/nbc5" }
];

afterEach(() => {

  // The channel cache and the empty-discovery counter are module state, so every test has to start from the cleared state a browser restart produces.
  yttvProvider.strategy.clearCache?.();
});

describe("youtubeGrid tune flow", () => {

  test("reads the guide in one pass, resolves the target channel, and navigates to its watch URL", async () => {

    const guide = makeGuidePage(FULL_LINEUP);

    const result = await yttvProvider.strategy.execute(guide.page, makeYttvProfile("Alpha Channel"));

    assert.equal(result.success, true, "a channel present in the guide tunes successfully");
    assert.deepEqual(guide.navigations, ["https://tv.youtube.com/watch/alpha"], "the strategy navigates to the matched channel's full watch URL");
    assert.equal(guide.reads(), 1, "the entire lineup is read in a single evaluate round-trip");
  });

  test("reports the empty-guide failure distinctly from a channel-name mismatch", async () => {

    // A degraded guide renders its grid container without any channel entries. That failure has to read differently from "your channel name is wrong", because
    // the two send the user to completely different places.
    const guide = makeGuidePage([]);

    const result = await yttvProvider.strategy.execute(guide.page, makeYttvProfile("Alpha Channel"));

    assert.equal(result.success, false, "a guide that yields no channels fails the tune");
    assert.match(result.reason ?? "", /guide is empty/, "the reason names the empty guide rather than a missing channel");
    assert.deepEqual(guide.navigations, [], "nothing is navigated to when there is no channel to tune");
  });
});

describe("durable lineup export", () => {

  test("reports nothing while the cache is cold", () => {

    // The store must never be handed an empty lineup as though it were a statement about the provider, and a browser session that has walked no guide has nothing
    // to state. Null is what the recorder reads as "this provider contributed nothing", which is distinct from "this provider has no channels".
    assert.equal(yttvProvider.exportDurableLineup?.(), null, "a cold cache exports nothing");
  });

  test("exports one row per channel with its watch URL, however many alias keys point at it", async () => {

    /* The tiered lookup files an entry under the caller's own spelling when a non-exact tier matches, so tuning to "NBC" leaves two keys pointing at the single
     * "NBC 5" entry object. Projecting the map's values without reducing them to distinct entries would persist that channel twice, and the duplicate would then
     * carry into the channel-form suggestion list and every later boot's fallback.
     */
    const guide = makeGuidePage(FULL_LINEUP);

    await yttvProvider.strategy.execute(guide.page, makeYttvProfile("NBC"));

    assert.deepEqual(guide.navigations, ["https://tv.youtube.com/watch/nbc5"], "the affiliate resolved through a non-exact tier, which is what writes the alias");

    assert.deepEqual(yttvProvider.exportDurableLineup?.(), [

      { channelSelector: "Alpha Channel", name: "Alpha Channel", watchUrl: "https://tv.youtube.com/watch/alpha" },
      { channelSelector: "Beta Channel", name: "Beta Channel", watchUrl: "https://tv.youtube.com/watch/beta" },
      { channelSelector: "NBC", name: "NBC 5", watchUrl: "https://tv.youtube.com/watch/nbc5" }
    ], "each channel is exported once, keyed by the selector a channel record would carry and holding the watch URL that survives a browser session");
  });
});

describe("channel discovery", () => {

  test("populates the cache from the guide and returns the full lineup on the first call", async () => {

    const guide = makeGuidePage(FULL_LINEUP);

    const discovered = await yttvProvider.discoverChannels(guide.page);

    assert.deepEqual(namesOf(discovered), [ "Alpha Channel", "Beta Channel", "NBC 5" ], "every guide row is discovered, sorted by name");
    assert.equal(discovered.find((channel) => channel.name === "NBC 5")?.affiliate, "NBC", "a local affiliate is tagged with the network it belongs to");
  });

  test("serves the cached lineup on later calls without re-reading the guide", async () => {

    const guide = makeGuidePage(FULL_LINEUP);

    await yttvProvider.discoverChannels(guide.page);

    const second = await yttvProvider.discoverChannels(guide.page);

    assert.equal(guide.reads(), 1, "the second discovery call is served from the cache rather than walking the grid again");
    assert.deepEqual(namesOf(second), [ "Alpha Channel", "Beta Channel", "NBC 5" ], "the cached result carries the same lineup the walk produced");
  });
});

describe("channel cache lifecycle", () => {

  test("drops a channel that has left the lineup on the next guide read", async () => {

    const guide = makeGuidePage(FULL_LINEUP);

    await yttvProvider.strategy.execute(guide.page, makeYttvProfile("Alpha Channel"));

    assert.deepEqual(namesOf(yttvProvider.getCachedChannels()), [ "Alpha Channel", "Beta Channel", "NBC 5" ],
      "the first guide read caches every channel it saw");

    guide.setLineup(TRIMMED_LINEUP);

    await yttvProvider.strategy.execute(guide.page, makeYttvProfile("Alpha Channel"));

    assert.deepEqual(namesOf(yttvProvider.getCachedChannels()), [ "Alpha Channel", "NBC 5" ],
      "a channel absent from the latest guide read is absent from the discovery output that read produced");
  });

  test("still resolves an affiliate through its network name after a repopulation evicts the alias key", async () => {

    // The tiered lookup writes an alias key so the second resolve is a plain map hit. A repopulation discards that alias along with everything else, so the
    // guarantee callers actually depend on is that the tiers re-derive it - not that the alias survives.
    const guide = makeGuidePage(FULL_LINEUP);

    await yttvProvider.strategy.execute(guide.page, makeYttvProfile("Alpha Channel"));

    const before = await yttvProvider.strategy.resolveDirectUrl?.("NBC", guide.page);

    assert.equal(before, "https://tv.youtube.com/watch/nbc5", "the prefix-plus-digit tier resolves a network name to its local affiliate");

    guide.setLineup(TRIMMED_LINEUP);

    await yttvProvider.strategy.execute(guide.page, makeYttvProfile("Alpha Channel"));

    const after = await yttvProvider.strategy.resolveDirectUrl?.("NBC", guide.page);

    assert.equal(after, "https://tv.youtube.com/watch/nbc5", "the eviction is invisible to callers because the lookup re-derives the alias on the next resolve");
  });

  test("collapses an alias key onto the entry it points at so discovery reports one row per channel", async () => {

    const guide = makeGuidePage(FULL_LINEUP);

    await yttvProvider.discoverChannels(guide.page);
    await yttvProvider.strategy.resolveDirectUrl?.("NBC", guide.page);

    const discovered = yttvProvider.getCachedChannels() ?? [];

    assert.equal(discovered.filter((channel) => channel.name === "NBC 5").length, 1, "the alias key the lookup wrote does not add a second row for one channel");
    assert.equal(discovered.length, 3, "the reported lineup is exactly the channels the guide carried");
  });

  test("reports nothing cached once the browser-restart sweep clears the cache", async () => {

    const guide = makeGuidePage(FULL_LINEUP);

    await yttvProvider.discoverChannels(guide.page);

    assert.ok(yttvProvider.getCachedChannels(), "the discovery call leaves a populated cache behind");

    yttvProvider.strategy.clearCache?.();

    assert.equal(yttvProvider.getCachedChannels(), null, "a cleared cache reports that no enumeration has happened rather than an empty lineup");
  });
});

describe("guide tile selection", () => {

  // A guide read taken from YouTube TV during College GameDay, trimmed to the tiles that matter: the network rows, then the ESPN events listed further down
  // under the network's own name.
  const tile = (label: string, href: string, joinLive: Nullable<{ params: string; videoId: string }> = null): { href: string; joinLive: typeof joinLive;
    label: string; } => ({ href, joinLive, label });

  test("resolves a restartable program's tile through its Join live endpoint", () => {

    const channels = selectGuideChannels([tile("watch ESPN", "live", { params: "0gEEEgIwAQ%3D%3D", videoId: "PFuNFGzJDE4" })]);

    assert.deepEqual(channels, [{ name: "ESPN", watchPath: "watch/PFuNFGzJDE4?vp=0gEEEgIwAQ%3D%3D" }]);
  });

  test("the network's own row owns its name, so events listed under that name never replace it", () => {

    const channels = selectGuideChannels([
      tile("watch ESPN", "live", { params: "0gEEEgIwAQ%3D%3D", videoId: "PFuNFGzJDE4" }),
      tile("watch ESPN2", "watch/nIaQPNyNo34?vp=0gEEEgIwAQ%3D%3D"),
      tile("watch ESPN", "watch/8gnK8oOnS-4?vp=0gEEEgIwAQ%3D%3D"),
      tile("watch ESPN", "watch/TpDgOIYAwmU?vp=0gEEEgIwAQ%3D%3D"),
      tile("watch ESPN", "browse/UCakwQ1jKQnYJcUMghvnp-Yw")
    ]);

    assert.deepEqual(channels, [
      { name: "ESPN", watchPath: "watch/PFuNFGzJDE4?vp=0gEEEgIwAQ%3D%3D" },
      { name: "ESPN2", watchPath: "watch/nIaQPNyNo34?vp=0gEEEgIwAQ%3D%3D" }
    ]);
  });

  test("a network row that cannot be resolved still keeps its events from claiming the name", () => {

    // A failed tune is something a DVR can fall back from. One of the network's events delivered as the network is not.
    const channels = selectGuideChannels([ tile("watch ESPN", "live"), tile("watch ESPN", "watch/8gnK8oOnS-4?vp=0gEEEgIwAQ%3D%3D") ]);

    assert.deepEqual(channels, []);
  });

  test("ignores info pages, premium add-ons, and tiles that are not watch endpoints", () => {

    const channels = selectGuideChannels([ tile("watch Showtime", "live"), tile("watch Hallmark", "browse/UC123"), tile("info", "watch/x"),
      tile("watch CNN", "watch/cnn") ]);

    assert.deepEqual(channels, [{ name: "CNN", watchPath: "watch/cnn" }]);
  });

  test("names are claimed case-insensitively, matching the cache's keys", () => {

    assert.deepEqual(selectGuideChannels([ tile("watch ESPNews", "watch/a"), tile("watch ESPNEWS", "watch/b") ]), [{ name: "ESPNews", watchPath: "watch/a" }]);
  });
});
