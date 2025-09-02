# Seller API Integration Guide

## Generating HMAC-SHA512 Signature in Python

To authenticate requests to the Seller API, you must generate a signature using HMAC-SHA512. Below is a Python function example that demonstrates how to generate the required signature and timestamp.

### Function Example

```python
import hmac
import hashlib
import base64
from datetime import datetime, timezone

ACCESS_KEY = "your_access_key"
SECRET_KEY = "your_secret_key"

def generate_signature(path: str):
    """
    Generate an HMAC-SHA512 signature for API authentication.

    Args:
        path (str): The API endpoint path (e.g., "/rest/transaction/get").

    Returns:
        tuple:
            - signature (str): The base64-encoded HMAC-SHA512 signature.
            - timestamp (str): The UTC timestamp used in the signature (format: YYYYMMDDHHMM).
    """
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    to_sign = f"{path}{ACCESS_KEY}{timestamp}"

    hmac_digest = hmac.new(
        key=SECRET_KEY.encode("utf-8"),
        msg=to_sign.encode("utf-8"),
        digestmod=hashlib.sha512
    ).hexdigest()

    signature = base64.b64encode(hmac_digest.encode("utf-8")).decode("utf-8")
    return signature, timestamp
```

### How to Use

1. Replace `ACCESS_KEY` and `SECRET_KEY` with your credentials.
2. Call `generate_signature(path)` with the API endpoint path you are accessing.
3. Use the returned `signature` and `timestamp` as query parameters in your API request.

#### Example Usage

```python
path = "/rest/transaction/get"
signature, timestamp = generate_signature(path)

params = {
    "access_token": ACCESS_KEY,
    "timestamp": timestamp,
    "sign": signature,
    # ... other parameters ...
}
```

### Notes

- The `timestamp` must be in UTC and formatted as `YYYYMMDDHHMM`.
- The signature is valid only for a short period (typically 1 minute).
- Always use the exact path string as required by the API. 