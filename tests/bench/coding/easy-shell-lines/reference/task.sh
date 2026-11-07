#!/bin/sh
# Original MIT benchmark fixture; the generated README states the contract.
[ "$#" -eq 1 ] && [ -d "$1" ] || exit 2
for file in "$1"/*.txt; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    count=$(awk 'END { print NR+0 }' < "$file") || exit 2
    printf '%s\t%s\n' "${file##*/}" "$count"
done | LC_ALL=C sort
