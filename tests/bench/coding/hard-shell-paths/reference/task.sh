#!/bin/sh
# Original MIT benchmark fixture; the generated README states the contract.
awk '
    {
        if ($0 == "" || substr($0, 1, 1) == "/" || $0 ~ /^[A-Za-z]:/ || index($0, "\\")) {
            bad = 1; next
        }
        count = split($0, parts, "/"); normalized = ""
        for (i = 1; i <= count; i++) {
            if (parts[i] == "" || parts[i] == "..") { bad = 1 }
            if (parts[i] != ".") { normalized = normalized (normalized == "" ? "" : "/") parts[i] }
        }
        if (normalized == "") { bad = 1 }
        result[++size] = normalized
    }
    END {
        if (bad) { exit 2 }
        for (i = 1; i <= size; i++) { print result[i] }
    }
'
