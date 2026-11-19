//! Convert WebVTT without treating YouTube's rolling caption windows as new lyrics.

#[derive(Clone)]
struct Word {
    text: String,
    time: u64,
}

struct Cue {
    start: u64,
    end: u64,
    words: Vec<Word>,
}

pub(crate) fn timestamp_ms(value: &str) -> Option<u64> {
    let (time, fraction) = value.trim().split_once('.')?;
    if fraction.len() != 3 || !fraction.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let parts = time.split(':').collect::<Vec<_>>();
    if !(2..=3).contains(&parts.len())
        || parts
            .iter()
            .any(|p| p.len() < 2 || !p.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let seconds = parts.last()?.parse::<u64>().ok()?;
    let minutes = parts[parts.len() - 2].parse::<u64>().ok()?;
    if seconds >= 60 || (parts.len() == 3 && minutes >= 60) {
        return None;
    }
    let hours = if parts.len() == 3 {
        parts[0].parse::<u64>().ok()?
    } else {
        0
    };
    hours
        .checked_mul(3_600_000)?
        .checked_add(minutes.checked_mul(60_000)?)?
        .checked_add(seconds.checked_mul(1000)?)?
        .checked_add(fraction.parse::<u64>().ok()?)
}

fn decode_entities(text: &str) -> String {
    let mut output = String::new();
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        output.push_str(&rest[..at]);
        rest = &rest[at..];
        if let Some(end) = rest.find(';').filter(|end| *end <= 12) {
            let entity = &rest[1..end];
            let decoded = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                "lrm" => Some('\u{200e}'),
                "rlm" => Some('\u{200f}'),
                _ => entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                    .and_then(|n| u32::from_str_radix(n, 16).ok())
                    .and_then(char::from_u32)
                    .or_else(|| {
                        entity
                            .strip_prefix('#')
                            .and_then(|n| n.parse().ok())
                            .and_then(char::from_u32)
                    }),
            };
            if let Some(c) = decoded {
                output.push(c);
                rest = &rest[end + 1..];
                continue;
            }
        }
        output.push('&');
        rest = &rest[1..];
    }
    output.push_str(rest);
    output
}

fn words(payload: &str, start: u64, end: u64) -> Vec<Word> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut time = start;
    let mut word_time = start;
    let mut rest = payload;
    while !rest.is_empty() {
        if let Some(tag) = rest
            .strip_prefix('<')
            .and_then(|s| s.find('>').map(|end| (&s[..end], &s[end + 1..])))
        {
            if let Some(next) = timestamp_ms(tag.0).filter(|next| *next >= time && *next < end) {
                time = next;
            }
            rest = tag.1;
            continue;
        }
        let c = rest.chars().next().unwrap();
        rest = &rest[c.len_utf8()..];
        if c.is_whitespace() {
            if !word.is_empty() {
                result.push(Word {
                    text: std::mem::take(&mut word),
                    time: word_time,
                });
            }
        } else {
            if word.is_empty() {
                word_time = time;
            }
            word.push(c);
        }
    }
    if !word.is_empty() {
        result.push(Word {
            text: word,
            time: word_time,
        });
    }
    for word in &mut result {
        word.text = decode_entities(&word.text);
    }
    result
}

fn stamp(time: u64) -> String {
    format!(
        "[{:02}:{:02}.{:03}]",
        time / 60_000,
        time / 1000 % 60,
        time % 1000
    )
}

pub(crate) fn vtt_to_lrc(vtt: &str) -> String {
    if vtt.len() > 2_000_000 || !vtt.trim_start_matches('\u{feff}').starts_with("WEBVTT") {
        return String::new();
    }
    let normalized = vtt
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n");
    let mut cues = Vec::new();
    for block in normalized.split("\n\n") {
        let rows = block.lines().map(str::trim).collect::<Vec<_>>();
        if rows
            .first()
            .is_some_and(|row| row.starts_with("NOTE") || *row == "STYLE" || *row == "REGION")
        {
            continue;
        }
        let Some(index) = rows.iter().position(|row| row.contains("-->")) else {
            continue;
        };
        let Some((start, end)) = rows[index].split_once("-->") else {
            continue;
        };
        let (Some(start), Some(end)) = (
            timestamp_ms(start),
            end.split_whitespace().next().and_then(timestamp_ms),
        ) else {
            continue;
        };
        if end <= start {
            continue;
        }
        let words = words(&rows[index + 1..].join(" "), start, end);
        if !words.is_empty() {
            cues.push(Cue { start, end, words });
        }
    }
    cues.sort_by_key(|cue| cue.start);
    let rolling = cues
        .iter()
        .any(|cue| cue.words.iter().any(|word| word.time > cue.start));
    let mut lines: Vec<(u64, u64, String)> = Vec::new();
    let mut previous: Option<Cue> = None;
    for cue in cues {
        // Only remove a suffix carried over by an overlapping window. A chorus
        // repeated later (or a back-to-back repeated word) must remain intact.
        let overlap = previous
            .as_ref()
            .filter(|p| cue.start < p.end || (rolling && cue.start <= p.end.saturating_add(50)))
            .map_or(0, |p| {
                (1..=p.words.len().min(cue.words.len()))
                    .rev()
                    .find(|&size| {
                        (size >= 2 || size == cue.words.len())
                            && cue.words[..size].iter().all(|word| word.time == cue.start)
                            && p.words[p.words.len() - size..]
                                .iter()
                                .zip(&cue.words[..size])
                                .all(|(a, b)| a.text == b.text)
                    })
                    .unwrap_or(0)
            });
        if overlap > 0 {
            if let Some(last) = lines.last_mut() {
                last.1 = last.1.max(cue.end);
            }
        }
        let fresh = &cue.words[overlap..];
        if let Some(first) = fresh.first() {
            let text = fresh
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(last) = lines.last_mut().filter(|last| last.0 == first.time) {
                last.2.push(' ');
                last.2.push_str(&text);
                last.1 = last.1.max(cue.end);
            } else {
                lines.push((first.time, cue.end, text));
            }
        }
        previous = Some(cue);
    }
    if lines.is_empty() {
        return String::new();
    }
    lines.sort_by_key(|line| line.0);
    // A marker lets the app identify captions as captions rather than vetted lyrics.
    let mut output = String::from("[re:MichoPlay YouTube captions v2]\n");
    for (index, (start, end, text)) in lines.iter().enumerate() {
        output.push_str(&format!("{}{text}\n", stamp(*start)));
        if lines
            .get(index + 1)
            .is_none_or(|next| next.0 > end.saturating_add(250))
        {
            output.push_str(&format!("{}\n", stamp(*end)));
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caption_regressions() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/captions.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                vtt_to_lrc(case["vtt"].as_str().unwrap()),
                case["lrc"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn timestamps_reject_invalid_and_overflowing_values() {
        for invalid in [
            "00:60.000",
            "01:60:00.000",
            "00:01.x",
            "00:01.0000",
            "-1:01.000",
            "99999999999999999999:00:00.000",
        ] {
            assert_eq!(timestamp_ms(invalid), None, "{invalid}");
        }
        assert_eq!(timestamp_ms("01:02:03.456"), Some(3_723_456));
    }
}
