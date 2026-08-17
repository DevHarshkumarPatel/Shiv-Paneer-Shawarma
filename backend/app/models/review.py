"""Customer reviews: the owner's question set, and the answers people give.

The owner writes the form — any number of questions, each of a type that suits
what is being asked: stars for "how was the food", a checkbox list for "what did
you like", a text box for anything free-form. Nothing about the form is
hard-coded here, so changing what the shop asks never needs a code change.

Answers are stored with the question **frozen into them** (its text and type at
the moment it was answered). Questions get reworded and deleted; a stored answer
has to keep saying what it was actually an answer to, the same way an old bill
keeps the offer it was billed under.

`ReviewAnswer` is a LocalStructuredProperty rather than a StructuredProperty
because it itself holds a repeated field (`choices`, for checkbox answers), and
NDB does not allow a repeated StructuredProperty to contain repeated
sub-properties. LocalStructuredProperty serialises the sub-entity, so the
nesting is fine — and answers are only ever read back with their review, never
queried on their own.
"""
from google.cloud import ndb

# rating   — stars, 1..scale_max
# nps      — 0..10 "would you recommend" scale
# single   — radio buttons, exactly one option
# multi    — checkboxes, any number of options
# yes_no   — two buttons, stored as score 1/0
# short_text / long_text — free text (one line / paragraph)
QUESTION_TYPES = ["rating", "nps", "single", "multi", "yes_no", "short_text", "long_text"]

CHOICE_TYPES = ("single", "multi")
SCORE_TYPES = ("rating", "nps", "yes_no")
TEXT_TYPES = ("short_text", "long_text")


class ReviewQuestion(ndb.Model):
    text = ndb.StringProperty(required=True)
    help_text = ndb.StringProperty(default="")       # optional one-line hint
    qtype = ndb.StringProperty(choices=QUESTION_TYPES, default="rating")
    # Choices for single/multi. Also used by long_text, where they become
    # one-tap chips that drop a phrase into the box — most people will tap a
    # word but never type a sentence.
    options = ndb.StringProperty(repeated=True)
    scale_max = ndb.IntegerProperty(default=5)       # stars in a rating question
    required = ndb.BooleanProperty(default=False)
    active = ndb.BooleanProperty(default=True)
    sort_order = ndb.IntegerProperty(default=0)
    created_at = ndb.DateTimeProperty(auto_now_add=True)

    @classmethod
    def ordered(cls, active_only: bool = False) -> list["ReviewQuestion"]:
        rows = [q for q in cls.query() if q.active or not active_only]
        return sorted(rows, key=lambda q: (q.sort_order, q.key.id()))

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "text": self.text,
            "help_text": self.help_text or "",
            "qtype": self.qtype,
            "options": list(self.options or []),
            "scale_max": self.scale_max or 5,
            "required": bool(self.required),
            "active": bool(self.active),
            "sort_order": self.sort_order or 0,
        }


class ReviewAnswer(ndb.Model):
    question_id = ndb.IntegerProperty()
    question = ndb.StringProperty(default="")     # frozen wording
    qtype = ndb.StringProperty(default="")
    score = ndb.IntegerProperty()                 # rating / nps / yes_no (1|0)
    text = ndb.TextProperty(default="")
    choices = ndb.StringProperty(repeated=True)

    def to_dict(self) -> dict:
        return {
            "question_id": self.question_id,
            "question": self.question,
            "qtype": self.qtype,
            "score": self.score,
            "text": self.text or "",
            "choices": list(self.choices or []),
        }


class Review(ndb.Model):
    """One filled-in form.

    `rating` and `nps` are lifted out of the answers so the owner's list can be
    sorted and averaged without unpacking every answer on every read. They are a
    copy of the first rating / NPS answer, not a separate thing to fill in.
    """

    order_public_id = ndb.StringProperty(default="")
    name = ndb.StringProperty(default="")
    phone = ndb.StringProperty(default="")        # normalised, last 10 digits
    rating = ndb.IntegerProperty()
    nps = ndb.IntegerProperty()
    answers = ndb.LocalStructuredProperty(ReviewAnswer, repeated=True)
    created_at = ndb.DateTimeProperty(auto_now_add=True)

    @classmethod
    def for_order(cls, public_id: str) -> "Review | None":
        pid = (public_id or "").upper().strip()
        if not pid:
            return None
        return cls.query(cls.order_public_id == pid).get()

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "order_public_id": self.order_public_id or "",
            "name": self.name or "",
            "phone": self.phone or "",
            "rating": self.rating,
            "nps": self.nps,
            "answers": [a.to_dict() for a in (self.answers or [])],
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
