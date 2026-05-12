import os
from pathlib import Path

DEFAULT_PORT = int(os.getenv("PORT", "8080"))
BASE_DIR = Path(__file__).parent


def greet(name: str) -> str:
    return f"hello, {name}"


class UserService:
    def __init__(self, name: str) -> None:
        self.name = name

    def hello(self) -> str:
        return greet(self.name)
