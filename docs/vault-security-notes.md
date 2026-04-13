# Vault Security Enhancement Options

## Current State
- 6-digit numeric code (000000-999999) = 1,000,000 combinations
- 30-minute expiration
- One-time use (destroyed after claim)
- Direct download URL: `/api/vault/{code}/download`

## Risk Assessment

**Brute Force Feasibility:**
- 1 million combinations is relatively small
- With 100 req/s, can scan 6M codes in 60 seconds
- 30-minute window gives attacker significant time

## Recommended Solutions

### Option 1: Rate Limiting (Quick Fix)
Add rate limiting per IP to slow down brute force attempts.

**Pros:** Simple to implement
**Cons:** Can be bypassed with distributed attacks

### Option 2: Longer Code with Mixed Characters
Change from 6-digit numeric to 8-character alphanumeric.

- 6 digits: 10^6 = 1,000,000 combinations
- 8 alphanumeric: 36^8 = 2.8 trillion combinations

**Pros:** Exponentially harder to brute force
**Cons:** Harder for users to type/remember

### Option 3: Add Download Token
Require a time-limited, single-use token for downloads.

Flow:
1. Query metadata with code → returns download token
2. Download requires both code + token
3. Token expires in 5 minutes, single use

**Pros:** Even if code is guessed, download is protected
**Cons:** Slightly more complex implementation

### Option 4: CAPTCHA on Failed Attempts
Show CAPTCHA after 3 failed attempts.

**Pros:** Effectively stops automated brute force
**Cons:** Adds friction for legitimate users

## Recommended Implementation

**Short term:** Option 1 (Rate Limiting) + Option 2 (Longer Code)
**Long term:** Option 3 (Download Token) for high-security scenarios

## Implementation Example: Rate Limiting

```python
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["200 per day", "50 per hour"]
)

@app.route("/api/vault/<code>", methods=["GET"])
@limiter.limit("10 per minute")  # Max 10 queries per minute per IP
def vault_query(code: str):
    ...

@app.route("/api/vault/<code>/download", methods=["GET"])
@limiter.limit("5 per minute")  # Max 5 downloads per minute per IP
def vault_download(code: str):
    ...
```

## Implementation Example: 8-Character Alphanumeric Code

```python
def generate_vault_code() -> str:
    """Generate 8-char alphanumeric code."""
    chars = string.ascii_uppercase + string.digits  # A-Z, 0-9
    while True:
        code = ''.join(random.choices(chars, k=8))
        if not get_vault_by_code(code):
            return code
```

This gives 36^8 = 2,821,109,907,456 combinations - effectively unbrute-forceable.
