import React from 'react';
import { Download, CheckCircle2, Loader2, MessageSquare } from 'lucide-react';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

function formatSpeed(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return null;
  return `${formatBytes(bps)}/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${String(rem).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${String(remM).padStart(2, '0')}m`;
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export default function DownloadProgressBar({ progress }) {
  if (!progress || !progress.status) return null;

  const {
    status,
    percent,
    downloaded_bytes: downloadedBytes = 0,
    total_bytes: totalBytes = 0,
    speed,
    eta,
    stream,
    elapsed,
    ranged,
    fragment_index: fragIdx,
    fragment_count: fragCnt,
    target_seconds: targetSeconds,
    chat_messages: chatMessages,
    chat_spikes: chatSpikes,
    watch_chat: watchChat,
  } = progress;

  if (status === 'done') {
    const sizeText = totalBytes > 0 ? formatBytes(totalBytes) : (downloadedBytes > 0 ? formatBytes(downloadedBytes) : null);
    const chatText = Number.isFinite(chatMessages) && chatMessages > 0
      ? `${chatMessages} chat msgs${chatSpikes > 0 ? ` (${chatSpikes} hype)` : ''}`
      : null;
    return (
      <div
        className="mb-3 rounded-card border border-ok/30 bg-paper px-3.5 py-2.5 flex items-center justify-between gap-2 text-xs"
        role="status"
        aria-label="Video download complete"
      >
        <span className="flex items-center gap-2 text-ink min-w-0">
          <CheckCircle2 size={14} className="text-ok shrink-0" />
          <span className="truncate font-medium">
            {targetSeconds ? 'Live stream captured' : 'Video downloaded'}
          </span>
        </span>
        <span className="readout normal-case text-ok shrink-0 tabular-nums">
          {[sizeText, chatText, Number.isFinite(elapsed) ? `${elapsed}s` : null, '100%'].filter(Boolean).join(' · ')}
        </span>
      </div>
    );
  }

  const hasPercent = typeof percent === 'number' && Number.isFinite(percent);
  const clamped = hasPercent ? Math.max(0, Math.min(100, percent)) : 0;
  const isStarting = status === 'starting';
  const isMerging = status === 'merging';
  const isLiveCapture = status === 'capturing_live';
  const isIndeterminate = isStarting || (!isMerging && !hasPercent);

  let label = 'Downloading video…';
  if (isStarting) {
    label = 'Connecting to video source…';
  } else if (isLiveCapture) {
    label = targetSeconds
      ? `Capturing live stream (${formatClock(elapsed || 0)} / ${formatClock(targetSeconds)})`
      : 'Capturing live stream…';
  } else if (isMerging) {
    label = 'Merging video & audio…';
  } else if (ranged) {
    label = 'Downloading video range…';
  } else if (stream === 'audio') {
    label = 'Downloading audio…';
  }

  const sizeSummary = totalBytes > 0
    ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
    : downloadedBytes > 0
      ? `${formatBytes(downloadedBytes)} ${isLiveCapture ? 'captured' : 'downloaded'}`
      : fragCnt > 0
        ? `Fragment ${fragIdx || 0} / ${fragCnt}`
        : null;

  const speedText = formatSpeed(speed);
  const etaText = formatEta(eta);

  return (
    <div
      className="mb-3 rounded-card border border-brass/35 bg-paper px-3.5 py-3 space-y-2"
      role="region"
      aria-label="Video download progress"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-2 text-ink font-medium min-w-0">
          {isLiveCapture ? (
            <span className="w-2.5 h-2.5 rounded-full bg-danger animate-pulse shrink-0" />
          ) : isStarting || isMerging ? (
            <Loader2 size={14} className="text-brass animate-spin shrink-0" />
          ) : (
            <Download size={14} className="text-brass shrink-0 animate-pulse" />
          )}
          <span className="truncate">{label}</span>
        </span>
        <span className="font-mono text-xs font-semibold text-brass tabular-nums shrink-0">
          {isMerging ? '100%' : isStarting ? '…' : hasPercent ? `${clamped.toFixed(1)}%` : '…'}
        </span>
      </div>

      {/* Progress Track */}
      <div
        className="relative h-2 w-full rounded-full bg-paper3 overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hasPercent ? Math.round(clamped) : undefined}
      >
        {isIndeterminate ? (
          <div className="h-full w-1/3 rounded-full bg-brass/80 animate-pulse" />
        ) : (
          <div
            className={`h-full rounded-full bg-brass transition-[width] duration-500 ease-out ${isMerging ? 'animate-pulse' : ''}`}
            style={{ width: `${isMerging ? 100 : clamped}%` }}
          />
        )}
      </div>

      {/* Transfer telemetry */}
      {(sizeSummary || speedText || etaText) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 font-mono text-[11px] text-muted tabular-nums">
          <span>{sizeSummary || ''}</span>
          <span className="flex items-center gap-2.5 ml-auto">
            {speedText && <span>{speedText}</span>}
            {etaText && !isMerging && <span>ETA {etaText}</span>}
          </span>
        </div>
      )}

      {/* Live chat hype counter */}
      {isLiveCapture && watchChat && (
        <div className="pt-1.5 border-t border-rule flex items-center justify-between gap-2 font-mono text-[11px] text-ink2 tabular-nums">
          <span className="flex items-center gap-1.5 min-w-0 truncate">
            <MessageSquare size={12} className="text-brass shrink-0" />
            {chatMessages > 0
              ? `Watching live chat · ${chatMessages} msgs`
              : 'Watching live chat…'}
          </span>
          {chatSpikes > 0 && (
            <span className="text-brass shrink-0 font-medium">
              {chatSpikes} hype {chatSpikes === 1 ? 'moment' : 'moments'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
