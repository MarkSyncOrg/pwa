import type { StorageArea } from '@marksyncorg/core';

// When this device last reconciled with the service.
//
// Deliberately not `SyncStore.getLastUpdated()`, which holds the service's own revision
// stamp: that answers "which revision am I holding", and it does not move when a sync
// finds nothing to do. What the header has to answer is "when did this device last
// manage to reach the service", so a user looking at a stale list can tell a quiet sync
// from a broken one. Only a completed sync writes it.

const KEY = 'lastSyncAt';

export class LastSyncStore {
  constructor(private readonly area: StorageArea) {}

  /** ISO timestamp of the last completed sync, or undefined if there has not been one. */
  get(): Promise<string | undefined> {
    return this.area.get<string>(KEY);
  }

  set(at: Date = new Date()): Promise<void> {
    return this.area.set(KEY, at.toISOString());
  }

  /** Dropped on logout: the next sync ID's freshness is not this one's. */
  clear(): Promise<void> {
    return this.area.remove(KEY);
  }
}
