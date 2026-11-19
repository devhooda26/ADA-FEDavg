#!/bin/sh
# Downloads NSL-KDD (KDDTrain+ / KDDTest+) into data/nsl-kdd/
set -e
D="$(dirname "$0")/../data/nsl-kdd"; mkdir -p "$D"
B="https://raw.githubusercontent.com/jmnwong/NSL-KDD-Dataset/master"
for f in KDDTrain%2B.txt KDDTest%2B.txt; do
  n=$(printf '%s' "$f" | sed 's/%2B/+/')
  [ -s "$D/$n" ] || curl -fL --retry 3 -o "$D/$n" "$B/$f"
done
wc -l "$D"/*.txt
