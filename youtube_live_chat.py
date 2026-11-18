"""Live YouTube chat watcher and hype-moment detector for livestream clipping.

While ``main.py`` captures a bounded window of a live YouTube broadcast,
``LiveChatWatcher`` polls YouTube's public Innertube ``live_chat/get_live_chat``
endpoint in the background (no API key or extra pip dependency needed).

Every incoming chat message, Super Chat, and Live Gift is stamped with its
offset in seconds from capture start. When capture finishes,
``detect_hype_moments`` finds message-velocity & reaction bursts (shifted a few
seconds earlier to include the on-screen trigger before chat reacted) and turns
them into window heat signals for ``main.get_viral_clips`` — just like
``twitch_signals`` does for Twitch VOD viewer clips.

Everything here is best-effort: if chat is disabled or unreachable, the job
still clips normally from the transcript/video without failing.
"""
import re
import statistics
import threading
import time
from typing import Dict, List, Optional, Tuple

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# High-energy reaction tokens across English + common gaming/stream shorthand.
_HYPE_RE = re.compile(
    r"(?i)\b(?:omg|omfg|wtf|lmao+|lmfao+|lol+|rofl|bruh|bro+|insane|crazy|"
    r"no\s*way|clip\s*(?:it|that)?|sheesh|goat|clutch|crazy|epic|wow+|"
    r"fire|op|gg+|rip|cooked|cinema|peak|mass|verithanam|semma|thalaiva|vera\s*level)\b"
    r"|[!?]{2,}|[🔥😂🤣💀😱🤯⚡👑💯🎉❤️😍🙌😭]+|(?:^|\s)[WwLl]{1,3}(?:\s|$)"
)


def _runs_to_text(runs) -> str:
    parts = []
    for r in runs or []:
        if not isinstance(r, dict):
            continue
        if "text" in r:
            parts.append(str(r["text"]))
        elif "emoji" in r and isinstance(r["emoji"], dict):
            emo = r["emoji"]
            eid = str(emo.get("emojiId") or "")
            shortcut = str((emo.get("shortcuts") or [""])[0] or "")
            # Custom channel emotes have long "UC.../<id>" emojiIds — use their readable shortcut.
            token = shortcut if ("/" in eid and shortcut) else (eid or shortcut)
            if token and "/" not in token:
                parts.append(token)
    return "".join(parts).strip()


def _message_weight(text: str, kind: str) -> float:
    if kind == "paid":
        return 3.0
    if kind == "gift":
        return 1.5
    if kind == "membership":
        return 2.0
    w = 1.0
    if text:
        if _HYPE_RE.search(text):
            w += 0.5
        letters = [c for c in text if c.isalpha()]
        if len(letters) >= 4 and sum(1 for c in letters if c.isupper()) / len(letters) >= 0.7:
            w += 0.35
    return w


def extract_chat_messages(
    actions: list,
    capture_start_epoch: float,
    seen_ids: set,
    now_epoch: Optional[float] = None,
) -> List[dict]:
    """Parse Innertube ``liveChatContinuation.actions`` into normalized events.

    Returns ``[{"offset": float, "text": str, "weight": float, "kind": str}]``
    for messages arriving during the capture window.
    """
    now = time.time() if now_epoch is None else float(now_epoch)
    out = []
    for action in actions or []:
        if not isinstance(action, dict):
            continue
        add = action.get("addChatItemAction")
        if not isinstance(add, dict):
            continue
        item = add.get("item")
        if not isinstance(item, dict):
            continue

        msg_id = None
        text = ""
        kind = None
        ts_usec = None

        if "liveChatTextMessageRenderer" in item:
            rm = item["liveChatTextMessageRenderer"] or {}
            msg_id = rm.get("id")
            text = _runs_to_text((rm.get("message") or {}).get("runs"))
            ts_usec = rm.get("timestampUsec")
            kind = "text"
        elif "liveChatPaidMessageRenderer" in item:
            rm = item["liveChatPaidMessageRenderer"] or {}
            msg_id = rm.get("id")
            amt = ((rm.get("purchaseAmountText") or {}).get("simpleText") or "").strip()
            body = _runs_to_text((rm.get("message") or {}).get("runs"))
            text = f"[SuperChat {amt}] {body}".strip() if amt else (body or "[SuperChat]")
            ts_usec = rm.get("timestampUsec")
            kind = "paid"
        elif "giftMessageViewModel" in item:
            gm = item["giftMessageViewModel"] or {}
            msg_id = gm.get("id")
            text = ((gm.get("text") or {}).get("content") or "sent a gift").strip()
            kind = "gift"
        elif "liveChatMembershipItemRenderer" in item:
            rm = item["liveChatMembershipItemRenderer"] or {}
            msg_id = rm.get("id")
            text = _runs_to_text((rm.get("headerSubtext") or {}).get("runs")) or "joined membership"
            ts_usec = rm.get("timestampUsec")
            kind = "membership"
        else:
            continue

        if msg_id:
            if msg_id in seen_ids:
                continue
            seen_ids.add(msg_id)

        if ts_usec is not None:
            try:
                msg_epoch = int(ts_usec) / 1_000_000.0
            except (TypeError, ValueError):
                msg_epoch = now
        else:
            msg_epoch = now

        offset = msg_epoch - float(capture_start_epoch)
        # Drop older backfill messages from before the live capture began.
        if offset < -5.0:
            continue
        offset = max(0.0, offset)

        out.append({
            "offset": round(offset, 2),
            "text": text[:160],
            "weight": round(_message_weight(text, kind), 2),
            "kind": kind,
        })
    return out


