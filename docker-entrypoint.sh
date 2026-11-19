#!/bin/sh
set -e
# Fetch NSL-KDD into the persistent volume on first start (experiments need it).
if [ ! -s data/nsl-kdd/KDDTrain+.txt ] || [ ! -s data/nsl-kdd/KDDTest+.txt ]; then
  echo "NSL-KDD not found, downloading..."
  ./scripts/get_dataset.sh || echo "WARNING: dataset download failed; experiments will report 'dataset_missing' until it is installed."
fi
exec node src/server.js
