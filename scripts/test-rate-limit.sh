#!/bin/bash

# Test script for rate limiting validation
# Usage: ./scripts/test-rate-limit.sh [URL]
# Default URL: http://localhost:5000/api/rl-test

URL="${1:-http://localhost:5000/api/rl-test}"

echo "Testing rate limiting on $URL"
echo "This script sends 200 requests rapidly to trigger rate limits."
echo "Expected: Some 200s initially, then 429s with RateLimit-* headers."
echo ""

COUNT_200=0
COUNT_429=0
COUNT_OTHER=0

echo "Sending requests..."

for i in {1..200}; do
  # Capture both status code and headers
  RESPONSE=$(curl -s -w "HTTPSTATUS:%{http_code};" -H "Accept: application/json" "$URL")
  HTTP_STATUS=$(echo "$RESPONSE" | tr -d '\n' | sed -e 's/.*HTTPSTATUS://' -e 's/;.*//')
  BODY=$(echo "$RESPONSE" | sed -e 's/HTTPSTATUS.*//')

  if [ "$HTTP_STATUS" -eq 200 ]; then
    COUNT_200=$((COUNT_200 + 1))
  elif [ "$HTTP_STATUS" -eq 429 ]; then
    COUNT_429=$((COUNT_429 + 1))
    # Show headers for first 429
    if [ "$COUNT_429" -eq 1 ]; then
      echo ""
      echo "First 429 response headers:"
      curl -s -I "$URL" | head -10
      echo ""
    fi
  else
    COUNT_OTHER=$((COUNT_OTHER + 1))
  fi

  # Progress indicator
  if [ $((i % 20)) -eq 0 ]; then
    echo -n "$i "
  fi
done

echo ""
echo ""
echo "Results:"
echo "200 OK responses: $COUNT_200"
echo "429 Too Many Requests: $COUNT_429"
echo "Other responses: $COUNT_OTHER"
echo ""

if [ "$COUNT_429" -gt 0 ]; then
  echo "✅ Rate limiting is working! 429 responses detected."
  echo "Check the headers above for RateLimit-* values."
else
  echo "❌ No 429 responses detected. Rate limiting may not be active."
  echo "Check if ENABLE_RL_TEST_ENDPOINT=true and the endpoint is accessible."
fi

echo ""
echo "To enable debug logging, set RATE_LIMIT_DEBUG=1 in your environment."