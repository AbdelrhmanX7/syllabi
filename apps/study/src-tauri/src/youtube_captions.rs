//! YouTube captions fetched from the tablet.
//!
//! YouTube blocks the production server's IP, so the backend cannot pull captions itself; the
//! shell asks YouTube from the device (where the owner watches the videos anyway) and the app
//! uploads the result (`PUT /study/videos/:itemId/transcript`). Two requests: the innertube
//! `player` endpoint for the caption track list, then the chosen track as `json3`, parsed into
//! sentence-sized segments. The json3 parser and the merge are mirrored in
//! `lib/youtube/captions.ts`, whose unit tests cover the same rules.

use serde::Serialize;
use serde_json::{json, Value};

const PLAYER_URL: &str = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
/// The official Android app, as innertube sees it. The player endpoint answers this client with
/// playable streams AND the caption track list, with no sign-in, API key or proof-of-origin token
/// (WEB/MWEB/embedded answer UNPLAYABLE or LOGIN_REQUIRED without one; iOS wants a device token).
/// A version too far behind the current release is refused with FAILED_PRECONDITION, so two recent
/// ones are tried in order — bump the first when both start failing.
const ANDROID_VERSIONS: [&str; 2] = ["20.10.38", "19.44.38"];
const WEB_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

fn android_ua(version: &str) -> String {
    format!("com.google.android.youtube/{version} (Linux; U; Android 11) gzip")
}

/// Close a merged segment once it runs this long…
const MAX_SEGMENT_SECS: f64 = 8.0;
/// …or holds this many characters.
const MAX_SEGMENT_CHARS: usize = 160;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CaptionSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Captions {
    pub segments: Vec<CaptionSegment>,
    /// BCP-47 as YouTube reports it (`en`, `en-US`).
    pub lang: String,
    pub duration_sec: Option<f64>,
    /// `manual` = uploaded by the channel, `asr` = YouTube's automatic track.
    pub kind: String,
}

/* ------------------------------------------------------------------ parsing (pure) */

/// One caption event → one fragment (text with newlines flattened). Blank events and the
/// rolling "append" events of ASR tracks (they repeat text already emitted) are dropped.
pub fn parse_json3(doc: &Value) -> Vec<CaptionSegment> {
    let Some(events) = doc.get("events").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut fragments = Vec::new();

    for (index, event) in events.iter().enumerate() {
        if event.get("aAppend").and_then(Value::as_i64) == Some(1) {
            continue;
        }
        let Some(segs) = event.get("segs").and_then(Value::as_array) else {
            continue;
        };
        let raw: String = segs
            .iter()
            .filter_map(|seg| seg.get("utf8").and_then(Value::as_str))
            .collect();
        let text = collapse_whitespace(&raw);

        if text.is_empty() {
            continue;
        }
        let start_ms = event.get("tStartMs").and_then(Value::as_f64).unwrap_or(0.0);
        let end_ms = match event.get("dDurationMs").and_then(Value::as_f64) {
            Some(duration) => start_ms + duration,
            // No duration: run until the next timed event, or two seconds.
            None => events[index + 1..]
                .iter()
                .find_map(|candidate| candidate.get("tStartMs").and_then(Value::as_f64))
                .unwrap_or(start_ms + 2_000.0),
        };

        fragments.push(CaptionSegment {
            start: start_ms / 1000.0,
            end: end_ms.max(start_ms) / 1000.0,
            text,
        });
    }

    // ASR cues overlap on purpose (each stays on screen while the next rolls in); for a transcript
    // one cue ends where the next begins.
    for index in 1..fragments.len() {
        let next_start = fragments[index].start;
        let previous = &mut fragments[index - 1];

        if next_start > previous.start && previous.end > next_start {
            previous.end = next_start;
        }
    }

    fragments
}

