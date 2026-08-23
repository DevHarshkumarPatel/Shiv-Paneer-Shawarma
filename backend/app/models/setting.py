"""Global store settings — a single-row entity holding shop-wide switches.

Holds the owner's shop-wide switches: whether customers may order at all,
whether the offer banners show, and how the scratch card behaves. Kept as a
fixed-id singleton so there is always exactly one row to read and update.
"""
from google.cloud import ndb

_SINGLETON_ID = "global"


class Setting(ndb.Model):
    ordering_enabled = ndb.BooleanProperty(default=True)
    # Master switch for the checkout scratch card. Off by default: the card must
    # not appear before the owner has put prizes in the batch.
    scratch_enabled = ndb.BooleanProperty(default=False)
    # What happens when the batch is used up: print the same batch again, or
    # stop showing cards until the owner decides. Off by default, because a
    # give-away that silently restarts is not a give-away the owner budgeted.
    scratch_repeat_batch = ndb.BooleanProperty(default=False)
    scratch_batch_no = ndb.IntegerProperty(default=1)   # how many batches in

    # --- Offer banners --------------------------------------------------
    # The offer bands, strips and running-offer line on the public pages. On by
    # default. Turning this off only silences the advertising: a promo that is
    # active still discounts the cart, so the owner can run a quiet offer, or
    # clear the pages during a rush, without editing a single promo.
    promo_banners_enabled = ndb.BooleanProperty(default=True)

    # --- Review page ---------------------------------------------------
    # On by default, but the page only actually opens once the owner has written
    # at least one active question, so nothing is shown before there is
    # something to ask (see routers/reviews.py).
    reviews_enabled = ndb.BooleanProperty(default=True)
    review_title = ndb.StringProperty(default="How did we do?")
    review_intro = ndb.StringProperty(default="A few quick taps — under a minute, and it helps us a lot.")
    review_thanks = ndb.StringProperty(default="Thank you! Your feedback goes straight to the kitchen.")
    # Optional "write it on Google too" link, offered only after a happy review.
    review_google_url = ndb.StringProperty(default="")

    updated_at = ndb.DateTimeProperty(auto_now=True)

    @classmethod
    def singleton(cls) -> "Setting":
        """Return the one settings row, creating it (ordering on) if missing."""
        s = cls.get_by_id(_SINGLETON_ID)
        if s is None:
            s = cls(id=_SINGLETON_ID)
            s.put()
        return s

    def to_dict(self) -> dict:
        return {
            "ordering_enabled": self.ordering_enabled,
            "scratch_enabled": self.scratch_enabled,
            "scratch_repeat_batch": self.scratch_repeat_batch,
            "scratch_batch_no": self.scratch_batch_no or 1,
            "promo_banners_enabled": self.promo_banners_enabled,
            "reviews_enabled": self.reviews_enabled,
            "review_title": self.review_title or "",
            "review_intro": self.review_intro or "",
            "review_thanks": self.review_thanks or "",
            "review_google_url": self.review_google_url or "",
        }
