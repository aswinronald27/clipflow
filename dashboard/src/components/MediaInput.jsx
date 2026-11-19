import React, { useState, useEffect, useRef } from 'react';
import { Link2, Upload, FileVideo, X, Info, Loader2, ChevronDown } from 'lucide-react';
import { track } from '../lib/analytics';
import { getApiUrl } from '../config';
import SourceCost from './SourceCost';
import UrlSizePreview from './UrlSizePreview';
import { useAuth } from '../contexts/AuthContext';
import { FREE_CLIPS_PER_VIDEO, FREE_CLIPS_QUIET, MAX_CLIPS_PER_VIDEO } from '../lib/clipProgress';

const SUPPORTED_PLATFORMS = [
    'YouTube', 'Vimeo', 'TikTok', 'X / Twitter', 'Twitch', 'Kick',
    'Facebook', 'Instagram', 'Dailymotion', 'Reddit', 'Streamable',
];

// Mirrors the server's MIN_SOURCE_SECONDS: shorter sources are rejected with a
// 400 after the whole file was uploaded. Checking the duration in the browser
// says so the moment the file is picked (a 27 s upload used to end in a bare
// "That run failed").
const MIN_SOURCE_SECONDS = 45;

// Duration of a local video file in seconds, or null when the browser cannot
// read it (unsupported codec): then the server stays the judge.
const readVideoDuration = (file) => new Promise((resolve) => {
    try {
        const url = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.preload = 'metadata';
        const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
        v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
        v.onerror = () => done(null);
        setTimeout(() => done(null), 8000);
        v.src = url;
    } catch { resolve(null); }
});

