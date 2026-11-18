"""Firebase ID-token verification. Protected routes fail closed if unconfigured."""
import json
from functools import lru_cache

import firebase_admin
from firebase_admin import auth, credentials
from fastapi import Header, HTTPException

from .config import get_settings


@lru_cache
def _firebase_app():
    settings = get_settings()
    if firebase_admin._apps:
        return firebase_admin.get_app()
    options = {"projectId": settings.firebase_project_id} if settings.firebase_project_id else None
    if settings.firebase_service_account_json:
        info = json.loads(settings.firebase_service_account_json)
        cred = credentials.Certificate(info)
        return firebase_admin.initialize_app(cred, options=options)
    try:
        return firebase_admin.initialize_app(options=options)
    except ValueError:
        return firebase_admin.get_app()


def require_user(authorization: str | None = Header(default=None)) -> dict:
    settings = get_settings()
    if not settings.firebase_project_id and not settings.firebase_service_account_json:
        raise HTTPException(status_code=503, detail="Firebase authentication is not configured.")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="A Firebase ID token is required.")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="A Firebase ID token is required.")
    try:
        _firebase_app()
        return auth.verify_id_token(token, check_revoked=True)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="The Firebase ID token is invalid or expired.") from exc
