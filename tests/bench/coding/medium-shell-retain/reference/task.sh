#!/bin/sh
# Original MIT benchmark fixture; the generated README states the contract.
[ "$#" -eq 2 ] && [ -d "$1" ] || exit 2
case "$2" in ''|*[!0-9]*) exit 2;; esac
directory=$1
case "$directory" in /*|./*|../*) ;; *) directory=./$directory;; esac
{
    for file in "$directory"/snap-*.dat; do
        [ -f "$file" ] && [ ! -L "$file" ] || continue
        name=${file##*/}
        stamp=${name#snap-}; stamp=${stamp%.dat}
        case "$stamp" in ''|*[!0-9]*) continue;; esac
        [ "${#stamp}" -le 9 ] || continue
        printf '%s\t%s\n' "$stamp" "$name"
    done
} | LC_ALL=C sort -k1,1nr -k2,2 | awk -F '\t' -v keep="$2" 'NR > keep { print $2 }' |
while IFS= read -r name; do
    rm -f -- "$directory/$name" || exit 2
done