/// Caption events are display cues (a line or a few words each); study wants sentence-sized
/// segments. Fragments are glued together until one ends a sentence, or the glue would exceed
/// the duration/character caps.
pub fn merge_segments(fragments: Vec<CaptionSegment>) -> Vec<CaptionSegment> {
    let mut merged: Vec<CaptionSegment> = Vec::new();
    let mut current: Option<CaptionSegment> = None;

    for fragment in fragments {
        current = Some(match current.take() {
            None => fragment,
            Some(acc) => {
                let glued = format!("{} {}", acc.text, fragment.text);
                let too_long = fragment.end - acc.start > MAX_SEGMENT_SECS || glued.chars().count() > MAX_SEGMENT_CHARS;

                if too_long {
                    merged.push(acc);
                    fragment
                } else {
                    CaptionSegment {
                        start: acc.start,
                        end: acc.end.max(fragment.end),
                        text: glued,
                    }
                }
            }
        });

        if current.as_ref().is_some_and(|segment| ends_sentence(&segment.text)) {
            merged.extend(current.take());
        }
    }

    merged.extend(current.take());

    for segment in &mut merged {
        segment.start = (segment.start * 1000.0).round() / 1000.0;
        segment.end = (segment.end * 1000.0).round() / 1000.0;
    }

    merged
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `.`, `!`, `?` or `…`, optionally followed by one closing quote/bracket.
fn ends_sentence(text: &str) -> bool {
    let trimmed = text.trim_end_matches(['"', '\'', ')', ']']);

    trimmed.ends_with(['.', '!', '?', '…'])
}

/// Prefer the channel's own English track, then any manual track, then English ASR, then whatever
/// the video has. Returns `(base_url, language_code, kind)`.
pub fn pick_track(tracks: &[Value]) -> Option<(String, String, &'static str)> {
    let describe = |track: &Value| -> Option<(String, String, bool)> {
        let url = track.get("baseUrl")?.as_str()?.to_string();
        let lang = track
            .get("languageCode")
            .and_then(Value::as_str)
            .unwrap_or("und")
            .to_string();
        let asr = track.get("kind").and_then(Value::as_str) == Some("asr");

        Some((url, lang, asr))
    };
    let described: Vec<_> = tracks.iter().filter_map(describe).collect();
    let is_english = |lang: &str| lang == "en" || lang.starts_with("en-");
    let pick = |predicate: &dyn Fn(&(String, String, bool)) -> bool| {
        described
            .iter()
            .find(|track| predicate(track))
            .map(|(url, lang, asr)| (url.clone(), lang.clone(), if *asr { "asr" } else { "manual" }))
    };

    pick(&|(_, lang, asr)| !asr && is_english(lang))
        .or_else(|| pick(&|(_, _, asr)| !asr))
        .or_else(|| pick(&|(_, lang, asr)| *asr && is_english(lang)))
        .or_else(|| pick(&|_| true))
}

/* ------------------------------------------------------------------ fetching */

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build()
}

fn android_player(agent: &ureq::Agent, video_id: &str, version: &str) -> Result<Value, String> {
    let ua = android_ua(version);
    let body = json!({
        "context": { "client": {
            "clientName": "ANDROID", "clientVersion": version, "androidSdkVersion": 30,
            "userAgent": ua, "hl": "en", "gl": "US", "utcOffsetMinutes": 0 } },
        "videoId": video_id, "contentCheckOk": true, "racyCheckOk": true
    });

    agent
        .post(PLAYER_URL)
        .set("User-Agent", &ua)
        .set("X-YouTube-Client-Name", "3")
        .set("X-YouTube-Client-Version", version)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|error| format!("innertube (android {version}): {error}"))
        .and_then(|res| res.into_json::<Value>().map_err(|error| format!("innertube (android {version}) body: {error}")))
}

