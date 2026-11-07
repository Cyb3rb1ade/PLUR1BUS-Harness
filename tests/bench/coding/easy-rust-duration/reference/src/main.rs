//! Original MIT benchmark fixture; the generated README states the contract.
fn seconds(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let (mut at, mut previous, mut total) = (0, 4, 0u64);
    while at < bytes.len() {
        if !bytes[at].is_ascii_digit() {
            return None;
        }
        let mut value = 0u64;
        while at < bytes.len() && bytes[at].is_ascii_digit() {
            value = value
                .checked_mul(10)?
                .checked_add(u64::from(bytes[at] - b'0'))?;
            at += 1;
        }
        let (rank, multiplier) = match bytes.get(at) {
            Some(b'h') => (3, 3600),
            Some(b'm') => (2, 60),
            Some(b's') => (1, 1),
            _ => return None,
        };
        if rank >= previous {
            return None;
        }
        previous = rank;
        total = total.checked_add(value.checked_mul(multiplier)?)?;
        at += 1;
    }
    Some(total)
}
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    let parsed = if args.len() == 2 {
        args[1].to_str().and_then(seconds)
    } else {
        None
    };
    match parsed {
        Some(value) => println!("{value}"),
        None => {
            eprintln!("invalid duration");
            std::process::exit(2);
        }
    }
}
