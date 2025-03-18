#!/usr/bin/env bash
export URL=https://remitly.linuxdweller.com
# Email + password of user to create.
export PAYLOAD='{"email": "friedman@example.com", "password": "example123"}'

# Create user.
curl -X POST --json "$PAYLOAD" "$URL/users"

# Login and save token.
export JWT=$(curl -X POST --json "$PAYLOAD" "$URL/users/login" | jq '.token' --raw-output)

echo $JWT
