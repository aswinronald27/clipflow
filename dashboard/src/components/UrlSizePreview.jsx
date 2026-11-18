import React, { useEffect, useState } from 'react';
import { HardDrive, Loader2, AlertTriangle, Film } from 'lucide-react';
import { apiFetch } from '../lib/api';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const looksLikeUrl = (u) => /^https?:\/\/\S+\.\S+/.test((u || '').trim());

export default function UrlSizePreview({ mode, url, onPreview }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setPreview(null);
    onPreview?.(null);
    if (mode !== 'url' || !looksLikeUrl(url)) {
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;

    const timer = setTimeout(() => {
      setLoading(true);
      apiFetch('/api/url-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data) {
            setPreview(data);
            onPreview?.(data);
          }
        })
        .catch(() => { /* ignore aborts / probe failures */ })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 600);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, url]);

  if (mode !== 'url') return null;

  if (loading && !preview) {
    return (
      <p className="mt-2.5 flex items-center gap-2 text-xs text-muted" role="status">
        <Loader2 size={12} className="animate-spin text-brass shrink-0" />
        <span>Checking estimated video size…</span>
      </p>
    );
  }

  if (!preview) return null;

  if (preview.error) {
    return (
      <p className="mt-2.5 flex items-center gap-1.5 text-xs text-warn text-left" role="alert">
        <AlertTriangle size={13} className="shrink-0" />
        <span>{preview.error}</span>
      </p>
    );
  }

  if (!preview.ok) return null;

  const sizeLabel = formatBytes(preview.estimated_bytes);
  const durationLabel = formatDuration(preview.duration);
  const heightLabel = preview.height > 0 ? `${preview.height}p` : null;

  if (preview.is_live) {
    return (
      <div
        className="mt-2.5 rounded-input border border-danger/40 bg-paper px-3 py-2 text-xs text-left flex items-center justify-between gap-2"
        role="status"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-danger shrink-0">
            <span className="w-2 h-2 rounded-full bg-danger animate-pulse" />
            LIVE
          </span>
          {preview.title && <span className="text-ink font-medium truncate">{preview.title}</span>}
        </div>
        {heightLabel && <span className="font-mono text-[11px] text-muted shrink-0">{heightLabel}</span>}
      </div>
    );
  }

  if (!sizeLabel && !durationLabel && !heightLabel) return null;

  return (
    <div
      className="mt-2.5 rounded-input border border-rule bg-paper px-3 py-2.5 text-xs text-left space-y-1.5 animate-fade"
      role="status"
      aria-label="Estimated video download info"
    >
      {preview.title && (
        <div className="flex items-center gap-1.5 text-ink font-medium min-w-0">
          <Film size={12} className="text-muted shrink-0" />
          <span className="truncate">{preview.title}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums">
        <span className="flex items-center gap-1.5 text-brass font-medium">
          <HardDrive size={12} className="shrink-0" />
          {sizeLabel
            ? `${preview.is_estimate ? '~' : ''}${sizeLabel} download`
            : 'Download size unknown'}
        </span>
        <span className="text-muted flex items-center gap-2">
          {heightLabel && <span>{heightLabel}</span>}
          {heightLabel && durationLabel && <span>·</span>}
          {durationLabel && <span>{durationLabel}</span>}
        </span>
      </div>
    </div>
  );
}
