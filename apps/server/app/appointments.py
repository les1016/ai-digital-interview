"""Persistent half-hour booking and admission rules for student interviews.

All stored datetime values are naive UTC. The appointment timezone controls the
calendar-day and overnight quotas; the daytime rolling quota uses seven elapsed
24-hour periods. Each quota class is determined from the scheduled slot start.
"""

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import CheckConstraint, DateTime, Index, String, and_, or_, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column


SLOT = timedelta(minutes=30)
CHECK_IN_GRACE = timedelta(minutes=5)
REFILL_GRACE = timedelta(minutes=10)
MAX_INTERVIEW_DURATION = timedelta(minutes=20)
BOOKING_HORIZON = timedelta(days=7)
ROLLING_PERIOD = timedelta(days=7)
DEFAULT_APPOINTMENT_TIMEZONE = "Asia/Shanghai"
DAILY_LIMIT = 1
ROLLING_LIMIT = 3
BOOKED = "booked"
CHECKED_IN = "checked_in"
FINISHED = "finished"
CANCELLED = "cancelled"


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def as_utc_naive(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo is not None else value


def utc_string(value: datetime | None) -> str | None:
    return as_utc_naive(value).isoformat() + "Z" if value is not None else None


class AppointmentBase(DeclarativeBase):
    pass


class BookingMutex(AppointmentBase):
    __tablename__ = "interview_booking_mutex"

    id: Mapped[int] = mapped_column(primary_key=True)
    revision: Mapped[int]


class Appointment(AppointmentBase):
    __tablename__ = "interview_appointments"
    __table_args__ = (
        Index("ix_appointment_user_started", "user_id", "started_at"),
        CheckConstraint("status IN ('booked','checked_in','finished','cancelled')"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int]
    start_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    check_in_by: Mapped[datetime] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(16), default=BOOKED)
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime)
    interview_id: Mapped[int | None] = mapped_column(unique=True)


def init_appointments(engine: Engine) -> None:
    # Serialize the independent schema/seed initialization across app workers.
    with engine.begin() as conn:
        if conn.dialect.name == "sqlite":
            conn.exec_driver_sql("BEGIN IMMEDIATE")
        elif conn.dialect.name == "postgresql":
            conn.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": 1396919376})
        AppointmentBase.metadata.create_all(conn)
        if conn.scalar(select(BookingMutex.id).where(BookingMutex.id == 1)) is None:
            conn.execute(BookingMutex.__table__.insert().values(id=1, revision=0))


def lock_booking(db: Session) -> None:
    """Acquire a DB write lock through transaction end (SQLite and PostgreSQL)."""
    result = db.execute(
        update(BookingMutex).where(BookingMutex.id == 1)
        .values(revision=1 - BookingMutex.revision)
        .execution_options(synchronize_session=False, autoflush=False)
    )
    if result.rowcount != 1:
        raise HTTPException(503, "预约服务暂不可用")


def _active_at(now: datetime):
    return or_(
        and_(Appointment.status == BOOKED, Appointment.check_in_by > now),
        and_(Appointment.status == CHECKED_IN, Appointment.ends_at > now),
    )


def get_admission(db: Session, user_id: int, now: datetime | None = None) -> Appointment | None:
    now = as_utc_naive(now) if now is not None else utc_now()
    return db.scalar(select(Appointment).where(
        Appointment.user_id == user_id, Appointment.status == CHECKED_IN,
        Appointment.started_at <= now, Appointment.ends_at > now,
    ).execution_options(populate_existing=True))


def appointment_for_interview(db: Session, interview_id: int) -> Appointment | None:
    return db.scalar(select(Appointment).where(Appointment.interview_id == interview_id)
                     .execution_options(populate_existing=True))