export default function MediaInput({ onProcess, isProcessing }) {
    const { plan } = useAuth();
    const [youtubeUrlEnabled, setYoutubeUrlEnabled] = useState(true);
    // File upload is the primary path; the link is secondary.
    const [mode, setMode] = useState('file'); // 'file' | 'url'
    const [url, setUrl] = useState('');
    const [file, setFile] = useState(null);
    const [fileSeconds, setFileSeconds] = useState(null);
    const fileTooShort = fileSeconds != null && fileSeconds < MIN_SOURCE_SECONDS;
    const [acknowledged, setAcknowledged] = useState(() => {
        try { return localStorage.getItem('os_acknowledged') !== '0'; } catch { return true; }
    });
    // {start, end} in seconds when the user picked a stretch under the cost line.
    const [range, setRange] = useState(null);
    // Pre-submit preview returned by /api/url-preview (size, resolution, is_live).
    const [urlPreview, setUrlPreview] = useState(null);
    const [liveMode, setLiveMode] = useState('rewind'); // 'rewind' (fast DVR) | 'live' (realtime + full chat)
    const [liveDurationMinutes, setLiveDurationMinutes] = useState(5);
    const [watchLiveChat, setWatchLiveChat] = useState(true);
    const [outputFormat, setOutputFormat] = useState('vertical'); // vertical | horizontal | square
    const [showInfo, setShowInfo] = useState(false);
    // Advanced generation controls — empty string means "let the AI decide",
    // which keeps the default pipeline behavior untouched.
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [targetClips, setTargetClips] = useState(() => {
        try { return localStorage.getItem('os_target_clips') || ''; } catch { return ''; }
    });
    const [contentPreset, setContentPreset] = useState(() => {
        try { return localStorage.getItem('os_content_preset') || 'gta6'; } catch { return 'gta6'; }
    });
    const [clipMinSeconds, setClipMinSeconds] = useState('');
    const [clipMaxSeconds, setClipMaxSeconds] = useState('');
    // Auto-hook: burn the AI hook text into every clip. On by default; the
    // choice persists so turning it off sticks across sessions.
    const [autoHook, setAutoHook] = useState(() => {
        try { return localStorage.getItem('os_auto_hook') !== '0'; } catch { return true; }
    });
    const [autoHookStyle, setAutoHookStyle] = useState(() => {
        // v2 key: the default became 'pill'; an old saved 'classic' was just the old default.
        try { return localStorage.getItem('os_auto_hook_style_v2') || 'pill'; } catch { return 'pill'; }
    });
    // Layout: 'auto' lets the AI pick per video (server default); the others
    // force one on so a podcast host who knows what they uploaded doesn't
    // depend on the detector, and 'none' keeps the plain single crop.
    const [layout, setLayout] = useState(() => {
        try { return localStorage.getItem('os_layout') || 'screencast'; } catch { return 'screencast'; }
    });
    const [customStartMin, setCustomStartMin] = useState('');
    const [customDurationMin, setCustomDurationMin] = useState('');
    const infoRef = useRef(null);

    // Close the compatibility popover on any outside click.
    useEffect(() => {
        if (!showInfo) return;
        const onClick = (e) => {
            if (infoRef.current && !infoRef.current.contains(e.target)) setShowInfo(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [showInfo]);

    useEffect(() => {
        let cancelled = false;
        setFileSeconds(null);
        if (!file) return undefined;
        readVideoDuration(file).then((d) => {
            if (cancelled) return;
            setFileSeconds(d);
            if (d != null && d < MIN_SOURCE_SECONDS) {
                track('SourceTooShort', { props: { seconds: String(Math.round(d)) } });
            }
        });
        return () => { cancelled = true; };
    }, [file]);

    useEffect(() => {
        fetch(getApiUrl('/api/config'))
            .then((r) => r.ok ? r.json() : null)
            .then((cfg) => {
                if (cfg && cfg.youtubeUrlEnabled === false) {
                    setYoutubeUrlEnabled(false);
                    setMode('file');
                }
            })
            .catch(() => {});
    }, []);

    // A link pasted in the landing hero: preload it here so the user picks up
    // where they left off. Not auto-submitted — the rights attestation below
    // has to be ticked by the user.
    useEffect(() => {
        let pending = null;
        try {
            pending = localStorage.getItem('os_pending_url');
            if (pending) localStorage.removeItem('os_pending_url');
        } catch { /* ignore */ }
        if (pending) {
            setMode('url');
            setUrl(pending);
        }
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!acknowledged) return;
        const startSec = range ? Math.round(range.start) : (customStartMin ? Math.round(Number(customStartMin) * 60) : null);
        const durSec = range ? Math.round(range.end - range.start) : (customDurationMin ? Math.round(Number(customDurationMin) * 60) : null);
        const endSec = (startSec != null && durSec != null) ? startSec + durSec : (range ? Math.round(range.end) : null);
        const maxMins = durSec ? Math.round(durSec / 60) : (customDurationMin ? Number(customDurationMin) : null);

        const advanced = {
            targetClips: targetClips || null,
            contentPreset: contentPreset || 'gta6',
            clipMinSeconds: clipMinSeconds || null,
            clipMaxSeconds: clipMaxSeconds || null,
            autoHook,
            autoHookStyle,
            layout,
            sourceStart: startSec,
            sourceEnd: endSec,
            maxMinutes: maxMins,
            liveDurationMinutes: (mode === 'url' && urlPreview?.is_live) ? liveDurationMinutes : null,
            watchLiveChat: (mode === 'url' && urlPreview?.is_live) ? watchLiveChat : null,
            liveMode: (mode === 'url' && urlPreview?.is_live) ? liveMode : null,
        };
        try {
            localStorage.setItem('os_target_clips', targetClips);
            localStorage.setItem('os_content_preset', contentPreset);
            localStorage.setItem('os_auto_hook', autoHook ? '1' : '0');
            localStorage.setItem('os_auto_hook_style_v2', autoHookStyle);
            localStorage.setItem('os_layout', layout);
        } catch { /* ignore */ }
        if (mode === 'url' && url) {
            onProcess({ type: 'url', payload: url, acknowledged: true, outputFormat, ...advanced });
        } else if (mode === 'file' && file && !fileTooShort) {
            onProcess({ type: 'file', payload: file, acknowledged: true, outputFormat, ...advanced });
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            setFile(e.dataTransfer.files[0]);
            setMode('file');
        }
    };

    return (
        <div className="card p-4 sm:p-6 animate-fade">
            <div className="flex gap-4 sm:gap-6 mb-6 border-b border-rule" data-tutorial="source-tabs">
                <button
                    onClick={() => setMode('file')}
                    className={`flex items-center gap-2 pb-3 px-1 -mb-px border-b-2 text-sm lowercase whitespace-nowrap transition-colors ${mode === 'file'
                        ? 'text-ink border-brass'
                        : 'text-muted border-transparent hover:text-ink2'
                        }`}
                >
                    <Upload size={16} className={`hidden sm:block ${mode === 'file' ? 'text-brass' : ''}`} />
                    Upload File
                </button>
                {youtubeUrlEnabled && (
                    <button
                        onClick={() => setMode('url')}
                        className={`flex items-center gap-2 pb-3 px-1 -mb-px border-b-2 text-sm lowercase whitespace-nowrap transition-colors ${mode === 'url'
                            ? 'text-ink border-brass'
                            : 'text-muted border-transparent hover:text-ink2'
                            }`}
                    >
                        <Link2 size={16} className={`hidden sm:block ${mode === 'url' ? 'text-brass' : ''}`} />
                        Video URL
                    </button>
                )}
            </div>

            <form onSubmit={handleSubmit}>
                {mode === 'url' ? (
                    <div className="space-y-4" data-tutorial="drop-zone">
                        <div className="relative">
                            <input
                                type="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://... paste a video link"
                                className="input-field pr-11"
                                required
                            />
                            <div className="absolute inset-y-0 right-2 flex items-center" ref={infoRef}>
                                <button
                                    type="button"
                                    onClick={() => setShowInfo((v) => !v)}
                                    aria-label="Supported platforms"
                                    className="p-1.5 text-muted hover:text-brass transition-colors"
                                >
                                    <Info size={16} />
                                </button>
                                {showInfo && (
                                    <div className="absolute right-0 top-full mt-2 w-64 z-20 card p-4 text-left animate-fade">
                                        <p className="eyebrow mb-2">Paste a link from</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {SUPPORTED_PLATFORMS.map((p) => (
                                                <span key={p} className="text-xs px-2 py-0.5 rounded-full bg-paper3 text-ink2">
                                                    {p}
                                                </span>
                                            ))}
                                        </div>
                                        <p className="text-xs text-muted mt-2.5 leading-relaxed">
                                            …and 1,000+ more sites. If a link has a public video, we can usually fetch it.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div
                        data-tutorial="drop-zone"
                        className={`border-2 border-dashed rounded-card p-6 sm:p-8 text-center transition-colors ${file ? 'border-brass' : 'border-rule2 hover:border-brass'
                            }`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={handleDrop}
                    >
                        {file ? (
                            <div className="flex items-center justify-center gap-3 text-ok min-w-0">
                                <FileVideo size={18} className="shrink-0" />
                                <span className="font-medium truncate">{file.name}</span>
                                {file.size > 0 && (
                                    <span className="readout normal-case text-muted shrink-0 tabular-nums">
                                        {file.size >= 1024 ** 3
                                            ? `${(file.size / 1024 ** 3).toFixed(1)} GB`
                                            : `${(file.size / 1024 ** 2).toFixed(file.size >= 100 * 1024 ** 2 ? 0 : 1)} MB`}
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => setFile(null)}
                                    className="p-1 text-muted hover:text-ink hover:bg-paper3 rounded-full transition-colors"
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        ) : null}
                        {file && fileTooShort ? (
                            <p className="text-danger text-sm mt-3" role="alert">
                                This video is {Math.round(fileSeconds)}s long. Clip generation needs at least {MIN_SOURCE_SECONDS}s
                                of footage to cut from: it already is a short. Pick a longer video.
                            </p>
                        ) : null}
                        {!file && (
                            <label className="cursor-pointer block">
                                <input
                                    type="file"
                                    accept="video/*"
                                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                                    className="hidden"
                                />
                                <Upload className="mx-auto mb-3 text-muted" size={18} />
                                <p className="text-ink2 lowercase">Click to upload or drag and drop</p>
                                <p className="readout mt-2">MP4, MOV up to 50GB · at least {MIN_SOURCE_SECONDS}s long</p>
                            </label>
                        )}
                    </div>
                )}

                <UrlSizePreview mode={mode} url={url} onPreview={setUrlPreview} />

                {/* Live stream capture + chat hype options (auto-shown for active YouTube Live links) */}
                {mode === 'url' && urlPreview?.is_live && (
                    <div className="mt-3 rounded-input border border-brass/35 bg-paper px-3.5 py-3 text-left space-y-3 animate-fade">
                        <div>
                            <p className="eyebrow mb-2">Live clipping mode</p>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => setLiveMode('rewind')}
                                    className={`px-3 py-2 rounded-input border text-left transition-colors ${liveMode === 'rewind'
                                        ? 'border-brass bg-brass/15 text-ink'
                                        : 'border-rule2 text-muted hover:border-brass/60 hover:text-ink2'
                                        }`}
                                >
                                    <span className="block text-xs font-medium">⚡ Rewind (Fast)</span>
                                    <span className="block text-[11px] text-muted mt-0.5 leading-snug">
                                        Last {liveDurationMinutes} min already streamed · downloads at full speed
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setLiveMode('live')}
                                    className={`px-3 py-2 rounded-input border text-left transition-colors ${liveMode === 'live'
                                        ? 'border-brass bg-brass/15 text-ink'
                                        : 'border-rule2 text-muted hover:border-brass/60 hover:text-ink2'
                                        }`}
                                >
                                    <span className="block text-xs font-medium">🔴 Record Live</span>
                                    <span className="block text-[11px] text-muted mt-0.5 leading-snug">
                                        Next {liveDurationMinutes} min in real time · watches full live chat
                                    </span>
                                </button>
                            </div>
                        </div>
                        <div>
                            <p className="eyebrow mb-2">
                                {liveMode === 'rewind' ? 'Grab last' : 'Record next'}
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {[2, 5, 10, 15, 30].map((mins) => {
                                    const active = liveDurationMinutes === mins;
                                    return (
                                        <button
                                            key={mins}
                                            type="button"
                                            onClick={() => setLiveDurationMinutes(mins)}
                                            className={`px-3 py-1.5 rounded-full font-mono text-xs border transition-colors ${active
                                                ? 'border-brass bg-brass/15 text-ink font-medium'
                                                : 'border-rule2 text-muted hover:border-brass/60 hover:text-ink2'
                                                }`}
                                        >
                                            {mins} min
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        <label className="flex items-start gap-2 text-xs text-ink2 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={watchLiveChat}
                                onChange={(e) => setWatchLiveChat(e.target.checked)}
                                className="mt-0.5 w-4 h-4 shrink-0 accent-[var(--color-accent)] cursor-pointer"
                            />
                            <span>
                                <span className="font-medium text-ink">Use live chat for best moments</span>
                                <span className="block text-[11px] text-muted mt-0.5 leading-relaxed">
                                    {liveMode === 'rewind'
                                        ? 'Pulls recent viewer chat spikes & reactions along with audio-first transcription while the video downloads.'
                                        : `Tracks viewer chat spikes, reactions & Super Chats live during the ${liveDurationMinutes}-min capture.`}
                                </span>
                            </span>
                        </label>
                    </div>
                )}

                <SourceCost
                    mode={mode}
                    url={url}
                    fileSeconds={fileSeconds}
                    urlDuration={urlPreview?.duration}
                    range={range}
                    onRangeChange={setRange}
                />

                {/* Output format selector */}
                <div className="mt-5" data-tutorial="output-format">
                    <p className="eyebrow mb-2">Output format</p>
                    <div className="grid grid-cols-3 gap-2">
                        {[
                            { value: 'vertical', label: '9:16', hint: 'Shorts · Reels · TikTok', w: 18, h: 32 },
                            { value: 'square', label: '1:1', hint: 'Feed posts', w: 28, h: 28 },
                            { value: 'horizontal', label: '16:9', hint: 'Keep landscape · YouTube', w: 36, h: 20 },
                        ].map((f) => {
                            const active = outputFormat === f.value;
                            return (
                                <button
                                    key={f.value}
                                    type="button"
                                    onClick={() => setOutputFormat(f.value)}
                                    className={`py-3 px-2 rounded-input border flex flex-col items-center gap-2 transition-colors
                                        ${active ? 'border-[color:var(--color-accent)] text-ink' : 'border-rule2 text-muted hover:border-[color:var(--color-accent)]'}`}
                                >
                                    {/* Aspect-ratio glyph */}
                                    <span
                                        className="rounded-[3px] border-2 transition-colors"
                                        style={{
                                            width: `${f.w}px`,
                                            height: `${f.h}px`,
                                            borderColor: active ? 'var(--color-accent)' : 'var(--color-rule-2)',
                                            backgroundColor: active ? 'color-mix(in srgb, var(--color-accent) 22%, transparent)' : 'transparent',
                                        }}
                                    />
                                    <span className="block font-mono text-sm leading-none">{f.label}</span>
                                    <span className="block text-[11px] sm:text-[10px] leading-tight text-center text-muted">{f.hint}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Number of clips to generate */}
                <div className="mt-5">
                    <div className="flex items-center justify-between mb-2">
                        <p className="eyebrow">Clips to generate</p>
                        <span className="text-[11px] text-muted">
                            {targetClips ? `${targetClips} clip${targetClips === '1' ? '' : 's'}` : 'All best moments (AI selects)'}
                        </span>
                    </div>
                    <div className="grid grid-cols-6 gap-2">
                        {[
                            { value: '', label: 'All Best' },
                            { value: '3', label: '3' },
                            { value: '5', label: '5' },
                            { value: '8', label: '8' },
                            { value: '10', label: '10' },
                            { value: '15', label: '15' },
                        ].map((btn) => {
                            const active = targetClips === btn.value;
                            return (
                                <button
                                    key={btn.value}
                                    type="button"
                                    onClick={() => setTargetClips(btn.value)}
                                    className={`py-2 px-1 text-center rounded-input border text-xs font-mono transition-colors ${
                                        active
                                            ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-ink font-semibold'
                                            : 'border-rule2 text-muted hover:border-[color:var(--color-accent)] hover:text-ink'
                                    }`}
                                >
                                    {btn.label}
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                        <span className="text-[11px] text-muted whitespace-nowrap">or enter number of clips:</span>
                        <input
                            type="number"
                            min="1"
                            max="25"
                            step="1"
                            value={targetClips}
                            onChange={(e) => setTargetClips(e.target.value)}
                            placeholder="e.g. 6, 12, 20"
                            className="input-field py-1 text-xs w-28 text-center"
                        />
                    </div>
                </div>

                {/* AI Recognition Engine Preset */}
                <div className="mt-5">
                    <p className="eyebrow mb-2">AI Recognition Mode</p>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                setContentPreset('gta6');
                                if (layout === 'auto' || !layout) setLayout('screencast');
                            }}
                            className={`p-2.5 rounded-input border text-left transition-colors cursor-pointer ${
                                contentPreset === 'gta6'
                                    ? 'border-brass bg-brass/15 text-ink'
                                    : 'border-rule2 text-muted hover:border-brass/60 hover:text-ink2'
                            }`}
                        >
                            <span className="block text-xs font-medium text-ink flex items-center gap-1.5">
                                🎮 GTA 6 & Gaming
                                {contentPreset === 'gta6' && (
                                    <span className="text-[9px] px-1.5 py-0.5 bg-brass text-black rounded font-bold uppercase">Active</span>
                                )}
                            </span>
                            <span className="block text-[11px] text-muted mt-1 leading-snug">
                                Chases, 5-star police pursuits, stunts, ragdoll fails, Vice City heists & hype reactions
                            </span>
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setContentPreset('general');
                                if (layout === 'screencast' || layout === 'gameplay') setLayout('auto');
                            }}
                            className={`p-2.5 rounded-input border text-left transition-colors cursor-pointer ${
                                contentPreset === 'general'
                                    ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-ink'
                                    : 'border-rule2 text-muted hover:border-[color:var(--color-accent)] hover:text-ink2'
                            }`}
                        >
                            <span className="block text-xs font-medium text-ink flex items-center gap-1.5">
                                🎙️ General / Podcasts
                                {contentPreset === 'general' && (
                                    <span className="text-[9px] px-1.5 py-0.5 bg-[color:var(--color-accent)] text-black rounded font-bold uppercase">Active</span>
                                )}
                            </span>
                            <span className="block text-[11px] text-muted mt-1 leading-snug">
                                Talks, interviews, debates, commentary & standard short-form hooks
                            </span>
                        </button>
                    </div>
                </div>

                {/* Framing Mode: only shown for vertical 9:16 format */}
                {outputFormat === 'vertical' && (
                    <div className="mt-5 animate-fade" data-tutorial="framing-mode">
                        <div className="flex items-center justify-between mb-2">
                            <p className="eyebrow">Video Framing & Camera Focus</p>
                            <span className="text-[11px] text-muted">
                                {layout === 'screencast' && 'Game on top + facecam below'}
                                {layout === 'gameplay' && '100% center gameplay (no facecam)'}
                                {layout === 'full' && 'Full 16:9 widescreen + blurred background'}
                                {layout === 'auto' && 'Tracks speaker face (podcasts)'}
                            </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <button
                                type="button"
                                onClick={() => setLayout('screencast')}
                                className={`p-2.5 rounded-input border text-left transition-colors cursor-pointer ${
                                    layout === 'screencast'
                                        ? 'border-brass bg-brass/15 text-ink ring-1 ring-brass/40'
                                        : 'border-rule2 text-muted hover:border-brass/60 hover:text-ink2'
                                }`}
                            >
                                <span className="block text-xs font-medium text-ink flex items-center justify-between">
                                    <span>🎮 Gaming Split</span>
                                    {layout === 'screencast' && (
                                        <span className="text-[9px] px-1.5 py-0.5 bg-brass text-black rounded font-bold uppercase">Active</span>
                                    )}
                                </span>
                                <span className="block text-[11px] text-muted mt-1 leading-snug">
                                    Full gameplay on top + streamer reaction cam below (Best for GTA 6 streams)
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setLayout('gameplay')}
                                className={`p-2.5 rounded-input border text-left transition-colors cursor-pointer ${
                                    layout === 'gameplay'
                                        ? 'border-brass bg-brass/15 text-ink ring-1 ring-brass/40'
                                        : 'border-rule2 text-muted hover:border-brass/60 hover:text-ink2'
                                }`}
                            >
                                <span className="block text-xs font-medium text-ink flex items-center justify-between">
                                    <span>🎯 Pure Gameplay</span>
                                    {layout === 'gameplay' && (
                                        <span className="text-[9px] px-1.5 py-0.5 bg-brass text-black rounded font-bold uppercase">Active</span>
                                    )}
                                </span>
                                <span className="block text-[11px] text-muted mt-1 leading-snug">
                                    Centered 9:16 action crop (Ignores webcam, keeps 100% gameplay action)
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setLayout('auto')}
                                className={`p-2.5 rounded-input border text-left transition-colors cursor-pointer ${
                                    layout === 'auto'
                                        ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-ink ring-1 ring-[color:var(--color-accent)]/40'
                                        : 'border-rule2 text-muted hover:border-[color:var(--color-accent)] hover:text-ink2'
                                }`}
                            >
                                <span className="block text-xs font-medium text-ink flex items-center justify-between">
                                    <span>👤 Face Focus</span>
                                    {layout === 'auto' && (
                                        <span className="text-[9px] px-1.5 py-0.5 bg-[color:var(--color-accent)] text-black rounded font-bold uppercase">Active</span>
                                    )}
                                </span>
                                <span className="block text-[11px] text-muted mt-1 leading-snug">
                                    Tracks person / talking head (Best for podcasts, interviews & vlogs)
                                </span>
                            </button>
                        </div>
                    </div>
                )}

                {/* Advanced generation controls — collapsed by default; blank = AI decides */}
                <div className="mt-4">
                    <button
                        type="button"
                        onClick={() => setShowAdvanced((v) => !v)}
                        className="flex items-center gap-1.5 text-xs text-muted hover:text-ink2 lowercase transition-colors"
                    >
                        <ChevronDown size={14} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                        advanced options
                        {(targetClips || clipMinSeconds || clipMaxSeconds || !autoHook) && (
                            <span className="text-brass">·</span>
                        )}
                    </button>
                    {showAdvanced && (
                        /* Stacked on a phone: three number fields side by side leaves
                           ~100px each, which crushes both label and value. */
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-2 animate-fade">
                            <div>
                                <p className="eyebrow mb-1.5">clips to aim for</p>
                                <input
                                    type="number" min="1" max="25" step="1"
                                    value={targetClips}
                                    onChange={(e) => setTargetClips(e.target.value)}
                                    placeholder="all best"
                                    className="input-field"
                                />
                            </div>
                            <div>
                                <p className="eyebrow mb-1.5">min length (s)</p>
                                <input
                                    type="number" min="5" max="175" step="1"
                                    value={clipMinSeconds}
                                    onChange={(e) => setClipMinSeconds(e.target.value)}
                                    placeholder="15"
                                    className="input-field"
                                />
                            </div>
                            <div>
                                <p className="eyebrow mb-1.5">max length (s)</p>
                                <input
                                    type="number" min="10" max="180" step="1"
                                    value={clipMaxSeconds}
                                    onChange={(e) => setClipMaxSeconds(e.target.value)}
                                    placeholder="60"
                                    className="input-field"
                                />
                            </div>
                            <p className="col-span-1 sm:col-span-3 text-[11px] leading-relaxed text-muted">
                                Targets, not guarantees: the AI returns fewer clips when the
                                material doesn't hold them. Leave blank to let it decide.
                                {plan === 'free' && ` The free plan makes the ${FREE_CLIPS_PER_VIDEO} to ${FREE_CLIPS_QUIET} best clips of each video, fewer while its queue is busy; plans get every clip, up to ${MAX_CLIPS_PER_VIDEO}.`}
                            </p>
                            <div className="col-span-1 sm:col-span-3 pt-3 sm:pt-1 border-t border-rule">
                                <div className="flex items-center justify-between mb-1.5">
                                    <p className="eyebrow">Source video slice (recommended for long streams &gt;30m)</p>
                                    <div className="flex gap-1.5">
                                        {[15, 30, 45, 60].map((mins) => (
                                            <button
                                                key={mins}
                                                type="button"
                                                onClick={() => { setCustomStartMin('0'); setCustomDurationMin(String(mins)); }}
                                                className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                                                    customDurationMin === String(mins) && (!customStartMin || customStartMin === '0')
                                                        ? 'border-brass bg-brass/15 text-ink'
                                                        : 'border-rule2 text-muted hover:border-brass/60'
                                                }`}
                                            >
                                                first {mins}m
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <span className="text-[11px] text-muted block mb-1">start at minute</span>
                                        <input
                                            type="number" min="0" step="1"
                                            value={customStartMin}
                                            onChange={(e) => setCustomStartMin(e.target.value)}
                                            placeholder="0 (start from beginning)"
                                            className="input-field py-1 text-xs"
                                        />
                                    </div>
                                    <div>
                                        <span className="text-[11px] text-muted block mb-1">duration (minutes)</span>
                                        <input
                                            type="number" min="1" step="1"
                                            value={customDurationMin}
                                            onChange={(e) => setCustomDurationMin(e.target.value)}
                                            placeholder="e.g. 30, 45 (blank = whole file)"
                                            className="input-field py-1 text-xs"
                                        />
                                    </div>
                                </div>
                                <p className="text-[11px] text-muted mt-1 leading-relaxed">
                                    For long multi-hour streams (e.g. 8.5 hours), picking a 30–60 min slice processes in ~2 minutes and prevents system memory overload.
                                </p>
                            </div>
                            <div className="col-span-1 sm:col-span-3 flex flex-wrap items-center justify-between gap-3 pt-3 sm:pt-1 border-t border-rule">
                                <span className="text-xs text-ink2">vertical layout</span>
                                <select
                                    value={layout}
                                    onChange={(e) => setLayout(e.target.value)}
                                    className="input-field !w-auto text-xs py-1.5"
                                    aria-label="vertical layout"
                                >
                                    <option value="screencast">🎮 Gaming Split (Screen + Facecam)</option>
                                    <option value="gameplay">🎯 Pure Gameplay (Centered 9:16 Action)</option>
                                    <option value="auto">👤 Face Focus / Auto (AI picks)</option>
                                    <option value="full">📺 Full Frame (16:9 Letterbox)</option>
                                    <option value="split">Two speakers stacked</option>
                                    <option value="none">Single crop only</option>
                                </select>
                            </div>
                            <div className="col-span-1 sm:col-span-3 flex flex-wrap items-center justify-between gap-3 pt-3 sm:pt-1 border-t border-rule">
                                <label className="flex items-center gap-2 text-xs text-ink2 cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        checked={autoHook}
                                        onChange={(e) => setAutoHook(e.target.checked)}
                                        className="w-4 h-4 shrink-0 accent-[var(--color-accent)] cursor-pointer"
                                    />
                                    auto hook titles on clips
                                </label>
                                {autoHook && (
                                    <select
                                        value={autoHookStyle}
                                        onChange={(e) => setAutoHookStyle(e.target.value)}
                                        className="input-field !w-auto text-xs py-1.5"
                                    >
                                        <option value="pill">Pills</option>
                                        <option value="classic">Classic</option>
                                        <option value="dark">Dark</option>
                                        <option value="yellow">Yellow</option>
                                        <option value="red">Red</option>
                                        <option value="outline">Outline</option>
                                        <option value="outline_yellow">Outline+</option>
                                    </select>
                                )}
                                {autoHook && (
                                    <p className="w-full text-[11px] leading-relaxed text-muted">
                                        You can change each clip&apos;s hook text, style, position and size
                                        afterwards with its hook button.
                                    </p>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <label className="flex items-start gap-2.5 mt-5 text-left text-[13px] sm:text-xs leading-relaxed text-muted cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                        className="mt-0.5 w-4 h-4 shrink-0 accent-[var(--color-accent)] cursor-pointer"
                    />
                    <span>
                        I confirm I own this content or have the rights to process it. I am responsible for any content I submit. See our <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-ink2 underline underline-offset-2 hover:text-brass transition-colors" onClick={(e) => e.stopPropagation()}>Terms</a> and <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-ink2 underline underline-offset-2 hover:text-brass transition-colors" onClick={(e) => e.stopPropagation()}>Privacy Policy</a>.
                    </span>
                </label>

                <button
                    type="submit"
                    data-tutorial="generate"
                    disabled={isProcessing || !acknowledged || (mode === 'url' && !url) || (mode === 'file' && (!file || fileTooShort))}
                    className="w-full btn-primary mt-4"
                >
                    {isProcessing ? (
                        <>
                            <Loader2 size={16} className="animate-spin" />
                            Processing Video...
                        </>
                    ) : (
                        <>
                            {mode === 'url' && urlPreview?.is_live
                                ? (liveMode === 'rewind' ? `Clip Last ${liveDurationMinutes} Min of Live` : 'Record Live & Generate Clips')
                                : 'Generate Clips'}
                        </>
                    )}
                </button>
            </form>
        </div>
    );
}
