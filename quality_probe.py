"""
Fast pre-flight probe: what maximum resolution does YouTube offer for a URL?

Run as a short subprocess by app.py BEFORE a job starts, so the user can decide
to abort (and e.g. refresh cookies) instead of burning 20+ minutes of
transcription and rendering on a 360p-only source.

Prints JSON to stdout: {"max_height": int, "mode": str, "cookies_invalid": bool}
Always exits 0 — the caller treats probe failures as "unknown" and starts the
job anyway (fail-open), where the in-job warning still applies.
"""
import argparse
import json
import os
import sys

from dotenv import load_dotenv

load_dotenv()


def _fmt_bytes(fmt, duration):
    """Return (bytes, is_estimate) for one yt-dlp format dict, or (None, True)."""
    if not isinstance(fmt, dict):
        return None, True
    exact = fmt.get('filesize')
    if isinstance(exact, (int, float)) and exact > 0:
        return int(exact), False
    approx = fmt.get('filesize_approx')
    if isinstance(approx, (int, float)) and approx > 0:
        return int(approx), True
    if duration and duration > 0:
        rate = fmt.get('tbr')
        if not (isinstance(rate, (int, float)) and rate > 0):
            vbr = fmt.get('vbr') or 0
            abr = fmt.get('abr') or 0
            rate = (vbr if isinstance(vbr, (int, float)) else 0) + (abr if isinstance(abr, (int, float)) else 0)
        if isinstance(rate, (int, float)) and rate > 0:
            return int(rate * 1000.0 / 8.0 * float(duration)), True
    return None, True


def estimate_download_size(info, max_height=1080):
    """Estimate the download size (bytes) matching main.py's format selector.

    Returns ``(estimated_bytes, is_estimate, picked_height)``.
    """
    if not isinstance(info, dict):
        return None, True, 0
    duration = info.get('duration') or 0
    raw_formats = info.get('formats') or []
    formats = [
        f for f in raw_formats
        if isinstance(f, dict)
        and f.get('protocol') != 'mhtml'
        and f.get('ext') != 'mhtml'
    ]

    def _video_rank(f):
        return (
            int(f.get('height') or 0),
            float(f.get('tbr') or f.get('vbr') or 0),
            int(f.get('filesize') or f.get('filesize_approx') or 0),
        )

    def _audio_rank(f):
        return (
            float(f.get('abr') or f.get('tbr') or 0),
            int(f.get('filesize') or f.get('filesize_approx') or 0),
        )

    # Mirror main.py's _hd_fmt_for(capped=False): avc1<=1080 mp4 + m4a, then broader fallbacks.
    v_only = [
        f for f in formats
        if f.get('vcodec', 'none') != 'none'
        and f.get('acodec', 'none') == 'none'
        and (not f.get('height') or f.get('height') <= max_height)
    ]
    a_only = [
        f for f in formats
        if f.get('vcodec', 'none') == 'none'
        and f.get('acodec', 'none') != 'none'
    ]
    combined = [
        f for f in formats
        if f.get('vcodec', 'none') != 'none'
        and f.get('acodec', 'none') != 'none'
        and (not f.get('height') or f.get('height') <= max_height)
    ]

    best_v = None
    for pool in (
        [f for f in v_only if str(f.get('vcodec') or '').startswith('avc1') and f.get('ext') == 'mp4'],
        [f for f in v_only if str(f.get('vcodec') or '').startswith('avc1')],
        v_only,
    ):
        if pool:
            best_v = max(pool, key=_video_rank)
            break

    best_a = None
    for pool in (
        [f for f in a_only if f.get('ext') == 'm4a'],
        a_only,
    ):
        if pool:
            best_a = max(pool, key=_audio_rank)
            break

    if best_v and best_a:
        vb, v_est = _fmt_bytes(best_v, duration)
        ab, a_est = _fmt_bytes(best_a, duration)
        height = int(best_v.get('height') or 0)
        if vb is not None:
            return vb + (ab or 0), bool(v_est or (ab is not None and a_est)), height

    if combined:
        for pool in (
            [f for f in combined if f.get('ext') == 'mp4'],
            combined,
        ):
            if pool:
                best_c = max(pool, key=_video_rank)
                cb, c_est = _fmt_bytes(best_c, duration)
                if cb is not None:
                    return cb, c_est, int(best_c.get('height') or 0)
                break

    if best_v:
        vb, v_est = _fmt_bytes(best_v, duration)
        if vb is not None:
            return vb, v_est, int(best_v.get('height') or 0)

    # Top-level filesize/filesize_approx (e.g. direct single-stream extractors)
    top_b, top_est = _fmt_bytes(info, duration)
    if top_b is not None:
        return top_b, top_est, int(info.get('height') or 0)
    return None, True, 0