def attach_interview(
    db: Session, appointment: Appointment | int, user_id: int, interview_id: int,
    now: datetime | None = None,
) -> Appointment:
    # Re-check after acquiring the lock. In particular, the model may have
    # returned after a signed-in user's slot expired while awaiting its reply.
    appointment_id = appointment if isinstance(appointment, int) else appointment.id
    lock_booking(db)
    live = get_admission(db, user_id, now)
    if live is None or live.id != appointment_id:
        raise HTTPException(409, "预约未签到或本场面试时间已结束")
    if live.interview_id not in (None, interview_id):
        raise HTTPException(409, "此预约已关联另一场面试")
    live.interview_id = interview_id
    return live


def end_admission(db: Session, interview_id: int, now: datetime | None = None) -> Appointment | None:
    lock_booking(db)
    appointment = appointment_for_interview(db, interview_id)
    if appointment is not None and appointment.status == CHECKED_IN:
        end = as_utc_naive(now) if now is not None else utc_now()
        appointment.status = FINISHED
        appointment.ended_at = min(end, appointment.ends_at)
    return appointment


def detach_interview(db: Session, interview_id: int, now: datetime | None = None) -> None:
    """Retain admission history if an interview is deleted or its ID reused."""
    appointment = end_admission(db, interview_id, now)
    if appointment is not None:
        appointment.interview_id = None


def _appointment_dto(row: Appointment, *, overnight: bool) -> dict:
    return {
        "id": row.id,
        "start_at": utc_string(row.start_at),
        "check_in_by": utc_string(row.check_in_by),
        "status": row.status,
        "started_at": utc_string(row.started_at),
        "ends_at": utc_string(row.ends_at),
        "interview_id": row.interview_id,
        "refill": row.check_in_by > row.start_at + CHECK_IN_GRACE,
        "overnight": overnight,
    }


class BookAppointmentPayload(BaseModel):
    start_at: datetime

    @field_validator("start_at", mode="before")
    @classmethod
    def parse_aware_iso(cls, value):
        if not isinstance(value, str) or not 16 <= len(value) <= 40:
            raise ValueError("请提供含时区的 ISO 8601 时间")
        try:
            parsed = datetime.fromisoformat(value)
            if parsed.utcoffset() is not None:
                return as_utc_naive(parsed)
        except (ValueError, OverflowError) as exc:
            raise ValueError("请提供含时区的 ISO 8601 时间") from exc
        raise ValueError("请提供含时区的 ISO 8601 时间")


@dataclass(frozen=True)
class QuotaRemaining:
    daytime_today: int
    daytime_rolling: int
    overnight_today: int

    def available(self, overnight: bool) -> bool:
        if overnight:
            return self.overnight_today > 0
        return self.daytime_today > 0 and self.daytime_rolling > 0


@dataclass(frozen=True)
class QuotaPolicy:
    zone: ZoneInfo
    night_start_hour: int
    night_end_hour: int
    night_daily_limit: int

    def __post_init__(self):
        if (type(self.night_start_hour) is not int or type(self.night_end_hour) is not int
                or not 0 <= self.night_start_hour < self.night_end_hour <= 24):
            raise ValueError("Overnight appointment hours must satisfy 0 <= start < end <= 24")
        if type(self.night_daily_limit) is not int or self.night_daily_limit < 1:
            raise ValueError("Overnight appointment daily limit must be a positive integer")

    def _local(self, when: datetime) -> datetime:
        return when.replace(tzinfo=timezone.utc).astimezone(self.zone)

    def overnight(self, slot_start: datetime) -> bool:
        return self.night_start_hour <= self._local(slot_start).hour < self.night_end_hour

    def recent_usage(self, db: Session, user_id: int, now: datetime) -> tuple[list[datetime], list[datetime]]:
        # Keep the indexed elapsed 7-day bound. Night usage needs only the
        # current local date and therefore also lies inside this bound.
        rows = db.execute(select(Appointment.start_at, Appointment.started_at).where(
            Appointment.user_id == user_id, Appointment.started_at > now - ROLLING_PERIOD,
            Appointment.started_at <= now,
        ))
        daytime, overnight = [], []
        for slot_start, admitted_at in rows:
            (overnight if self.overnight(slot_start) else daytime).append(admitted_at)
        return daytime, overnight

    def remaining(self, usage: tuple[list[datetime], list[datetime]], when: datetime) -> QuotaRemaining:
        daytime, overnight = usage
        midnight = datetime.combine(self._local(when).date(), time.min, tzinfo=self.zone)
        day_start = as_utc_naive(midnight)
        daytime_today = sum(day_start <= started <= when for started in daytime)
        daytime_rolling = sum(when - ROLLING_PERIOD < started <= when for started in daytime)
        overnight_today = sum(day_start <= started <= when for started in overnight)
        return QuotaRemaining(
            max(0, DAILY_LIMIT - daytime_today),
            max(0, ROLLING_LIMIT - daytime_rolling),
            max(0, self.night_daily_limit - overnight_today),
        )

    def enforce(self, usage: tuple[list[datetime], list[datetime]], when: datetime, *, overnight: bool) -> None:
        remaining = self.remaining(usage, when)
        if overnight:
            if not remaining.overnight_today:
                raise HTTPException(409, f"同一账号每天凌晨最多面试 {self.night_daily_limit} 次")
        elif not remaining.daytime_today:
            raise HTTPException(409, "同一账号每天常规时段最多面试一次")
        elif not remaining.daytime_rolling:
            raise HTTPException(409, "同一账号滚动 7 天内常规时段最多面试三次")

    def dto(self, row: Appointment) -> dict:
        return _appointment_dto(row, overnight=self.overnight(row.start_at))


