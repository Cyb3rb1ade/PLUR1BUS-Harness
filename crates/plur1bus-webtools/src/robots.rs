//! Crawl directives using deterministic segment matching.
pub(crate) const MAX_BYTES: usize = 500 * 1024;
pub const MAX_CRAWL_DELAY_SECONDS: f64 = 30.;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TooLarge;

struct Rule {
    allow: bool,
    pattern: String,
    weight: usize,
}

#[derive(Default)]
struct Group {
    agents: Vec<String>,
    rules: Vec<Rule>,
    delay: Option<f64>,
}

pub struct Robots {
    groups: Vec<Group>,
}

impl Robots {
    pub fn parse(body: &str) -> Result<Self, TooLarge> {
        if body.len() > MAX_BYTES {
            return Err(TooLarge);
        }
        let mut groups = Vec::<Group>::new();
        let mut last_was_agent = false;
        for raw in body.lines() {
            let line = raw.split_once('#').map_or(raw, |(before, _)| before).trim();
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim_end();
            if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-') {
                continue;
            }
            let value = value.trim();
            if key.eq_ignore_ascii_case("user-agent") {
                if groups.is_empty() || !last_was_agent {
                    groups.push(Group::default());
                }
                if let Some(group) = groups.last_mut().filter(|_| !value.is_empty()) {
                    group.agents.push(value.to_lowercase());
                }
                last_was_agent = true;
                continue;
            }
            last_was_agent = false;
            let Some(group) = groups.last_mut() else {
                continue;
            };
            let allow = key.eq_ignore_ascii_case("allow");
            if allow || key.eq_ignore_ascii_case("disallow") {
                if !value.is_empty() {
                    group.rules.push(Rule {
                        allow,
                        pattern: value.into(),
                        weight: value
                            .encode_utf16()
                            .filter(|word| *word != u16::from(b'*'))
                            .count(),
                    });
                }
            } else if key.eq_ignore_ascii_case("crawl-delay") {
                if let Some(delay) = delay_seconds(value) {
                    group.delay = Some(delay.min(MAX_CRAWL_DELAY_SECONDS));
                }
            }
        }
        Ok(Self { groups })
    }

    pub fn crawl_delay_seconds(&self, user_agent: &str) -> Option<f64> {
        self.applicable(user_agent).find_map(|group| group.delay)
    }

    pub fn allows(&self, user_agent: &str, path: &str) -> bool {
        let mut best: Option<&Rule> = None;
        for rule in self.applicable(user_agent).flat_map(|group| &group.rules) {
            if pattern_matches(&rule.pattern, path)
                && best.is_none_or(|old| {
                    rule.weight > old.weight || (rule.weight == old.weight && rule.allow)
                })
            {
                best = Some(rule);
            }
        }
        best.is_none_or(|rule| rule.allow)
    }

    fn applicable(&self, user_agent: &str) -> impl Iterator<Item = &Group> {
        let token = user_agent
            .trim_start()
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let specific = |group: &Group| {
            group
                .agents
                .iter()
                .any(|agent| agent != "*" && token.starts_with(agent))
        };
        let has_specific = self.groups.iter().any(specific);
        self.groups.iter().filter(move |group| {
            if has_specific {
                group
                    .agents
                    .iter()
                    .any(|agent| agent != "*" && token.starts_with(agent))
            } else {
                group.agents.iter().any(|agent| agent == "*")
            }
        })
    }
}

fn delay_seconds(text: &str) -> Option<f64> {
    if text.is_empty() {
        return Some(0.);
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if text
            .get(..2)
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
        {
            let digits = &text[2..];
            if digits.is_empty() {
                return None;
            }
            let mut number = 0.;
            for digit in digits.chars() {
                number = number * f64::from(radix) + f64::from(digit.to_digit(radix)?);
            }
            return number.is_finite().then_some(number);
        }
    }
    text.parse::<f64>()
        .ok()
        .filter(|number| number.is_finite() && *number >= 0.)
}

fn pattern_matches(pattern: &str, path: &str) -> bool {
    let literal = pattern.strip_suffix('$').unwrap_or(pattern);
    let anchored = literal.len() != pattern.len();
    let mut parts = literal.split('*').peekable();
    let Some(mut remaining) = path.strip_prefix(parts.next().unwrap_or_default()) else {
        return false;
    };
    if parts.peek().is_none() {
        return !anchored || remaining.is_empty();
    }
    while let Some(part) = parts.next() {
        if anchored && parts.peek().is_none() {
            return remaining.ends_with(part);
        }
        if part.is_empty() {
            continue;
        }
        let Some((_, suffix)) = remaining.split_once(part) else {
            return false;
        };
        remaining = suffix;
    }
    true
}
