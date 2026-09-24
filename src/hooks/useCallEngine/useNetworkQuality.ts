import { useEffect, useRef, useState, useCallback } from 'react';

export type NetworkQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

interface QualitySample {
  rtt: number;
  packetsLost: number;
  packetsReceived: number;
  jitter: number;
  bitrate: number;
}

function classifyQuality(sample: QualitySample): NetworkQuality {
  if (sample.rtt > 400 || sample.packetsLost / Math.max(sample.packetsReceived + sample.packetsLost, 1) > 0.1) {
    return 'poor';
  }
  if (sample.rtt > 200 || sample.packetsLost / Math.max(sample.packetsReceived + sample.packetsLost, 1) > 0.05) {
    return 'fair';
  }
  if (sample.rtt > 80) return 'good';
  return 'excellent';
}

export function useNetworkQuality(
  getPeers: () => Map<string, { peerConnection: RTCPeerConnection }>,
) {
  const [quality, setQuality] = useState<NetworkQuality>('unknown');
  const [stats, setStats] = useState<QualitySample | null>(null);

  // FIX: previously keyed by `report.id` alone in a single Map that persisted
  // for the component's whole lifetime. Chrome tends to reuse report ids
  // (e.g. "RTCInboundRTPAudioStream_1") across *different* RTCPeerConnection
  // instances, so the first stats sample of a brand-new call could get diffed
  // against packet counts left over from a previous, already-ended call -
  // producing a bogus "poor" reading right as a good connection starts.
  // Keying by the RTCPeerConnection object itself (WeakMap) scopes every
  // diff to the connection it actually came from, and old entries are
  // automatically garbage-collected once that connection is replaced/closed -
  // no manual reset needed.
  const prevStatsRef = useRef<WeakMap<RTCPeerConnection, Map<string, { packetsLost: number; packetsReceived: number }>>>(new WeakMap());

  const collectStats = useCallback(async () => {
    const peers = getPeers();
    if (peers.size === 0) {
      setQuality('unknown');
      return;
    }

    let totalRtt = 0;
    let totalLost = 0;
    let totalReceived = 0;
    let totalJitter = 0;
    let count = 0;

    for (const [, { peerConnection }] of peers) {
      try {
        const reports = await peerConnection.getStats();

        if (!prevStatsRef.current.has(peerConnection)) {
          prevStatsRef.current.set(peerConnection, new Map());
        }
        const prev = prevStatsRef.current.get(peerConnection)!;

        reports.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
            totalRtt += report.currentRoundTripTime * 1000;
            count++;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            const prevReport = prev.get(report.id);
            const lostDiff = report.packetsLost - (prevReport?.packetsLost ?? report.packetsLost);
            const recvDiff = report.packetsReceived - (prevReport?.packetsReceived ?? report.packetsReceived);
            totalLost += Math.max(lostDiff, 0);
            totalReceived += Math.max(recvDiff, 0);
            totalJitter += report.jitter ?? 0;
          }
        });

        reports.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            prev.set(report.id, {
              packetsLost: report.packetsLost,
              packetsReceived: report.packetsReceived,
            });
          }
        });
      } catch { /* stats collection failed */ }
    }

    if (count > 0) {
      const sample: QualitySample = {
        rtt: totalRtt / count,
        packetsLost: totalLost,
        packetsReceived: totalReceived,
        jitter: totalJitter / Math.max(count, 1),
        bitrate: 0,
      };
      setStats(sample);
      setQuality(classifyQuality(sample));
    }
  }, [getPeers]);

  useEffect(() => {
    const interval = setInterval(collectStats, 3000);
    collectStats();
    return () => clearInterval(interval);
  }, [collectStats]);

  return { quality, stats };
}