#!/bin/sh
# Original MIT benchmark fixture; the generated README states the contract.
[ "$#" -eq 1 ] && [ -d "$1" ] || exit 2
for file in $1/*.txt; do
    [ -f "$file" ] || continue
    printf '%s\t%s\n' "${file##*/}" "$(wc -l < "$file" | tr -d ' ')"
done
