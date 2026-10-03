/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * channelSort.ts: Channel table sort key extraction and comparison.
 */
import type { ChannelSortField, ResolvedChannel, SortDirection } from "../types/index.ts";
import { getChannelEffectiveTags, getEffectiveHdhrEnabled } from "./userChannels.ts";
import { getChannelServiceLabel, getResolvedChannel, resolveServiceKey } from "./services.ts";
import { getProfileForChannel } from "./profiles.ts";

/* Every surface that orders channels - the server-rendered config table, the client re-sort it feeds, the M3U playlist, and the bulk-selection endpoint - shares
 * the one key extractor and the one comparator below, so no two of them can drift into different orderings.
 *
 * A sort key reads a channel through every layer that can change what the user sees: the selected service variant, the resolved profile, the active tag
 * vocabulary, and the HDHomeRun lineup convention. Composing those layers here keeps the ordering rules in one place instead of splitting them across the
 * modules that own each layer.
 */

// Valid sort field values for the channels table. Exported as the single source of truth for sort field validation, shared by the config POST handler and the
// playlist endpoint's query parameter validation.
export const VALID_SORT_FIELDS = new Set<ChannelSortField>(
  [ "channelNumber", "channelSelector", "hdhrEnabled", "key", "name", "profile", "service", "stationId", "tags" ]
);

/**
 * Extracts a sortable string value from a channel for the specified sort field. Channel numbers are zero-padded to 6 digits for correct numeric ordering within a
 * string comparison. Service values use the display label for human-meaningful sort order. This is the single source of truth for channel sort key extraction,
 * shared by both the server-side table renderer and the M3U playlist generator.
 * @param channel - Fallback channel definition, used only when the selected service variant cannot be resolved (e.g., key not in the merged channel map).
 * @param key - The canonical channel key. Used for key-based sorting and to resolve the selected service variant internally.
 * @param field - The sort field to extract.
 * @returns A lowercase string suitable for comparison-based sorting.
 */
export function getChannelSortKey(channel: ResolvedChannel, key: string, field: ChannelSortField): string {

  // Resolve the selected service variant so all sort keys reflect the user's service selection. For URL-dependent fields (profile, service), this is essential -
  // a canonical's URL may differ from the selected variant's (e.g., bbcnews canonical uses cox but the user selected the directv variant). For identity fields
  // (name, stationId, channelNumber), the flattener eagerly sets these on all entries, so the resolved channel has identical values regardless of variant.
  const effective = getResolvedChannel(resolveServiceKey(key)) ?? channel;

  switch(field) {

    case "channelNumber": {

      const num = effective.channelNumber;

      return num ? String(num).padStart(6, "0") : "zzzzzz";
    }

    case "channelSelector": {

      return (effective.channelSelector ?? "").toLowerCase();
    }

    case "hdhrEnabled": {

      // Sort enabled channels before disabled. "0" (enabled/absent) sorts before "1" (disabled). The effective-view helper centralizes the implicit-true
      // convention so the sort key here, the table's checked attribute, and every other consumer agree on the meaning of an absent value.
      return getEffectiveHdhrEnabled(effective) ? "0" : "1";
    }

    case "key": {

      return key.toLowerCase();
    }

    case "name": {

      return (effective.name ?? key).toLowerCase();
    }

    case "profile": {

      // Explicit profile: sort by its name.
      if(effective.profile) {

        return effective.profile.toLowerCase();
      }

      // Auto-detected: check whether the profile resolves to a real service or falls back to default. Only apply the ! prefix for non-default auto profiles so
      // they sort between explicit profiles and empty profiles.
      const resolved = getProfileForChannel(effective);

      if(resolved.profileName === "default") {

        return "";
      }

      const label = getChannelServiceLabel(effective);

      return label ? ("!" + label.toLowerCase()) : "";
    }

    case "service": {

      return getChannelServiceLabel(effective).toLowerCase();
    }

    case "stationId": {

      const id = effective.stationId;

      return id ? id.padStart(6, "0") : "zzzzzz";
    }

    case "tags": {

      const effectiveTags = getChannelEffectiveTags(effective);

      return (effectiveTags.length > 0) ? effectiveTags.join(",") : "zz";
    }

    default: {

      return key.toLowerCase();
    }
  }
}

/**
 * Compares two channels for sorting by the specified field and direction with a builtin channel name tiebreaker. The tiebreaker is always ascending so that rows
 * within each group maintain a consistent alphabetical order regardless of the primary sort direction. This is the single comparator for all sort sites - server HTML
 * render, client re-sort, and M3U playlist - to prevent ordering divergence.
 * @param channelA - First channel definition.
 * @param keyA - First channel key.
 * @param channelB - Second channel definition.
 * @param keyB - Second channel key.
 * @param field - The sort field to compare.
 * @param direction - Sort direction for the primary field.
 * @returns A negative, zero, or positive number for sort ordering.
 */
export function compareChannelSort(
  channelA: ResolvedChannel, keyA: string, channelB: ResolvedChannel, keyB: string, field: ChannelSortField, direction: SortDirection
): number {

  const valA = getChannelSortKey(channelA, keyA, field);
  const valB = getChannelSortKey(channelB, keyB, field);
  const cmp = (direction === "asc") ? valA.localeCompare(valB) : valB.localeCompare(valA);

  if(cmp !== 0) {

    return cmp;
  }

  // Tiebreaker: channel name ascending regardless of primary direction.
  const nameA = (channelA.name ?? keyA).toLowerCase();
  const nameB = (channelB.name ?? keyB).toLowerCase();

  return nameA.localeCompare(nameB);
}
