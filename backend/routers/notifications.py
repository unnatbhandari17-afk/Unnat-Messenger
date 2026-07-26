"""
Notification endpoints: list and mark as read.
"""
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import desc

import models
import schemas
from database import get_db
from auth import get_current_user

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("", response_model=List[schemas.NotificationOut])
def list_notifications(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (
        db.query(models.Notification)
        .filter(models.Notification.user_id == current_user.id)
        .order_by(desc(models.Notification.created_at))
        .limit(50)
        .all()
    )


@router.put("/{notification_id}/read")
def mark_notification_read(notification_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    notif = (
        db.query(models.Notification)
        .filter(models.Notification.id == notification_id, models.Notification.user_id == current_user.id)
        .first()
    )
    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")
    notif.is_read = True
    db.commit()
    return {"detail": "marked as read"}


@router.put("/read-all")
def mark_all_read(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    db.query(models.Notification).filter(models.Notification.user_id == current_user.id, models.Notification.is_read == False).update({"is_read": True})
    db.commit()
    return {"detail": "all marked as read"}
