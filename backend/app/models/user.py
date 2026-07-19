"""Staff / owner user accounts."""
from google.cloud import ndb


class User(ndb.Model):
    email = ndb.StringProperty(required=True)
    password_hash = ndb.StringProperty(required=True)
    name = ndb.StringProperty(default="")
    role = ndb.StringProperty(choices=["owner", "staff"], default="staff")
    active = ndb.BooleanProperty(default=True)
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
        }
