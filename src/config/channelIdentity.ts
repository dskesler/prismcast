/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * channelIdentity.ts: Identity projection for channel definitions.
 */
import type { ChannelIdentity, ResolvedChannel } from "../types/index.ts";
import { CHANNEL_IDENTITY_KEYS } from "../types/index.ts";

/* A channel definition splits into two halves: identity, which describes the channel itself (name, station ID, channel number, tags), and binding, which
 * describes how one particular service delivers it (URL, selectors, profile). The partition is declared in types/channels.ts; this module is its runtime form.
 *
 * It depends on nothing but that partition, so the channel store and the service-group resolver can each project identity without either one depending on the
 * other.
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
