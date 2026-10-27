"""Staff / owner user accounts."""
from google.cloud import ndb


class User(ndb.Model):
    email = ndb.StringProperty(required=True)
    password_hash = ndb.StringProperty(required=True)
    name = ndb.StringProperty(default="")
    role = ndb.StringProperty(choices=["owner", "staff"], default="staff")
    active = ndb.BooleanProperty(default=True)
    # The one branch a staff login works at. Read from this row on every
    # request, never from anything the browser sends, so moving someone to
    # another branch takes effect on their next click. None means Main (rows
    # written before branches existed). Ignored for the owner, who sees all.
    branch_id = ndb.IntegerProperty()
    created_at = ndb.DateTimeProperty(auto_now_add=True)

    @classmethod
    def by_email(cls, email: str) -> "User | None":
        return cls.query(cls.email == email.lower().strip()).get()

    def to_public(self) -> dict:
        return {
            "id": self.key.id(),
            "email": self.email,
            "name": self.name,
            "role": self.role,
            "branch_id": self.branch_id,
        }
