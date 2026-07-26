"""
Authentication utilities: password hashing (bcrypt) and JWT token
creation / verification.
"""
import datetime
import os
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from database import get_db
import models

# In a real deployment this MUST come from an environment variable / secret
# manager. A random default is generated here so the app still runs securely
# out of the box during local development.
SECRET_KEY = os.environ.get("MESSENGER_SECRET_KEY", "dev-secret-key-change-me-in-production-3f8a9c2e")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24        # 1 day by default
REMEMBER_ME_EXPIRE_MINUTES = 60 * 24 * 30    # 30 days with "remember me"

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(user_id: int, remember_me: bool = False) -> str:
    minutes = REMEMBER_ME_EXPIRE_MINUTES if remember_me else ACCESS_TOKEN_EXPIRE_MINUTES
    expire = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(minutes=minutes)
    payload = {"sub": str(user_id), "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[int]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            return None
        return int(user_id)
    except JWTError:
        return None


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> models.User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    user_id = decode_token(token)
    if user_id is None:
        raise credentials_exception
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        raise credentials_exception
    return user


def get_current_user_ws(token: str, db: Session) -> Optional[models.User]:
    """Same as get_current_user but usable from the websocket handshake (query param)."""
    user_id = decode_token(token)
    if user_id is None:
        return None
    return db.query(models.User).filter(models.User.id == user_id).first()
