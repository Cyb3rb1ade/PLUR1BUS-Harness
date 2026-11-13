//! The parts of JavaScript's `Date.parse` and `Date#toISOString` that the TypeScript sources rest on, written by hand
//! (no regular-expression dependency). The configuration validator needs them for the timestamp of a privacy
//! acknowledgment; the core's log query (`logs/query.rs`) uses the same functions, and its vectors
//! (`fixtures/parity/logs/query.json`) pin them.
//!
//! `date_parse` reads the ECMAScript date-time format (also with a space or lower-case `t`/`z`, and an offset written
//! `+HHMM`, as V8 does), not V8's legacy fallback (`Oct 7, 2026`, `2026/10/07`, RFC 2822 text): such a text is `None`
//! here. A form without a zone is read as UTC.

const DAY_MS: i64 = 86_400_000;
/// `TimeClip`: the largest magnitude of a JavaScript time value.
pub const MAX_TIME: i64 = 8_640_000_000_000_000;

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1 to 12, day may exceed the month: it rolls over).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + (day - 1)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `new Date(ms).toISOString()`, or `None` for a time value outside `TimeClip`'s range (a `RangeError`).
pub fn iso_string(ms: i64) -> Option<String> {
    if ms.abs() > MAX_TIME {
        return None;
    }
    let days = ms.div_euclid(DAY_MS);
    let rem = ms.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year_text}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    ))
}

struct Scan<'a> {
    b: &'a [u8],
    i: usize,
}

impl Scan<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    /// Exactly `n` ASCII digits.
    fn digits(&mut self, n: usize) -> Option<i64> {
        let part = self.b.get(self.i..self.i + n)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.i += n;
        Some(part.iter().fold(0i64, |v, d| v * 10 + i64::from(d - b'0')))
    }

    fn done(&self) -> bool {
        self.i == self.b.len()
    }
}

/// `ZONELESS`: `YYYY-MM-DD[T ]HH:MM[:SS[.f+]]` with nothing after it, which `normalTs` reads as UTC by adding `Z`.
fn is_zoneless(s: &str) -> bool {
    let mut sc = Scan {
        b: s.as_bytes(),
        i: 0,
    };
    let head = sc.digits(4).is_some()
        && sc.eat(b'-')
        && sc.digits(2).is_some()
        && sc.eat(b'-')
        && sc.digits(2).is_some()
        && (sc.eat(b'T') || sc.eat(b' '))
        && sc.digits(2).is_some()
        && sc.eat(b':')
        && sc.digits(2).is_some();
    if !head {
        return false;
    }
    if sc.eat(b':') {
        if sc.digits(2).is_none() {
            return false;
        }
        if sc.eat(b'.') {
            let start = sc.i;
            while sc.peek().is_some_and(|c| c.is_ascii_digit()) {
                sc.i += 1;
            }
            if sc.i == start {
                return false;
            }
        }
    }
    sc.done()
}

/// The ECMAScript date-time string format as V8 reads it, to milliseconds since the epoch; `None` for anything else.
fn parse_date_time(s: &str) -> Option<i64> {
    let mut sc = Scan {
        b: s.as_bytes(),
        i: 0,
    };
    let year = match sc.peek()? {
        sign @ (b'+' | b'-') => {
            sc.i += 1;
            let y = sc.digits(6)?;
            if sign == b'-' {
                if y == 0 {
                    return None;
                }
                -y
            } else {
                y
            }
        }
        _ => sc.digits(4)?,
    };
    let (mut month, mut day) = (1, 1);
    let mut has_day = false;
    if sc.eat(b'-') {
        month = sc.digits(2)?;
        if !(1..=12).contains(&month) {
            return None;
        }
        if sc.eat(b'-') {
            day = sc.digits(2)?;
            if !(1..=31).contains(&day) {
                return None;
            }
            has_day = true;
        }
    }
    let (mut hour, mut minute, mut second, mut milli) = (0, 0, 0, 0);
    let mut offset_min = 0;
    if !sc.done() {
        if !has_day || !(sc.eat(b'T') || sc.eat(b't') || sc.eat(b' ')) {
            return None;
        }
        hour = sc.digits(2)?;
        if !sc.eat(b':') {
            return None;
        }
        minute = sc.digits(2)?;
        if sc.eat(b':') {
            second = sc.digits(2)?;
            if sc.eat(b'.') {
                let start = sc.i;
                while sc.peek().is_some_and(|c| c.is_ascii_digit()) {
                    sc.i += 1;
                }
                if sc.i == start {
                    return None;
                }
                let mut digits = s.as_bytes()[start..sc.i].iter();
                for scale in [100, 10, 1] {
                    milli += digits.next().map_or(0, |d| i64::from(d - b'0')) * scale;
                }
            }
        }
        if hour > 24 || minute > 59 || second > 59 {
            return None;
        }
        if hour == 24 && (minute != 0 || second != 0 || milli != 0) {
            return None;
        }
        match sc.peek() {
            None => {}
            Some(b'Z' | b'z') => sc.i += 1,
            Some(sign @ (b'+' | b'-')) => {
                sc.i += 1;
                let hh = sc.digits(2)?;
                sc.eat(b':');
                let mm = sc.digits(2)?;
                if hh > 23 || mm > 59 {
                    return None;
                }
                let total = hh * 60 + mm;
                offset_min = if sign == b'+' { total } else { -total };
            }
            Some(_) => return None,
        }
        if !sc.done() {
            return None;
        }
    }
    let days = days_from_civil(year, month, 1) + (day - 1);
    let ms = days * DAY_MS + hour * 3_600_000 + minute * 60_000 + second * 1000 + milli
        - offset_min * 60_000;
    (ms.abs() <= MAX_TIME).then_some(ms)
}

/// `Date.parse(v.replace(ZONELESS, "$1T$2Z"))`: milliseconds since the epoch, or `None` (NaN).
pub fn date_parse(v: &str) -> Option<i64> {
    if is_zoneless(v) {
        let (date, time) = v.split_at(10);
        let mut fixed = String::with_capacity(v.len() + 1);
        fixed.push_str(date);
        fixed.push('T');
        fixed.push_str(&time[1..]);
        fixed.push('Z');
        parse_date_time(&fixed)
    } else {
        parse_date_time(v)
    }
}
