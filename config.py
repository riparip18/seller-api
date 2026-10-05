import os

# Credential profiles. Pick one with VC_PROFILE (default: "default").
PROFILES = {
    "default": {
        "access_key": "ulXzIoUbsIPPLptdAESv",
        "secret_key": "3452ed3b5ac6461a9d62be4ae4349eb7",
    },
    "secondary": {
        "access_key": "XHYglQagyPPMsQtIYNur",
        "secret_key": "15b555c7b9204d629e0f650eeeabcfc1",
    },
}

PROFILE_NAME = os.environ.get("VC_PROFILE", "default")
if PROFILE_NAME not in PROFILES:
    raise ValueError(f'Unknown VC_PROFILE "{PROFILE_NAME}". Valid: {", ".join(PROFILES)}')

ACCESS_KEY = PROFILES[PROFILE_NAME]["access_key"]
SECRET_KEY = PROFILES[PROFILE_NAME]["secret_key"]
BASE_URL = "https://apis.vcg.my.id"
