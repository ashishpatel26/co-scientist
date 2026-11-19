from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CS_", env_file=".env", extra="ignore")

    llm_model: str = "qwen3.5-4b-16k"
    embed_model: str = "nomic-embed-text"
    embed_dim: int = 768
    data_dir: str = "./data"
    max_revisions: int = 1
    papers_per_query: int = 10
    top_k_evidence: int = 8
    fulltext_papers: int = 3  # top-ranked papers whose PDF is read
    fulltext_budget_s: float = 20.0  # hard ceiling so end-to-end p95 stays < 3 min
    workers: int = 2
    api_key: str = ""  # empty = auth off
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    fake_llm: bool = False  # canned outputs for tests / Playwright


settings = Settings()
