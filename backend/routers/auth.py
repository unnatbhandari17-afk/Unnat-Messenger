"""
Authentication endpoints: register, login, logout, current user info.
"""
import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

import models
import schemas
from database import get_db
from auth import hash_password, verify_password, create_access_token, get_current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=schemas.Token)
def register(data: schemas.UserRegister, db: Session = Depends(get_db)):
    existing_email = db.query(models.User).filter(models.User.email == data.email).first()
    if existing_email:
        raise HTTPException(status_code=400, detail="Email already exists")

    existing_username = db.query(models.User).filter(models.User.username == data.username).first()
    if existing_username:
        raise HTTPException(status_code=400, detail="Username already exists")

    user = models.User(
        username=data.username,
        email=data.email,
        hashed_password=hash_password(data.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token(user.id)
    return {"access_token": token, "token_type": "bearer", "user": user}


@router.post("/login", response_model=schemas.Token)
def login(data: schemas.UserLogin, db: Session = Depends(get_db)):
    user = (
        db.query(models.User)
        .filter(
            (models.User.username == data.username_or_email)
            | (models.User.email == data.username_or_email)
        )
        .first()
    )
    if not user or not verify_password(data.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid username/email or password")

    user.is_online = True
    user.last_seen = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    db.commit()

    token = create_access_token(user.id, remember_me=data.remember_me)
    return {"access_token": token, "token_type": "bearer", "user": user}


@router.post("/logout")
def logout(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    current_user.is_online = False
    current_user.last_seen = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    db.commit()
    return {"detail": "Logged out successfully"}


@router.get("/me", response_model=schemas.UserOut)
def get_me(current_user: models.User = Depends(get_current_user)):
    return current_user