def _find_cookies_path():
    # Mirrors main.py's cookie discovery.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for candidate in [
        os.path.join(script_dir, 'www.youtube.com_cookies.txt'),
        os.path.join(script_dir, 'cookies.txt'),
        '/app/cookies.txt',
    ]:
        if os.path.exists(candidate):
            return candidate
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe available YouTube quality for a URL.")
    parser.add_argument("--url", required=True)
    args = parser.parse_args()

    result = {
        "max_height": 0,
        "mode": None,
        "cookies_invalid": False,
        "duration": 0,
        "estimated_bytes": None,
        "size_is_estimate": True,
        "picked_height": 0,
        "title": "",
        "is_live": False,
    }
    # Same gates as the metering probe and the download (app.py also checks
    # before spawning this): a URL on a private / tailnet address, or a
    # YouTube page that is not one video, never reaches yt-dlp. The empty
    # result is the fail-open "unknown", so the caller carries on and the
    # real probe / download refuse the URL with their own message.
    try:
        from security_utils import assert_public_url
        from yt_clients import youtube_non_video_reason
        assert_public_url(args.url)
        if youtube_non_video_reason(args.url):
            raise ValueError("not a single video")
    except Exception:
        print(json.dumps(result))
        return 0
    try:
        import yt_dlp
        import ssrf_guard

        warnings = []

        class _CollectLogger:
            def debug(self, msg):
                pass

            def info(self, msg):
                pass

            def warning(self, msg):
                warnings.append(str(msg))

            def error(self, msg):
                warnings.append(str(msg))

        import contextlib
        import yt_account
        # One of the configured accounts; a cookies file next to the script
        # (self-host) when the environment has none.
        session = yt_account.Session()
        cookies_path = session.path or _find_cookies_path()
        base_opts = {
            'quiet': True,
            'no_warnings': False,
            'logger': _CollectLogger(),
            'socket_timeout': 20,
            'retries': 2,
            'cachedir': False,
            # A watch?v=X&list=... link is the one video; without this
            # yt-dlp walks the whole list (see cloud/metering.py).
            'noplaylist': True,
        }
        # yt-dlp's default player clients (tv_downgraded/web_safari with
        # cookies, android_vr/web_safari anonymous) are the ones that still
        # serve HD without PO tokens — never override them here.
        attempts = []
        # Not while YouTube has the account limited (yt_account): the request
        # would fail and count against it again.
        if cookies_path and yt_account.cooling_down() <= 0:
            attempts.append(("cookie-auth", {**base_opts, 'cookiefile': cookies_path}))
        attempts.append(("anonymous", {**base_opts, 'cookiefile': None}))

        for mode, opts in attempts:
            authed = mode == "cookie-auth"
            try:
                with (session.request() if authed else contextlib.nullcontext()):
                    with ssrf_guard.guarded(), yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(args.url, download=False)
                if authed:
                    session.ok()
                formats = info.get('formats') or []
                heights = [
                    f.get('height') or 0
                    for f in formats
                    if f.get('vcodec', 'none') != 'none'
                    and f.get('protocol') != 'mhtml'
                    and f.get('ext') != 'mhtml'
                ]
                max_height = max(heights, default=0)
                est_bytes, est_approx, picked_h = estimate_download_size(info)
                if max_height > result["max_height"]:
                    result["max_height"] = max_height
                    result["mode"] = mode
                    if est_bytes is not None:
                        result["estimated_bytes"] = est_bytes
                        result["size_is_estimate"] = est_approx
                    if picked_h:
                        result["picked_height"] = picked_h
                elif result["estimated_bytes"] is None and est_bytes is not None:
                    result["estimated_bytes"] = est_bytes
                    result["size_is_estimate"] = est_approx
                    if picked_h:
                        result["picked_height"] = picked_h
                if not result["duration"]:
                    result["duration"] = int(info.get('duration') or 0)
                if not result["title"] and info.get('title'):
                    result["title"] = str(info.get('title'))[:160]
                if info.get('is_live') or info.get('live_status') == 'is_live':
                    result["is_live"] = True
                if result["max_height"] >= 1080:
                    break
            except Exception as e:
                if authed and yt_account.is_rate_limit(str(e)):
                    session.limited()
                continue

        result["cookies_invalid"] = any("no longer valid" in w for w in warnings)
    except Exception:
        pass

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
