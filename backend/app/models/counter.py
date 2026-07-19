"""Transactional sequence counter (used for human-friendly order numbers)."""
from google.cloud import ndb


class Counter(ndb.Model):
    value = ndb.IntegerProperty(default=0)

    @classmethod
    @ndb.transactional()
    def next_value(cls, name: str) -> int:
        """Atomically increment and return the counter identified by `name`."""
        counter = cls.get_by_id(name)
        if counter is None:
            counter = cls(id=name, value=0)
        counter.value += 1
        counter.put()
        return counter.value