def _slot_floor(value: datetime) -> datetime:
    return value.replace(minute=(value.minute // 30) * 30, second=0, microsecond=0)


def _valid_slot(now: datetime, start: datetime) -> bool:
    return (
        _slot_floor(now) <= start <= now + BOOKING_HORIZON
        and start == _slot_floor(start)
        and now < start + REFILL_GRACE
    )


def _missed_user(db: Session, start: datetime, now: datetime) -> int | None:
    # Only the current slot can be refilled, once its original grace has passed.
    if not start + CHECK_IN_GRACE <= now < start + REFILL_GRACE:
        return None
    return db.scalar(select(Appointment.user_id).where(
        Appointment.start_at == start, Appointment.check_in_by == start + CHECK_IN_GRACE,
        Appointment.status == BOOKED, Appointment.started_at.is_(None),
    ).limit(1))


def _slot_claimed(now: datetime):
    # A completed interview never opens a second admission in the same slot.
    return or_(Appointment.started_at.is_not(None), _active_at(now))


def _owned_appointment(db: Session, user_id: int, appointment_id: int) -> Appointment:
    appointment = db.scalar(select(Appointment).where(
        Appointment.id == appointment_id, Appointment.user_id == user_id,
    ).execution_options(populate_existing=True))
    if appointment is None:
        raise HTTPException(404, "找不到这条预约")
    return appointment


def _active_booking(db: Session, user_id: int, now: datetime) -> Appointment | None:
    return db.scalar(select(Appointment).where(Appointment.user_id == user_id, _active_at(now)))


def install_appointment_routes(
    app, current_user, get_db, *, timezone_name=DEFAULT_APPOINTMENT_TIMEZONE, clock=utc_now,
    night_start_hour=0, night_end_hour=7, night_daily_limit=3,
):
    policy = QuotaPolicy(ZoneInfo(timezone_name), night_start_hour, night_end_hour, night_daily_limit)

    @app.get("/api/appointments")
    def get_appointments(response: Response, user=Depends(current_user), db: Session = Depends(get_db)):
        now = as_utc_naive(clock())
        response.headers["Cache-Control"] = "private, no-store"
        active = _active_booking(db, user.id, now)
        usage = policy.recent_usage(db, user.id, now)
        remaining = policy.remaining(usage, now)
        slot = _slot_floor(now)
        horizon = now + BOOKING_HORIZON
        claimed = set(db.scalars(select(Appointment.start_at).where(
            Appointment.start_at >= slot, Appointment.start_at <= horizon, _slot_claimed(now),
        )))
        missed = _missed_user(db, slot, now)
        slots = []
        while slot <= horizon:
            refill = now >= slot + CHECK_IN_GRACE
            if _valid_slot(now, slot) and (not refill or missed is not None):
                overnight = policy.overnight(slot)
                slots.append({
                    "start_at": utc_string(slot),
                    "check_in_by": utc_string(slot + (REFILL_GRACE if refill else CHECK_IN_GRACE)),
                    "available": (
                        slot not in claimed and (not refill or missed != user.id)
                        and policy.remaining(usage, max(slot, now)).available(overnight)
                    ),
                    "refill": refill,
                    "overnight": overnight,
                })
            slot += SLOT
        return {
            "now": utc_string(now), "timezone": timezone_name, "slots": slots,
            "active": policy.dto(active) if active else None,
            "remaining_today": remaining.daytime_today, "remaining_7_days": remaining.daytime_rolling,
            "overnight": {
                "start_hour": policy.night_start_hour, "end_hour": policy.night_end_hour,
                "daily_limit": policy.night_daily_limit, "remaining_today": remaining.overnight_today,
            },
        }

    @app.post("/api/appointments", status_code=201)
    def book_appointment(payload: BookAppointmentPayload, user=Depends(current_user), db: Session = Depends(get_db)):
        lock_booking(db)
        now = as_utc_naive(clock())
        start = payload.start_at
        if not _valid_slot(now, start):
            raise HTTPException(409, "请选择未来七天内或尚未过签到时间的半小时时段")
        refill = now >= start + CHECK_IN_GRACE
        if refill:
            missed = _missed_user(db, start, now)
            if missed is None or missed == user.id:
                raise HTTPException(409, "该时段已过普通签到时间，只有其他账号可接替未签到的名额")
        if _active_booking(db, user.id, now) is not None:
            raise HTTPException(409, "已有有效预约，请先取消或完成它")
        policy.enforce(policy.recent_usage(db, user.id, now), max(now, start), overnight=policy.overnight(start))
        if db.scalar(select(Appointment.id).where(Appointment.start_at == start, _slot_claimed(now)).limit(1)):
            raise HTTPException(409, "该时段名额已被预约，请选择其他时段")
        row = Appointment(user_id=user.id, start_at=start,
                          check_in_by=start + (REFILL_GRACE if refill else CHECK_IN_GRACE), status=BOOKED)
        db.add(row)
        db.flush()
        result = policy.dto(row)
        db.commit()
        return result

    @app.post("/api/appointments/{appointment_id}/cancel")
    def cancel_appointment(appointment_id: int, user=Depends(current_user), db: Session = Depends(get_db)):
        lock_booking(db)
        now = as_utc_naive(clock())
        row = _owned_appointment(db, user.id, appointment_id)
        if row.status != CANCELLED:
            if row.status != BOOKED or now >= row.start_at:
                raise HTTPException(409, "只可在预约时段开始前取消，已签到的面试不能取消")
            row.status = CANCELLED
        result = policy.dto(row)
        db.commit()
        return result

    @app.post("/api/appointments/{appointment_id}/check-in")
    def check_in(appointment_id: int, user=Depends(current_user), db: Session = Depends(get_db)):
        lock_booking(db)
        now = as_utc_naive(clock())
        row = _owned_appointment(db, user.id, appointment_id)
        if row.status == BOOKED:
            if now < row.start_at:
                raise HTTPException(409, "预约时段尚未开始，请到时间再签到")
            if now >= row.check_in_by:
                raise HTTPException(409, "已超过签到截止时间，该预约已失效")
            policy.enforce(policy.recent_usage(db, user.id, now), now, overnight=policy.overnight(row.start_at))
            row.status = CHECKED_IN
            row.started_at = now
            row.ends_at = min(now + MAX_INTERVIEW_DURATION, row.start_at + CHECK_IN_GRACE + MAX_INTERVIEW_DURATION)
        elif row.status != CHECKED_IN or row.ends_at <= now:
            raise HTTPException(409, "该预约已取消、完成或到期")
        result = policy.dto(row)
        db.commit()
        return result
