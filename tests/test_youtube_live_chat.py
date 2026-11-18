import youtube_live_chat as ylc


def test_extract_chat_messages_parses_text_paid_gift_and_dedups():
    start = 1000.0
    seen = set()
    actions = [
        # Historical message before capture start -> dropped
        {
            "addChatItemAction": {
                "item": {
                    "liveChatTextMessageRenderer": {
                        "id": "old1",
                        "timestampUsec": str(int((start - 20.0) * 1_000_000)),
                        "message": {"runs": [{"text": "old message"}]},
                    }
                }
            }
        },
        # Hype text message during capture
        {
            "addChatItemAction": {
                "item": {
                    "liveChatTextMessageRenderer": {
                        "id": "m1",
                        "timestampUsec": str(int((start + 12.5) * 1_000_000)),
                        "message": {"runs": [{"text": "OMG NO WAY!!! "}, {"emoji": {"emojiId": "🔥"}}]},
                    }
                }
            }
        },
        # Duplicate id -> skipped
        {
            "addChatItemAction": {
                "item": {
                    "liveChatTextMessageRenderer": {
                        "id": "m1",
                        "timestampUsec": str(int((start + 12.5) * 1_000_000)),
                        "message": {"runs": [{"text": "OMG NO WAY!!!"}]},
                    }
                }
            }
        },
        # Super Chat -> high weight
        {
            "addChatItemAction": {
                "item": {
                    "liveChatPaidMessageRenderer": {
                        "id": "p1",
                        "timestampUsec": str(int((start + 15.0) * 1_000_000)),
                        "purchaseAmountText": {"simpleText": "$5.00"},
                        "message": {"runs": [{"text": "CLIP THAT!!"}]},
                    }
                }
            }
        },
        # Live Gift
        {
            "addChatItemAction": {
                "item": {
                    "giftMessageViewModel": {
                        "id": "g1",
                        "text": {"content": "sent Gold coin"},
                    }
                }
            }
        },
        # System notice -> ignored
        {
            "addChatItemAction": {
                "item": {
                    "liveChatViewerEngagementMessageRenderer": {"id": "sys1"}
                }
            }
        },
    ]

    msgs = ylc.extract_chat_messages(actions, start, seen, now_epoch=start + 16.0)
    assert len(msgs) == 3
    assert msgs[0]["offset"] == 12.5
    assert msgs[0]["weight"] > 1.5  # hype + caps boost
    assert msgs[1]["kind"] == "paid" and msgs[1]["weight"] == 3.0 and "$5.00" in msgs[1]["text"]
    assert msgs[2]["kind"] == "gift" and msgs[2]["offset"] == 16.0


def test_detect_hype_moments_finds_spike_and_leads_earlier():
    # Steady baseline: 1 message every 10s across 180s, then a big explosion at 90-100s
    msgs = [{"offset": float(t), "text": "nice", "weight": 1.0, "kind": "text"} for t in range(5, 180, 10)]
    for i in range(12):
        msgs.append({"offset": 91.0 + i * 0.5, "text": f"OMG CRAZY #{i} 🔥", "weight": 1.5, "kind": "text"})

    moments = ylc.detect_hype_moments(msgs, video_duration=180.0, bucket_seconds=10.0, lead_seconds=6.0)
    assert len(moments) >= 1
    top = moments[0]
    # Spike was in bucket 90..100s -> shifted earlier by 6s -> starts at 84.0s
    assert top["start"] == 84.0
    assert top["end"] >= 100.0
    assert top["messages"] >= 12
    assert top["spike_ratio"] >= 4.0
    assert len(top["sample_chat"]) >= 3


def test_chat_window_heat_and_promotion():
    windows = [
        {"id": "w0", "start": 0.0, "end": 90.0, "text": "intro"},
        {"id": "w1", "start": 90.0, "end": 180.0, "text": "action"},
        {"id": "w2", "start": 180.0, "end": 270.0, "text": "calm"},
    ]
    hype = [{"start": 110.0, "end": 135.0, "messages": 25, "spike_ratio": 5.0, "score": 32.0, "sample_chat": ["W", "CLIP THAT"]}]
    heat = ylc.chat_window_heat(windows, hype)
    assert "w1" in heat
    assert heat["w1"]["messages"] == 25
    assert heat["w1"]["sample_chat"] == ["W", "CLIP THAT"]

    # Suppose AI shortlist only picked w0 and w2; promotion must swap in w1
    shortlist = [windows[0], windows[2]]
    promoted = ylc.promote_chat_hot_windows(shortlist, windows, heat, target=2)
    assert any(w["id"] == "w1" for w in promoted)
    assert len(promoted) == 2
