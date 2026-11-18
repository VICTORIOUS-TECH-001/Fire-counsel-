from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "FIRE COUNSEL API"
    environment: str = "development"
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-2.5-flash"
    firebase_project_id: str | None = None
    firebase_service_account_json: str | None = None
    database_url: str | None = None
    cors_origins: str = ""
    max_context_items: int = 8
    max_question_chars: int = 6000

    @property
    def allowed_origins(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