/// Last resort: the watch page embeds the same player response as `ytInitialPlayerResponse`.
/// Its caption URLs are minted for the WEB client and come back EMPTY without a proof-of-origin
/// token, so this only rescues the track list / duration when every innertube client refused.
fn watch_page_player(agent: &ureq::Agent, video_id: &str) -> Result<Value, String> {
    let html = agent
        .get(&format!("https://www.youtube.com/watch?v={video_id}&hl=en"))
        .set("User-Agent", WEB_UA)
        .set("Accept-Language", "en-US,en;q=0.9")
        .set("Cookie", "CONSENT=YES+cb; SOCS=CAI")
        .call()
        .map_err(|error| format!("watch page: {error}"))?
        .into_string()
        .map_err(|error| format!("watch page body: {error}"))?;

    extract_initial_player_response(&html).ok_or_else(|| "watch page: no ytInitialPlayerResponse".to_string())
}

/// `ytInitialPlayerResponse = {...};` — balanced-brace scan from the first `{`, string-aware.
pub fn extract_initial_player_response(html: &str) -> Option<Value> {
    let start = html.find("ytInitialPlayerResponse")?;
    let open = start + html[start..].find('{')?;
    let bytes = html.as_bytes();
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);

    for (offset, &byte) in bytes[open..].iter().enumerate() {
        match byte {
            b'\\' if in_string => escaped = !escaped,
            b'"' if !escaped => in_string = !in_string,
            b'{' if !in_string => depth += 1,
            b'}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str(&html[open..=open + offset]).ok();
                }
            }
            _ => escaped = false,
        }
        if byte != b'\\' {
            escaped = false;
        }
    }

    None
}

fn player_response(agent: &ureq::Agent, video_id: &str) -> Result<Value, String> {
    let mut last_error = String::new();
    let mut best: Option<Value> = None;

    for version in ANDROID_VERSIONS {
        match android_player(agent, video_id, version) {
            Ok(doc) if caption_tracks(&doc).is_some() => return Ok(doc),
            Ok(doc) => {
                // Playable-but-captionless (or LOGIN_REQUIRED) — keep it for the duration, try the next.
                last_error = playability(&doc);
                best.get_or_insert(doc);
            }
            Err(error) => last_error = error,
        }
    }

    match watch_page_player(agent, video_id) {
        Ok(doc) if caption_tracks(&doc).is_some() => Ok(doc),
        Ok(doc) => Ok(best.unwrap_or(doc)),
        Err(error) => best.ok_or(format!("{last_error}; {error}")),
    }
}

fn playability(doc: &Value) -> String {
    let status = doc.pointer("/playabilityStatus/status").and_then(Value::as_str).unwrap_or("?");
    let reason = doc.pointer("/playabilityStatus/reason").and_then(Value::as_str).unwrap_or("");

    format!("playability {status} {reason}").trim_end().to_string()
}

fn caption_tracks(doc: &Value) -> Option<&Vec<Value>> {
    doc.pointer("/captions/playerCaptionsTracklistRenderer/captionTracks")
        .and_then(Value::as_array)
        .filter(|tracks| !tracks.is_empty())
}

/// The track URL already carries `fmt=srv3`; a second `fmt` is ignored, so the existing one is
/// replaced rather than appended.
pub fn with_json3_format(base_url: &str) -> String {
    let (path, query) = base_url.split_once('?').unwrap_or((base_url, ""));
    let mut params: Vec<&str> = query.split('&').filter(|pair| !pair.is_empty() && !pair.starts_with("fmt=")).collect();

    params.push("fmt=json3");

    format!("{path}?{}", params.join("&"))
}

