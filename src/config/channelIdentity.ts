/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * channelIdentity.ts: Identity and binding projections for channel definitions.
 */
import { CHANNEL_BINDING_KEYS, CHANNEL_IDENTITY_KEYS } from "../types/index.ts";
import type { ChannelDelta, ChannelIdentity, ResolvedChannel } from "../types/index.ts";

/* A channel definition splits into two halves: identity, which describes the channel itself (name, station ID, channel number, tags), and binding, which
 * describes how one particular service delivers it (URL, selectors, profile). The partition is declared in types/channels.ts; this module is its runtime form.
 *
 * It depends on nothing but that partition, so the channel store, the service-group resolver, and the channel write endpoints can each project either half
 * without one of them depending on another.
 */

/**
 * Extracts the identity-only subset of a channel. Used by resolveVariant and normalizeChannelDeltas to compute the inheritance base for variants: a variant
 * inherits identity from its canonical but must contribute its own service binding (URL, channelSelector, profile, etc.) - the canonical's binding is for the
 * canonical service and is structurally wrong for any other service.
 *
 * The fields copied are exactly those listed in CHANNEL_IDENTITY_KEYS, the single source of truth for the identity partition. Array-valued fields are shallow-
 * copied so downstream mutation cannot leak back into the source.
 * @param channel - The channel to extract identity from. Typed as ResolvedChannel because that is the shape after canonical resolution; CanonicalChannel is
 *   structurally compatible.
 * @returns A new ChannelIdentity object with just the identity fields populated.
 */
export function pickIdentity(channel: ResolvedChannel): ChannelIdentity {

  const identity: ChannelIdentity = {};

  for(const field of CHANNEL_IDENTITY_KEYS) {

    const value = channel[field];

    if(value === undefined) {

      continue;
    }

    (identity as Record<string, unknown>)[field] = value;
  }

  identity.tags &&= identity.tags.slice();

  return identity;
}

/* Module-private partition Sets, derived once from the type-system source of truth. The Sets back the public picker functions below; callers never reference
 * the Sets directly. Adding or renaming a field in CHANNEL_IDENTITY_KEYS / CHANNEL_BINDING_KEYS automatically updates both Sets at runtime - the partition
 * lives in types/channels.ts and these are the single derived runtime form.
 */
const IDENTITY_FIELDS: ReadonlySet<string> = new Set(CHANNEL_IDENTITY_KEYS);
const BINDING_FIELDS: ReadonlySet<string> = new Set(CHANNEL_BINDING_KEYS);

/**
 * Internal: filters a delta to fields in the supplied allowlist. Backs pickIdentityFields and pickBindingFields. Not exported - the public surface is the
 * named pickers, which hide the partition Sets so consumers never have to know how the partition is enumerated.
 */
function filterDeltaFields(delta: ChannelDelta, allowlist: ReadonlySet<string>): ChannelDelta {

  const filtered: Record<string, unknown> = {};

  for(const [ field, value ] of Object.entries(delta)) {

    if(allowlist.has(field)) {

      filtered[field] = value;
    }
  }

  return filtered;
}

/**
 * Returns the identity-only subset of a ChannelDelta - the fields enumerated by CHANNEL_IDENTITY_KEYS. Used by the per-field write router (PUT handler) and
 * the storage normalizer's heal path to split a full delta into identity-only and binding-only halves so each half is routed to the correct stored entry.
 * @param delta - The delta to project.
 * @returns A new delta with only identity fields retained.
 */
export function pickIdentityFields(delta: ChannelDelta): ChannelDelta {

  return filterDeltaFields(delta, IDENTITY_FIELDS);
}

/**
 * Returns the binding-only subset of a ChannelDelta - the fields enumerated by CHANNEL_BINDING_KEYS. Peer to pickIdentityFields; together they cover the
 * delta surface and partition it cleanly.
 * @param delta - The delta to project.
 * @returns A new delta with only binding fields retained.
 */
export function pickBindingFields(delta: ChannelDelta): ChannelDelta {

  return filterDeltaFields(delta, BINDING_FIELDS);
}
