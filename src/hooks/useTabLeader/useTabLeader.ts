import { useSyncExternalStore } from 'react';

const CHANNEL_NAME = 'dark-space:tab-leader';
const HEARTBEAT_MS = 8000;
const LEADER_TIMEOUT_MS = HEARTBEAT_MS * 3;
const CLAIM_WINDOW_MS = 700;

interface TabState {
  bc: BroadcastChannel;
  isLeader: boolean;
  lastHeartbeat: number;
  heartbeat: ReturnType<typeof setInterval> | null;
  watchdog: ReturnType<typeof setInterval> | null;
}

const leaderListeners = new Set<() => void>();

function notify() {
  for (const cb of leaderListeners) cb();
}

function becomeLeader(state: TabState) {
  if (state.isLeader) return;
  state.isLeader = true;
  state.lastHeartbeat = Date.now();
  state.bc.postMessage({ type: 'heartbeat', t: state.lastHeartbeat });
  if (state.heartbeat) clearInterval(state.heartbeat);
  state.heartbeat = setInterval(() => {
    state.lastHeartbeat = Date.now();
    state.bc.postMessage({ type: 'heartbeat', t: state.lastHeartbeat });
  }, HEARTBEAT_MS);
  notify();
}

let tabState: TabState | null = null;

function getTabState(): TabState {
  if (tabState) return tabState;

  const bc = new BroadcastChannel(CHANNEL_NAME);
  const state: TabState = { bc, isLeader: false, lastHeartbeat: 0, heartbeat: null, watchdog: null };
  tabState = state;

  bc.onmessage = (ev) => {
    const msg = (ev.data ?? {}) as { type?: 'heartbeat' | 'probe' | 'present'; t?: number };
    if (msg.type === 'heartbeat') {
      state.lastHeartbeat = msg.t ?? Date.now();
      if (state.isLeader) {
        state.isLeader = false;
        if (state.heartbeat) {
          clearInterval(state.heartbeat);
          state.heartbeat = null;
        }
        notify();
      }
    } else if (msg.type === 'probe' && state.isLeader) {
      bc.postMessage({ type: 'present' });
    }
  };

  bc.postMessage({ type: 'probe' });

  // Claim leadership if no other tab answers within the window.
  setTimeout(() => {
    if (state.isLeader) return;
    if (Date.now() - state.lastHeartbeat > LEADER_TIMEOUT_MS) {
      becomeLeader(state);
    }
  }, CLAIM_WINDOW_MS);

  // Watchdog: take over if the current leader stops heartbeating.
  state.watchdog = setInterval(() => {
    if (state.isLeader) return;
    if (Date.now() - state.lastHeartbeat > LEADER_TIMEOUT_MS) {
      becomeLeader(state);
    }
  }, 2000);

  return state;
}

function subscribe(callback: () => void) {
  leaderListeners.add(callback);
  return () => {
    leaderListeners.delete(callback);
  };
}

function getSnapshot(): boolean {
  return getTabState().isLeader;
}

function getServerSnapshot(): boolean {
  return false;
}

// Returns true only for the single "leader" tab. Other tabs defer polling to
// the leader so open tabs don't each run the same pollers.
export function useTabLeader(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
