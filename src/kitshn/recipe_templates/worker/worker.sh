#!/bin/sh
set -eu

while true; do
  date -u '+worker tick %Y-%m-%dT%H:%M:%SZ'
  sleep 60
done
