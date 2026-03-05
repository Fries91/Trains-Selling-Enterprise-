import requests
from typing import Any, Dict, List

API_BASE = "https://api.torn.com"


def _get(path: str, params: Dict[str, Any], timeout: int = 25) -> Dict[str, Any]:
    url = f"{API_BASE}{path}"
    r = requests.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    return r.json()


def me_basic(api_key: str) -> Dict[str, Any]:
    data = _get("/user/", {"selections": "basic", "key": api_key})
    if "error" in data:
        raise ValueError(data["error"].get("error", "Torn API error"))
    return data


def company_profile(api_key: str, company_id: str) -> Dict[str, Any]:
    data = _get(
        "/company/",
        {"selections": "profile,employees", "id": company_id, "key": api_key},
    )
    if "error" in data:
        raise ValueError(data["error"].get("error", "Torn API error"))
    return data


def normalize_company(company_id: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Stable output for your userscript:
    { id, name, director, employees:[{id,name}] }
    """
    # Torn responses can vary; support multiple shapes
    profile = raw.get("company") or raw.get("profile") or raw.get("company_profile") or raw or {}
    employees_block = raw.get("company_employees") or raw.get("employees") or {}

    name = profile.get("name") or profile.get("company_name") or ""
    director = profile.get("director") or profile.get("director_name") or ""

    employees: List[Dict[str, str]] = []

    # Most common: dict keyed by player id
    if isinstance(employees_block, dict):
        for k, v in employees_block.items():
            if not isinstance(v, dict):
                continue
            employees.append(
                {
                    "id": str(v.get("id") or k),
                    "name": str(v.get("name") or v.get("username") or "Unknown"),
                }
            )
    elif isinstance(employees_block, list):
        for v in employees_block:
            if not isinstance(v, dict):
                continue
            employees.append(
                {
                    "id": str(v.get("id") or v.get("torn_id") or ""),
                    "name": str(v.get("name") or v.get("username") or "Unknown"),
                }
            )

    employees.sort(key=lambda e: (e.get("name") or "").lower())

    return {
        "id": str(company_id),
        "name": name or f"Company #{company_id}",
        "director": director or "",
        "employees": employees,
    }
