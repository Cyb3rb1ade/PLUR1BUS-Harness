//! Original MIT benchmark fixture; the generated README states the contract.
use std::collections::BTreeMap;
use std::io::{self, Read};
fn main() {
    let mut text = String::new();
    if io::stdin().read_to_string(&mut text).is_err() {
        std::process::exit(2);
    }
    let mut words = BTreeMap::<String, (usize, usize)>::new();
    let mut start = None;
    for (index, ch) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        if ch.is_whitespace() {
            if let Some(first) = start.take() {
                let entry = words
                    .entry(text[first..index].to_lowercase())
                    .or_insert((0, first));
                entry.0 += 1;
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    for (word, (count, first)) in words {
        println!("{word}\t{count}\t{first}");
    }
}
