import requests
from typing import Any, Dict, List, Optional

API_BASE = "https://api.torn.com"


def _get(path: str, params: Dict[str, Any], timeout: int = 25) -> Dict[str, Any]:
    url = f"{API_BASE}{path}"
    r = requests.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    return r.json()


def me_basic(api_key: str) -> Dict[str, Any]:
    """
    Validate key + get user_id + name.
    """
    data = _get("/user/", {"selections": "basic", "key": api_key})
    if "error" in data:
        raise ValueError(data["error"].get("error", "Torn API error"))
    return data


def company_profile(api_key: str, company_id: str) -> Dict[str, Any]:
    """
    Fetch a company's profile+employees.
    Torn supports: /company/ with id parameter.
    """
    data = _get(
        "/company/",
        {"selections": "profile,employees", "id": company_id, "key": api_key},
    )
    if "error" in data:
        raise ValueError(data["error"].get("error", "Torn API error"))
    return data


def normalize_company(company_id: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Make output stable for the userscript:
    { id, name, director, employees:[{id,name}] }
    """
    profile = raw.get("company") or raw.get("profile") or raw.get("company_profile") or {}
    employees_block = raw.get("company_employees") or raw.get("employees") or {}

    # name / director fields vary a bit across Torn responses
    name = profile.get("name") or profile.get("company_name") or ""
    director = profile.get("director") or profile.get("director_name") or profile.get("president") or ""

    employees: List[Dict[str, Any]] = []
    if isinstance(employees_block, dict):
        # employees often keyed by id: {"123":{"name":"X",...}, ...}
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
        "director": director,
        "employees": employees,
    }
