import json
import pytest


def test_build_download_progress_with_total_bytes():
    main = pytest.importorskip("main")  # needs cv2/scenedetect, absent in minimal CI
    _build_download_progress = main._build_download_progress

    out = _build_download_progress({
        "status": "downloading",
        "downloaded_bytes": 50_000_000,
        "total_bytes": 200_000_000,
        "speed": 12_500_000.4,
        "eta": 12.2,
        "info_dict": {"vcodec": "avc1.640028", "acodec": "none"},
    })
    assert out == {
        "status": "downloading",
        "percent": 25.0,
        "downloaded_bytes": 50_000_000,
        "total_bytes": 200_000_000,
        "speed": 12_500_000,
        "eta": 12,
        "stream": "video",
    }


def test_build_download_progress_audio_and_estimate():
    main = pytest.importorskip("main")
    _build_download_progress = main._build_download_progress

    out = _build_download_progress({
        "status": "downloading",
        "downloaded_bytes": 5_000_000,
        "total_bytes_estimate": 10_000_000,
        "info_dict": {"vcodec": "none", "acodec": "mp4a.40.2"},
    })
    assert out["stream"] == "audio"
    assert out["percent"] == 50.0
    assert out["total_bytes"] == 10_000_000
    assert out["speed"] is None
    assert out["eta"] is None


def test_build_download_progress_fragments_when_total_unknown():
    main = pytest.importorskip("main")
    _build_download_progress = main._build_download_progress

    out = _build_download_progress({
        "status": "downloading",
        "downloaded_bytes": 4_000_000,
        "fragment_index": 3,
        "fragment_count": 10,
    })
    assert out["percent"] == 30.0
    assert out["fragment_index"] == 3
    assert out["fragment_count"] == 10


def test_build_download_progress_finished_becomes_merging():
    main = pytest.importorskip("main")
    _build_download_progress = main._build_download_progress

    out = _build_download_progress({
        "status": "finished",
        "downloaded_bytes": 123_456_789,
        "total_bytes": 123_456_789,
    })
    assert out["status"] == "merging"
    assert out["percent"] == 100.0
    assert out["downloaded_bytes"] == 123_456_789
    assert out["total_bytes"] == 123_456_789


def test_handle_job_line_tracks_download_progress_off_logs():
    import app

    job_id = "test_dl_progress_job"
    app.jobs[job_id] = {"status": "processing", "logs": app._TimedLog()}
    try:
        payload = {
            "status": "downloading",
            "percent": 42.5,
            "downloaded_bytes": 42_500_000,
            "total_bytes": 100_000_000,
            "speed": 10_000_000,
            "eta": 6,
            "stream": "video",
        }
        app._handle_job_line(job_id, "DOWNLOAD_PROGRESS=" + json.dumps(payload))
        assert app.jobs[job_id]["download_progress"] == payload
        assert list(app.jobs[job_id]["logs"]) == []

        # Remote workers cannot overwrite this host's download_progress marker.
        spoofed = {**payload, "percent": 99.0}
        app._handle_job_line(job_id, "DOWNLOAD_PROGRESS=" + json.dumps(spoofed), remote=True)
        assert app.jobs[job_id]["download_progress"] == payload
    finally:
        app.jobs.pop(job_id, None)


def test_estimate_download_size_prefers_1080p_avc1_plus_m4a():
    from quality_probe import estimate_download_size

    info = {
        "duration": 600,
        "formats": [
            {"vcodec": "vp9", "acodec": "none", "height": 2160, "ext": "webm", "filesize": 900_000_000},
            {"vcodec": "avc1.640028", "acodec": "none", "height": 1080, "ext": "mp4", "filesize": 300_000_000},
            {"vcodec": "avc1.4d401f", "acodec": "none", "height": 720, "ext": "mp4", "filesize": 150_000_000},
            {"vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "abr": 128, "filesize": 10_000_000},
        ],
    }
    est_bytes, is_est, picked_h = estimate_download_size(info)
    assert est_bytes == 310_000_000
    assert is_est is False
    assert picked_h == 1080


def test_estimate_download_size_falls_back_to_bitrate_estimate():
    from quality_probe import estimate_download_size

    info = {
        "duration": 100,
        "formats": [
            {"vcodec": "avc1.64001f", "acodec": "none", "height": 720, "ext": "mp4", "tbr": 2000},
            {"vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "abr": 128},
        ],
    }
    est_bytes, is_est, picked_h = estimate_download_size(info)
    # (2000 + 128) kbps * 1000 / 8 * 100s = 26,600,000 bytes
    assert est_bytes == 26_600_000
    assert is_est is True
    assert picked_h == 720


def test_estimate_download_size_progressive_fallback():
    from quality_probe import estimate_download_size

    info = {
        "duration": 60,
        "formats": [
            {"vcodec": "avc1", "acodec": "mp4a", "height": 720, "ext": "mp4", "filesize_approx": 42_000_000},
        ],
    }
    est_bytes, is_est, picked_h = estimate_download_size(info)
    assert est_bytes == 42_000_000
    assert is_est is True
    assert picked_h == 720


def test_retry_failed_job_reuses_source_and_checkpoint(tmp_path, monkeypatch):
    import app
    from fastapi.testclient import TestClient

    job_id = "retry_test_job_1234"
    out_dir = tmp_path / "output"
    job_dir = out_dir / job_id
    job_dir.mkdir(parents=True)
    src_video = job_dir / "sample.mp4"
    src_video.write_bytes(b"\x00" * 16)
    (job_dir / ".transcript_checkpoint.json").write_text('{"source":{},"transcript":{"segments":[{}]}}')
    (job_dir / ".cancelled").write_text("1")

    enqueued = []
    monkeypatch.setattr(app, "OUTPUT_DIR", str(out_dir))
    monkeypatch.setattr(app, "BILLING_ENABLED", False)
    monkeypatch.setattr(app, "_enqueue_job", lambda jid, prio=2: enqueued.append((jid, prio)))
    app.jobs.pop(job_id, None)
    app._cancelled_jobs.add(job_id)

    try:
        client = TestClient(app.app)
        res = client.post(f"/api/jobs/{job_id}/retry", headers={"X-Gemini-Key": "test-key-123"})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["ok"] is True
        assert body["status"] == "queued"
        assert body["has_transcript_checkpoint"] is True
        assert enqueued == [(job_id, 2)]
        assert job_id not in app._cancelled_jobs
        assert not (job_dir / ".cancelled").exists()
        assert app.jobs[job_id]["env"]["GEMINI_API_KEY"] == "test-key-123"
        assert "-i" in app.jobs[job_id]["cmd"]

        # Retrying an already queued job must return 409 Conflict.
        res2 = client.post(f"/api/jobs/{job_id}/retry", headers={"X-Gemini-Key": "test-key-123"})
        assert res2.status_code == 409
    finally:
        app.jobs.pop(job_id, None)
        app._cancelled_jobs.discard(job_id)

