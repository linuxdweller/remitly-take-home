# export URL=https://remitly.linuxdweller.com
export URL=http://localhost:3000

export USER1_PAYLOAD='{"email": "from1131111111111111111@example.com", "password": "example123"}'
export USER2_PAYLOAD='{"email": "to111111311111111111@example.com", "password": "example123"}'

# Create USER1
curl -X POST --json "$USER1_PAYLOAD" "$URL/users"
# Create USER2 and save it's user ID
export USER2_ID=$(curl -X POST --json "$USER2_PAYLOAD" "$URL/users" | jq '.userId' --raw-output)

# # Get JWT of USER1.
export JWT=$(curl -X POST --json "$USER1_PAYLOAD" "$URL/users/login" | jq '.token' --raw-output)

# Send 1000 funds from USER1 to USER2
curl -X POST --json '{"ammount": 1000, "to": "$USER2_ID"}' "$URL/transactions"
