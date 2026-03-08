from typing import Any, Dict, List

import requests

API_BASE = "https://api.torn.com"


def _get(path: str, params: Dict[str, Any], timeout: int = 25) -> Dict[str, Any]:
    url = f"{API_BASE}{path}"
    r = requests.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    if "error" in data:
        raise ValueError(data["error"].get("error", "Torn API error"))
    return data


def me_basic(api_key: str) -> Dict[str, Any]:
    return _get("/user/", {"selections": "basic", "key": api_key})


def company_profile(api_key: str, company_id: str) -> Dict[str, Any]:
    return _get("/company/", {"selections": "profile,employees", "id": company_id, "key": api_key})


def normalize_company(company_id: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    profile = raw.get("company") or raw.get("profile") or raw.get("company_profile") or raw or {}
    employees_block = raw.get("company_employees") or raw.get("employees") or {}

    name = profile.get("name") or profile.get("company_name") or f"Company #{company_id}"
    director = profile.get("director") or profile.get("director_name") or ""

    employees: List[Dict[str, Any]] = []

    if isinstance(employees_block, dict):
        for k, v in employees_block.items():
            if not isinstance(v, dict):
                continue
            man = int(v.get("manual_labor") or v.get("man") or 0)
            intl = int(v.get("intelligence") or v.get("int") or 0)
            end = int(v.get("endurance") or v.get("end") or 0)
            employees.append({
                "id": str(v.get("id") or k),
                "name": str(v.get("name") or v.get("username") or "Unknown"),
                "manual_labor": man,
                "intelligence": intl,
                "endurance": end,
            })
    elif isinstance(employees_block, list):
        for v in employees_block:
            if not isinstance(v, dict):
                continue
            man = int(v.get("manual_labor") or v.get("man") or 0)
            intl = int(v.get("intelligence") or v.get("int") or 0)
            end = int(v.get("endurance") or v.get("end") or 0)
            employees.append({
                "id": str(v.get("id") or v.get("torn_id") or ""),
                "name": str(v.get("name") or v.get("username") or "Unknown"),
                "manual_labor": man,
                "intelligence": intl,
                "endurance": end,
            })

    employees.sort(key=lambda e: (e.get("name") or "").lower())

    return {
        "id": str(company_id),
        "name": name,
        "director": director,
        "employees": employees,
    }
