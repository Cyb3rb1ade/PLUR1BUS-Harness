#!/bin/sh
# Original MIT benchmark fixture; the generated README states the contract.
[ "$#" -eq 2 ] && [ -f "$1" ] || exit 2
[ ! -L "$2" ] || exit 2
if [ -e "$2" ] && [ ! -f "$2" ]; then exit 2; fi
input=$1; output=$2
case "$input" in /*|./*|../*) ;; *) input=./$input;; esac
case "$output" in /*|./*|../*) ;; *) output=./$output;; esac
parent=${output%/*}
umask 077
temporary=$(mktemp "$parent/.coding-export.XXXXXXXX") || exit 2
trap 'rm -f -- "$temporary"' 0
trap 'exit 2' 1 2 15
awk -v add=BENCH_CONST '
    length($0) == 0 { next }
    $0 !~ /^[0-9]+$/ || length($0) > 9 { exit 2 }
    { printf "%s\t%.0f\n", $0, $0 + add }
' < "$input" > "$temporary" || exit 2
if [ -f "$output" ]; then
    mode=$(stat -c '%a' "$output" 2>/dev/null || stat -f '%Lp' "$output" 2>/dev/null) || exit 2
    chmod "$mode" "$temporary" || exit 2
fi
mv -f -- "$temporary" "$output" || exit 2