def _next_continuation(lcc: dict) -> Tuple[Optional[str], float]:
    """Return ``(continuation_token, delay_seconds)`` from ``liveChatContinuation``."""
    for entry in (lcc or {}).get("continuations") or []:
        if not isinstance(entry, dict):
            continue
        for key in ("invalidationContinuationData", "timedContinuationData", "reloadContinuationData"):
            data = entry.get(key)
            if isinstance(data, dict) and data.get("continuation"):
                ms = data.get("timeoutMs") or 2500
                try:
                    delay = max(1.2, min(4.0, float(ms) / 1000.0))
                except (TypeError, ValueError):
                    delay = 2.5
                return str(data["continuation"]), delay
    return None, 2.5


def detect_hype_moments(
    messages: List[dict],
    video_duration: float,
    bucket_seconds: float = 10.0,
    lead_seconds: float = 6.0,
) -> List[dict]:
    """Find chat hype spikes from timestamped messages.

    Shifts each detected spike window earlier by ``lead_seconds`` because live
    chat erupts 3–8 seconds *after* the exciting moment happens on screen.
    Returns hype moments sorted strongest-first:
    ``[{"start", "end", "messages", "spike_ratio", "score", "sample_chat"}]``.
    """
    dur = float(video_duration or 0)
    if not messages or dur <= 0:
        return []

    n_buckets = max(1, int(dur // bucket_seconds) + 1)
    buckets = [{"weight": 0.0, "count": 0, "texts": []} for _ in range(n_buckets)]

    for m in messages:
        try:
            off = float(m.get("offset", -1))
        except (TypeError, ValueError):
            continue
        if off < 0 or off > dur + 5.0:
            continue
        idx = min(n_buckets - 1, max(0, int(off // bucket_seconds)))
        b = buckets[idx]
        b["weight"] += float(m.get("weight") or 1.0)
        b["count"] += 1
        txt = (m.get("text") or "").strip()
        if txt and m.get("kind") != "gift":
            b["texts"].append(txt)

    active_weights = [b["weight"] for b in buckets if b["count"] > 0]
    if not active_weights:
        return []

    baseline = max(2.0, float(statistics.median(active_weights)))
    # Threshold: clearly above normal chat pace, with a sensible floor for quieter streams.
    threshold = max(3.5, baseline * 1.45)

    hot_indices = [i for i, b in enumerate(buckets) if b["weight"] >= threshold]
    # If chat was uniformly busy with no sharp spike above 1.45x, still surface the top peaks.
    if not hot_indices and sum(b["count"] for b in buckets) >= 5:
        ranked_idx = sorted(
            [i for i, b in enumerate(buckets) if b["count"] >= 2],
            key=lambda i: -buckets[i]["weight"],
        )
        hot_indices = sorted(ranked_idx[: max(1, min(4, n_buckets // 3))])

    if not hot_indices:
        return []

    # Merge contiguous or 1-bucket-apart hot buckets into cohesive hype moments.
    groups: List[List[int]] = []
    for idx in hot_indices:
        if groups and idx <= groups[-1][-1] + 1:
            groups[-1].append(idx)
        else:
            groups.append([idx])

    moments = []
    for g in groups:
        raw_start = g[0] * bucket_seconds
        raw_end = min(dur, (g[-1] + 1) * bucket_seconds)
        start = round(max(0.0, raw_start - lead_seconds), 2)
        end = round(min(dur, raw_end + 4.0), 2)
        total_msgs = sum(buckets[i]["count"] for i in g)
        peak_w = max(buckets[i]["weight"] for i in g)
        total_w = sum(buckets[i]["weight"] for i in g)
        ratio = round(peak_w / baseline, 2)

        # Pick diverse, non-duplicate sample reactions for the AI prompt.
        seen_txt = set()
        samples = []
        for i in g:
            for t in buckets[i]["texts"]:
                norm = t.lower()
                if norm in seen_txt:
                    continue
                seen_txt.add(norm)
                samples.append(t)
                if len(samples) >= 6:
                    break
            if len(samples) >= 6:
                break

        moments.append({
            "start": start,
            "end": end,
            "messages": total_msgs,
            "spike_ratio": ratio,
            "score": round(total_w, 2),
            "sample_chat": samples,
        })

    moments.sort(key=lambda m: (-m["score"], -m["messages"]))
    return moments


def chat_window_heat(windows: List[dict], hype_moments: List[dict]) -> Dict[str, dict]:
    """Map detected chat hype moments onto ``main.py`` transcript windows."""
    heat: Dict[str, dict] = {}
    for m in hype_moments or []:
        mid = (float(m["start"]) + float(m["end"])) / 2.0
        for w in windows:
            if w["start"] <= mid < w["end"] or (mid == w["end"] and w is windows[-1]):
                h = heat.setdefault(w["id"], {
                    "messages": 0,
                    "spike_ratio": 0.0,
                    "score": 0.0,
                    "spans": [],
                    "sample_chat": [],
                })
                h["messages"] += int(m.get("messages") or 0)
                h["spike_ratio"] = max(h["spike_ratio"], float(m.get("spike_ratio") or 0.0))
                h["score"] += float(m.get("score") or 0.0)
                h["spans"].append([m["start"], m["end"]])
                for s in m.get("sample_chat") or []:
                    if s not in h["sample_chat"] and len(h["sample_chat"]) < 6:
                        h["sample_chat"].append(s)
                break
    for h in heat.values():
        h["spans"].sort()
    return heat


def promote_chat_hot_windows(
    shortlist: List[dict],
    scored_order: List[dict],
    chat_heat: Dict[str, dict],
    target: int,
) -> List[dict]:
    """Ensure top live-chat hype windows always make the detail shortlist."""
    if not chat_heat or target <= 0:
        return shortlist
    # Reserve up to half of the shortlist (at least 1) for the biggest chat spikes.
    reserve = max(1, target // 2)
    hottest = sorted(chat_heat.items(), key=lambda kv: (-kv[1]["score"], -kv[1]["messages"]))
    by_id = {w["id"]: w for w in scored_order}
    out = list(shortlist)
    have = {w["id"] for w in out}
    promoted = 0
    for wid, _ in hottest:
        if promoted >= reserve:
            break
        if wid in have or wid not in by_id:
            continue
        if len(out) < target:
            out.append(by_id[wid])
        else:
            for i in range(len(out) - 1, -1, -1):
                if out[i]["id"] not in chat_heat:
                    del out[i]
                    out.append(by_id[wid])
                    break
            else:
                break
        have.add(wid)
        promoted += 1
    return out


class LiveChatWatcher:
    """Background YouTube live chat collector bound to a live capture session."""

    def __init__(self, url: str, capture_start_epoch: Optional[float] = None):
        self.url = url
        self.capture_start_epoch = (
            time.time() if capture_start_epoch is None else float(capture_start_epoch)
        )
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._messages: List[dict] = []
        self._seen_ids: set = set()
        self._thread: Optional[threading.Thread] = None
        self.connected = False
        self.error: Optional[str] = None

    @property
    def total_messages(self) -> int:
        with self._lock:
            return len(self._messages)

    @property
    def messages(self) -> List[dict]:
        with self._lock:
            return list(self._messages)

    def live_spike_count(self) -> int:
        elapsed = max(10.0, time.time() - self.capture_start_epoch)
        msgs = self.messages
        if len(msgs) < 5:
            return 0
        return len(detect_hype_moments(msgs, elapsed))

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 4.0) -> List[dict]:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
        return self.messages

    def _run(self) -> None:
        import httpx
        import ssrf_guard

        try:
            with ssrf_guard.guarded(), httpx.Client(
                headers={"User-Agent": _UA},
                follow_redirects=True,
                timeout=15.0,
            ) as client:
                r = client.get(self.url)
                if r.status_code != 200:
                    self.error = f"HTTP {r.status_code}"
                    return
                html = r.text
                m_key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
                if not m_key:
                    self.error = "No Innertube API key found"
                    return
                api_key = m_key.group(1)
                m_ver = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html)
                client_ver = m_ver.group(1) if m_ver else "2.20261116.00.00"
                conts = re.findall(r'"continuation":"([^"]+)"', html)
                if not conts:
                    self.error = "Live chat appears disabled on this stream"
                    return

                endpoint = f"https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key={api_key}"
                context = {"client": {"clientName": "WEB", "clientVersion": client_ver}}

                # Find the continuation token that belongs to liveChatContinuation.
                continuation = None
                delay = 2.0
                for cand in conts[:10]:
                    if self._stop.is_set():
                        return
                    resp = client.post(endpoint, json={"context": context, "continuation": cand})
                    if resp.status_code != 200:
                        continue
                    data = resp.json() or {}
                    lcc = (data.get("continuationContents") or {}).get("liveChatContinuation")
                    if not lcc:
                        continue
                    self.connected = True
                    print("💬 Connected to YouTube live chat — watching for hype moments!", flush=True)
                    # Seed seen_ids from the initial backfill without counting
                    # pre-capture gifts/messages as a t=0 spike; keep only items
                    # whose real timestampUsec falls inside our capture window.
                    initial_actions = lcc.get("actions") or []
                    for a in initial_actions:
                        item = (a.get("addChatItemAction") or {}).get("item") or {}
                        for renderer in item.values():
                            if isinstance(renderer, dict) and renderer.get("id"):
                                if renderer.get("timestampUsec") is None:
                                    self._seen_ids.add(renderer["id"])
                    batch = extract_chat_messages(
                        initial_actions, self.capture_start_epoch, self._seen_ids
                    )
                    if batch:
                        with self._lock:
                            self._messages.extend(batch)
                    continuation, delay = _next_continuation(lcc)
                    break

                if not self.connected:
                    self.error = "Live chat not available for this broadcast"
                    return

                while continuation and not self._stop.is_set():
                    if self._stop.wait(delay):
                        break
                    try:
                        resp = client.post(endpoint, json={"context": context, "continuation": continuation})
                        if resp.status_code != 200:
                            delay = min(5.0, delay + 1.0)
                            continue
                        data = resp.json() or {}
                        lcc = (data.get("continuationContents") or {}).get("liveChatContinuation")
                        if not lcc:
                            break
                        batch = extract_chat_messages(
                            lcc.get("actions") or [], self.capture_start_epoch, self._seen_ids
                        )
                        if batch:
                            with self._lock:
                                self._messages.extend(batch)
                        continuation, delay = _next_continuation(lcc)
                    except Exception:
                        delay = min(5.0, delay + 1.0)
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"
            print(f"   ℹ️ Live chat watcher unavailable ({self.error}).", flush=True)


def fetch_recent_chat_for_rewind(
    url: str,
    window_start_epoch: float,
    window_duration: float,
    timeout: float = 12.0,
) -> Tuple[List[dict], List[dict]]:
    """Best-effort fetch of recent timestamped live chat messages for a DVR rewind window.

    Returns ``(messages, hype_moments)`` aligned to ``window_start_epoch`` (0..window_duration).
    Only items with an explicit ``timestampUsec`` inside the rewind window are kept.
    """
    import httpx
    import ssrf_guard

    try:
        with ssrf_guard.guarded(), httpx.Client(
            headers={"User-Agent": _UA},
            follow_redirects=True,
            timeout=timeout,
        ) as client:
            r = client.get(url)
            if r.status_code != 200:
                return [], []
            html = r.text
            m_key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
            if not m_key:
                return [], []
            api_key = m_key.group(1)
            m_ver = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html)
            client_ver = m_ver.group(1) if m_ver else "2.20261116.00.00"
            conts = re.findall(r'"continuation":"([^"]+)"', html)
            endpoint = f"https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key={api_key}"
            context = {"client": {"clientName": "WEB", "clientVersion": client_ver}}

            for cand in conts[:10]:
                resp = client.post(endpoint, json={"context": context, "continuation": cand})
                if resp.status_code != 200:
                    continue
                data = resp.json() or {}
                lcc = (data.get("continuationContents") or {}).get("liveChatContinuation")
                if not lcc:
                    continue
                # Keep only items with explicit timestampUsec so backfill gifts
                # without timestamps never pollute the rewind timeline.
                actions = []
                for a in lcc.get("actions") or []:
                    item = (a.get("addChatItemAction") or {}).get("item") or {}
                    if any(
                        isinstance(v, dict) and v.get("timestampUsec") is not None
                        for v in item.values()
                    ):
                        actions.append(a)
                seen: set = set()
                msgs = extract_chat_messages(actions, window_start_epoch, seen)
                hype = detect_hype_moments(msgs, window_duration) if msgs else []
                return msgs, hype
    except Exception:
        pass
    return [], []

