"""
User endpoints: profile management, search, blocking.
"""
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import models
import schemas
from database import get_db
from auth import get_current_user, verify_password, hash_password

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/search", response_model=List[schemas.UserPublic])
def search_users(q: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    if not q or len(q) < 1:
        return []
    results = (
        db.query(models.User)
        .filter(models.User.username.ilike(f"%{q}%"))
        .filter(models.User.id != current_user.id)
        .limit(20)
        .all()
    )
    return results


@router.get("/{user_id}", response_model=schemas.UserPublic)
def get_user(user_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.put("/me", response_model=schemas.UserOut)
def update_profile(
    data: schemas.UserUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if data.about is not None:
        current_user.about = data.about
    if data.status_text is not None:
        current_user.status_text = data.status_text
    if data.theme is not None:
        if data.theme not in ("light", "dark"):
            raise HTTPException(status_code=400, detail="Theme must be 'light' or 'dark'")
        current_user.theme = data.theme
    db.commit()
    db.refresh(current_user)
    return current_user


@router.put("/me/password")
def change_password(
    data: schemas.PasswordChange,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if not verify_password(data.old_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Old password is incorrect")
    current_user.hashed_password = hash_password(data.new_password)
    db.commit()
    return {"detail": "Password updated successfully"}


@router.post("/block", response_model=schemas.UserPublic)
def block_user(
    data: schemas.BlockAction,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if data.user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot block yourself")
    target = db.query(models.User).filter(models.User.id == data.user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    existing = (
        db.query(models.BlockedUser)
        .filter(models.BlockedUser.blocker_id == current_user.id, models.BlockedUser.blocked_id == data.user_id)
        .first()
    )
    if not existing:
        db.add(models.BlockedUser(blocker_id=current_user.id, blocked_id=data.user_id))
        db.commit()
    return target


@router.post("/unblock", response_model=schemas.UserPublic)
def unblock_user(
    data: schemas.BlockAction,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    db.query(models.BlockedUser).filter(
        models.BlockedUser.blocker_id == current_user.id,
        models.BlockedUser.blocked_id == data.user_id,
    ).delete()
    db.commit()
    target = db.query(models.User).filter(models.User.id == data.user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    return target


@router.get("/me/blocked", response_model=List[schemas.UserPublic])
def list_blocked(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    blocked_ids = [
        b.blocked_id
        for b in db.query(models.BlockedUser).filter(models.BlockedUser.blocker_id == current_user.id).all()
    ]
    if not blocked_ids:
        return []
    return db.query(models.User).filter(models.User.id.in_(blocked_ids)).all()