/// `Ok(None)` when the video has no captions; `Err` when YouTube could not be reached or refused.
pub fn fetch(video_id: &str) -> Result<Option<Captions>, String> {
    if video_id.is_empty() || !video_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid video id".into());
    }
    let agent = agent();
    let player = player_response(&agent, video_id)?;
    let Some(tracks) = caption_tracks(&player) else {
        return Ok(None);
    };
    let Some((base_url, lang, kind)) = pick_track(tracks) else {
        return Ok(None);
    };
    let doc: Value = agent
        .get(&with_json3_format(&base_url))
        .set("User-Agent", &android_ua(ANDROID_VERSIONS[0]))
        .call()
        .map_err(|error| format!("timedtext: {error}"))?
        .into_json()
        .map_err(|error| format!("timedtext body: {error}"))?;
    let segments = merge_segments(parse_json3(&doc));

    if segments.is_empty() {
        return Ok(None);
    }
    let duration_sec = player
        .pointer("/videoDetails/lengthSeconds")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok());

    Ok(Some(Captions {
        segments,
        lang,
        duration_sec,
        kind: kind.to_string(),
    }))
}

/* ------------------------------------------------------------------ command */

/// `invoke('youtube_captions', { videoId })` → `Captions | null`. Blocking network work runs on
/// a worker thread so the WebView's IPC thread is never held.
#[tauri::command]
pub async fn youtube_captions(video_id: String) -> Result<Option<Captions>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch(&video_id))
        .await
        .map_err(|error| format!("captions task: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manual() -> Value {
        json!({ "events": [
            { "tStartMs": 0, "dDurationMs": 2500, "segs": [{ "utf8": "Welcome back." }] },
            { "tStartMs": 2500, "dDurationMs": 3000, "segs": [{ "utf8": "Today we look at\nclasses in C++" }] },
            { "tStartMs": 5500, "dDurationMs": 2000, "segs": [{ "utf8": "and why they matter." }] },
            { "tStartMs": 7500, "dDurationMs": 1000, "segs": [{ "utf8": "\n" }] }
        ] })
    }

    fn asr() -> Value {
        json!({ "events": [
            { "tStartMs": 0, "dDurationMs": 4000, "segs": [{ "utf8": "so" }, { "utf8": " the", "tOffsetMs": 400 }, { "utf8": " first", "tOffsetMs": 900 }] },
            { "tStartMs": 3990, "dDurationMs": 10, "aAppend": 1, "segs": [{ "utf8": "\n" }] },
            { "tStartMs": 4000, "dDurationMs": 3000, "segs": [{ "utf8": "thing" }, { "utf8": " is", "tOffsetMs": 300 }, { "utf8": " encapsulation.", "tOffsetMs": 800 }] },
            { "tStartMs": 7000, "segs": [{ "utf8": "next topic" }] },
            { "tStartMs": 9000, "dDurationMs": 1000, "segs": [{ "utf8": "is inheritance" }] }
        ] })
    }

    fn seg(start: f64, end: f64, text: &str) -> CaptionSegment {
        CaptionSegment { start, end, text: text.into() }
    }

    #[test]
    fn parses_manual_events() {
        assert_eq!(
            parse_json3(&manual()),
            vec![
                seg(0.0, 2.5, "Welcome back."),
                seg(2.5, 5.5, "Today we look at classes in C++"),
                seg(5.5, 7.5, "and why they matter."),
            ]
        );
    }

    #[test]
    fn clamps_overlapping_cues() {
        let doc = json!({ "events": [
            { "tStartMs": 1000, "dDurationMs": 5000, "segs": [{ "utf8": "one" }] },
            { "tStartMs": 3000, "dDurationMs": 5000, "segs": [{ "utf8": "two" }] },
            { "tStartMs": 9000, "dDurationMs": 1000, "segs": [{ "utf8": "three" }] }
        ] });

        assert_eq!(parse_json3(&doc), vec![seg(1.0, 3.0, "one"), seg(3.0, 8.0, "two"), seg(9.0, 10.0, "three")]);
    }

    #[test]
    fn parses_asr_events() {
        assert_eq!(
            parse_json3(&asr()),
            vec![
                seg(0.0, 4.0, "so the first"),
                seg(4.0, 7.0, "thing is encapsulation."),
                seg(7.0, 9.0, "next topic"),
                seg(9.0, 10.0, "is inheritance"),
            ]
        );
    }

    #[test]
    fn merges_to_sentences() {
        assert_eq!(
            merge_segments(parse_json3(&manual())),
            vec![seg(0.0, 2.5, "Welcome back."), seg(2.5, 7.5, "Today we look at classes in C++ and why they matter.")]
        );
    }

    #[test]
    fn caps_segment_duration() {
        let fragments = (0..6).map(|i| seg(i as f64 * 3.0, i as f64 * 3.0 + 3.0, &format!("w{i}"))).collect();

        assert_eq!(merge_segments(fragments), vec![seg(0.0, 6.0, "w0 w1"), seg(6.0, 12.0, "w2 w3"), seg(12.0, 18.0, "w4 w5")]);
    }

    /// Real YouTube, real captions — needs the network, so it is opt-in:
    ///   cargo test --lib youtube_captions -- --ignored --nocapture
    /// Ids come from the owner's Canvas classes (mock fixtures): C++, Geology ×2, Calculus ×2.
    #[test]
    #[ignore]
    fn fetches_real_captions() {
        let ids = ["VbTZt65B15Q", "AffuwyJZTQQ", "naMxvhPdi5g", "xu_5S5Vy8eQ", "KtovEUceQjM"];
        let mut failures = Vec::new();

        for id in ids {
            match fetch(id) {
                Ok(Some(captions)) => {
                    println!(
                        "{id}: {} {} · {} segments · duration {:?}",
                        captions.kind,
                        captions.lang,
                        captions.segments.len(),
                        captions.duration_sec
                    );
                    for segment in captions.segments.iter().take(2) {
                        println!("    [{:.1}–{:.1}] {}", segment.start, segment.end, segment.text);
                    }
                    assert!(!captions.segments.is_empty());
                }
                Ok(None) => {
                    println!("{id}: no captions");
                    failures.push(format!("{id}: no captions"));
                }
                Err(error) => {
                    println!("{id}: ERROR {error}");
                    failures.push(format!("{id}: {error}"));
                }
            }
        }

        assert!(failures.is_empty(), "caption fetch failed for: {failures:?}");
    }

    #[test]
    fn replaces_the_tracks_fmt_parameter() {
        assert_eq!(with_json3_format("https://x/api/timedtext?v=a&fmt=srv3&lang=en"), "https://x/api/timedtext?v=a&lang=en&fmt=json3");
        assert_eq!(with_json3_format("https://x/api/timedtext?v=a"), "https://x/api/timedtext?v=a&fmt=json3");
        assert_eq!(with_json3_format("https://x/api/timedtext"), "https://x/api/timedtext?fmt=json3");
    }

    #[test]
    fn extracts_initial_player_response_from_html() {
        // Braces and an escaped quote INSIDE a JSON string must not confuse the brace scanner.
        let html = concat!(
            "<script>var ytInitialPlayerResponse = ",
            r#"{"a":{"b":"}{\" x"},"n":[1,2]}"#,
            ";var other = {};</script>"
        );
        let doc = extract_initial_player_response(html).expect("parsed");

        assert_eq!(doc["n"][1], 2);
        assert_eq!(doc["a"]["b"], "}{\" x");
        assert!(extract_initial_player_response("<html>nothing</html>").is_none());
    }

    #[test]
    fn prefers_manual_english_then_asr() {
        let tracks = vec![
            json!({ "baseUrl": "u-fr", "languageCode": "fr" }),
            json!({ "baseUrl": "u-asr", "languageCode": "en", "kind": "asr" }),
            json!({ "baseUrl": "u-en", "languageCode": "en-US" }),
        ];

        assert_eq!(pick_track(&tracks), Some(("u-en".into(), "en-US".into(), "manual")));
        assert_eq!(pick_track(&tracks[..2]), Some(("u-fr".into(), "fr".into(), "manual")));
        assert_eq!(pick_track(&tracks[1..2]), Some(("u-asr".into(), "en".into(), "asr")));
        assert_eq!(pick_track(&[]), None);
    }
}
