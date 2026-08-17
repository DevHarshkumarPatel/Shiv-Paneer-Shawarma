"""Customer reviews: the public form, and the owner's side of it.

The public half is deliberately open. There is no customer login, so asking one
to prove who they are before saying the shawarma was cold would cost more
reviews than it would save. The protections are structural instead: an order id
can be reviewed exactly once, answers are validated against the owner's live
question set (anything else in the payload is dropped), and free text is capped.

The owner half is the form builder plus the read-out: every response, and the
summary the owner actually acts on — the average, the star spread, the NPS, and
for each question what people picked.
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import require_owner
from ..models import Order, Review, ReviewAnswer, ReviewQuestion, Setting
from ..models.review import CHOICE_TYPES, QUESTION_TYPES, TEXT_TYPES
from ..schemas.models import (
    ReorderPayload, ReviewQuestionPayload, ReviewSettingsPayload, ReviewSubmitRequest,
)
from ..services.scratch import norm_phone

router = APIRouter(tags=["reviews"])

TEXT_LIMIT = 1500          # a paragraph, not an essay; keeps one entity small
MAX_CHOICES = 40           # guards a checkbox answer sending the whole dictionary


# --------------------------------------------------------------- public ----
@router.get("/api/review/form")
def review_form(order_id: str = ""):
    """Everything the review page needs in one call.

    `enabled` is the honest answer to "can this person leave a review right
    now": the switch is on, and there is at least one question to answer. A page
    with a heading and no questions is worse than no page.
    """
    s = Setting.singleton()
    questions = ReviewQuestion.ordered(active_only=True)
    enabled = bool(s.reviews_enabled) and bool(questions)

    order_info, already = None, False
    pid = (order_id or "").upper().strip()
    if pid:
        order = Order.by_public_id(pid)
        if order:
            order_info = {
                "public_id": order.public_id,
                "name": order.customer.name if order.customer else "",
                "phone": order.customer.phone if order.customer else "",
                "status": order.status,
                "total": order.total,
                "items": [i.name for i in order.items][:4],
            }
            already = Review.for_order(order.public_id) is not None

    return {
        "enabled": enabled,
        "title": s.review_title or "How did we do?",
        "intro": s.review_intro or "",
        "thanks": s.review_thanks or "",
        "google_url": s.review_google_url or "",
        "questions": [q.to_dict() for q in questions],
        "order": order_info,
        "already_reviewed": already,
    }


def _clean_answer(q: ReviewQuestion, raw) -> ReviewAnswer | None:
    """Turn one submitted answer into a stored one, or None if it is blank.

    Blank is not an error here — "did not answer" is a legitimate outcome for an
    optional question, and the required check happens in the caller with the
    question's wording to hand.
    """
    ans = ReviewAnswer(question_id=q.key.id(), question=q.text, qtype=q.qtype)

    if q.qtype == "rating":
        if raw is None or raw.score is None:
            return None
        top = q.scale_max or 5
        if not 1 <= raw.score <= top:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                f"“{q.text}” takes a rating from 1 to {top}.")
        ans.score = raw.score

    elif q.qtype == "nps":
        if raw is None or raw.score is None:
            return None
        if not 0 <= raw.score <= 10:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"“{q.text}” takes a score from 0 to 10.")
        ans.score = raw.score

    elif q.qtype == "yes_no":
        if raw is None or raw.score is None:
            return None
        ans.score = 1 if raw.score else 0

    elif q.qtype in CHOICE_TYPES:
        picked = [c for c in (raw.choices if raw else [])[:MAX_CHOICES] if c in (q.options or [])]
        if not picked:
            return None
        if q.qtype == "single":
            picked = picked[:1]
        ans.choices = picked

    elif q.qtype in TEXT_TYPES:
        text = (raw.text if raw else "").strip()[:TEXT_LIMIT]
        if not text:
            return None
        ans.text = text

    else:                       # a type that no longer exists: ignore it
        return None

    return ans


@router.post("/api/review")
def submit_review(body: ReviewSubmitRequest):
    s = Setting.singleton()
    questions = ReviewQuestion.ordered(active_only=True)
    if not s.reviews_enabled or not questions:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Reviews are closed right now.")

    # One review per order. Checked before anything is written, so a double tap
    # on a slow connection cannot land two copies.
    pid = (body.order_public_id or "").upper().strip()
    if pid:
        if not Order.by_public_id(pid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "We could not find that order id.")
        if Review.for_order(pid):
            raise HTTPException(status.HTTP_409_CONFLICT, "This order has already been reviewed. Thank you!")

    submitted = {a.question_id: a for a in body.answers}
    answers: list[ReviewAnswer] = []
    for q in questions:
        ans = _clean_answer(q, submitted.get(q.key.id()))
        if ans is None:
            if q.required:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Please answer: {q.text}")
            continue
        answers.append(ans)

    if not answers:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please answer at least one question.")

    review = Review(
        order_public_id=pid,
        name=(body.name or "").strip()[:60],
        phone=norm_phone(body.phone),
        rating=next((a.score for a in answers if a.qtype == "rating"), None),
        nps=next((a.score for a in answers if a.qtype == "nps"), None),
        answers=answers,
    )
    review.put()
    return {"ok": True, "id": review.key.id(), "thanks": s.review_thanks or "Thank you!",
            "rating": review.rating, "google_url": s.review_google_url or ""}


# ------------------------------------------------- owner: the question set ----
@router.get("/api/admin/reviews/questions")
def list_questions(_owner=Depends(require_owner)):
    s = Setting.singleton()
    return {
        "questions": [q.to_dict() for q in ReviewQuestion.ordered()],
        "settings": {
            "reviews_enabled": s.reviews_enabled,
            "review_title": s.review_title or "",
            "review_intro": s.review_intro or "",
            "review_thanks": s.review_thanks or "",
            "review_google_url": s.review_google_url or "",
        },
    }


def _validate_question(body: ReviewQuestionPayload) -> list[str]:
    if not (body.text or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Type the question you want to ask.")
    if body.qtype not in QUESTION_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick an answer type for this question.")
    options = [o.strip() for o in (body.options or []) if o.strip()][:MAX_CHOICES]
    if body.qtype in CHOICE_TYPES and len(options) < 2:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "A choice question needs at least two options to pick from.")
    return options


def _next_sort_order() -> int:
    rows = ReviewQuestion.ordered()
    return (rows[-1].sort_order or 0) + 1 if rows else 0


@router.post("/api/admin/reviews/questions")
def create_question(body: ReviewQuestionPayload, _owner=Depends(require_owner)):
    options = _validate_question(body)
    q = ReviewQuestion(
        text=body.text.strip(), help_text=body.help_text.strip(), qtype=body.qtype,
        options=options, scale_max=body.scale_max, required=body.required,
        active=body.active, sort_order=body.sort_order or _next_sort_order(),
    )
    q.put()
    return q.to_dict()


@router.put("/api/admin/reviews/questions/{question_id}")
def update_question(question_id: int, body: ReviewQuestionPayload, _owner=Depends(require_owner)):
    q = ReviewQuestion.get_by_id(question_id)
    if not q:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Question not found.")
    options = _validate_question(body)
    q.text = body.text.strip()
    q.help_text = body.help_text.strip()
    q.qtype = body.qtype
    q.options = options
    q.scale_max = body.scale_max
    q.required = body.required
    q.active = body.active
    q.sort_order = body.sort_order
    q.put()
    return q.to_dict()


@router.delete("/api/admin/reviews/questions/{question_id}")
def delete_question(question_id: int, _owner=Depends(require_owner)):
    """Removing a question does not touch the answers already given to it — they
    carry their own copy of the wording, so past responses stay readable."""
    q = ReviewQuestion.get_by_id(question_id)
    if q:
        q.key.delete()
    return {"ok": True}


@router.post("/api/admin/reviews/questions/reorder")
def reorder_questions(body: ReorderPayload, _owner=Depends(require_owner)):
    for pos, qid in enumerate(body.order):
        q = ReviewQuestion.get_by_id(qid)
        if q:
            q.sort_order = pos
            q.put()
    return {"questions": [q.to_dict() for q in ReviewQuestion.ordered()]}


@router.put("/api/admin/reviews/settings")
def update_review_settings(body: ReviewSettingsPayload, _owner=Depends(require_owner)):
    s = Setting.singleton()
    s.reviews_enabled = body.reviews_enabled
    s.review_title = body.review_title.strip()[:120] or "How did we do?"
    s.review_intro = body.review_intro.strip()[:200]
    s.review_thanks = body.review_thanks.strip()[:200] or "Thank you!"
    s.review_google_url = body.review_google_url.strip()[:400]
    s.put()
    return s.to_dict()


# ----------------------------------------------------- owner: the read-out ----
def _summarise(reviews: list[Review], questions: list[ReviewQuestion]) -> dict:
    """Per-question aggregates, keyed by question id.

    Built from the answers rather than from the questions, so a question the
    owner has since deleted still reports what it collected while it was live.
    """
    buckets: dict[int, dict] = {}
    known = {q.key.id(): q for q in questions}

    for r in reviews:
        for a in r.answers or []:
            b = buckets.setdefault(a.question_id, {
                "question_id": a.question_id,
                "question": a.question,
                "qtype": a.qtype,
                "answers": 0,
                "counts": {},        # option / score -> how many
                "total": 0,          # for the average of a score question
                "texts": [],
                "removed": a.question_id not in known,
            })
            b["answers"] += 1
            if a.qtype in ("rating", "nps"):
                b["counts"][str(a.score)] = b["counts"].get(str(a.score), 0) + 1
                b["total"] += a.score or 0
            elif a.qtype == "yes_no":
                key = "Yes" if a.score else "No"
                b["counts"][key] = b["counts"].get(key, 0) + 1
            elif a.qtype in CHOICE_TYPES:
                for c in a.choices or []:
                    b["counts"][c] = b["counts"].get(c, 0) + 1
            elif a.text:
                b["texts"].append({"text": a.text, "name": r.name, "at": r.created_at.isoformat() if r.created_at else None})

    out = []
    for b in buckets.values():
        if b["qtype"] in ("rating", "nps") and b["answers"]:
            b["average"] = round(b["total"] / b["answers"], 2)
        else:
            b["average"] = None
        b["texts"] = b["texts"][:50]
        # Live questions first, in the owner's own order; retired ones after.
        q = known.get(b["question_id"])
        b["_sort"] = (0, q.sort_order or 0, b["question_id"]) if q else (1, 0, b["question_id"])
        out.append(b)
    out.sort(key=lambda b: b.pop("_sort"))
    return {"questions": out}


@router.get("/api/admin/reviews/responses")
def list_responses(_owner=Depends(require_owner), days: int = 90, limit: int = 300):
    """Every review in the window, newest first, plus the numbers on top of it."""
    reviews = sorted(
        Review.query(), key=lambda r: r.created_at or datetime.min, reverse=True,
    )
    if days > 0:
        cutoff = datetime.utcnow() - timedelta(days=days)
        reviews = [r for r in reviews if r.created_at and r.created_at >= cutoff]
    reviews = reviews[:max(1, limit)]

    rated = [r.rating for r in reviews if r.rating]
    nps_scores = [r.nps for r in reviews if r.nps is not None]
    promoters = sum(1 for n in nps_scores if n >= 9)
    detractors = sum(1 for n in nps_scores if n <= 6)

    stats = {
        "reviews": len(reviews),
        "rated": len(rated),
        "avg_rating": round(sum(rated) / len(rated), 2) if rated else None,
        "happy_share": round(sum(1 for r in rated if r >= 4) / len(rated) * 100) if rated else None,
        "unhappy": sum(1 for r in rated if r <= 2),
        "stars": {str(n): sum(1 for r in rated if r == n) for n in range(1, 6)},
        "nps": round((promoters - detractors) / len(nps_scores) * 100) if nps_scores else None,
        "nps_responses": len(nps_scores),
        "with_order": sum(1 for r in reviews if r.order_public_id),
        "window_days": days,
    }

    return {
        "reviews": [r.to_dict() for r in reviews],
        "stats": stats,
        "summary": _summarise(reviews, ReviewQuestion.ordered()),
    }


@router.delete("/api/admin/reviews/responses/{review_id}")
def delete_response(review_id: int, _owner=Depends(require_owner)):
    r = Review.get_by_id(review_id)
    if r:
        r.key.delete()
    return {"ok": True}
