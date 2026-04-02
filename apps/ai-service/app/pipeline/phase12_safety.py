import json
from typing import Any, Callable

from app.pipeline.safety import SafetyViolationError, safety_check_config as run_safety_scan


def _extract_json(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


async def safety_check_config(
    config_version_id: str,
    config_json: dict[str, Any],
    write_audit: Callable[[dict[str, Any]], Any],
    update_config_status: Callable[[str, str], Any],
) -> dict[str, Any]:
    result = run_safety_scan(config_json)

    await write_audit(
        {
            "entity_type": "config_version",
            "entity_id": config_version_id,
            "action": "safety_check",
            "after_state": {
                "safe": bool(result.get("safe", False)),
                "violations": result.get("violations", []),
                "recommendation": result.get("recommendation", "review"),
            },
        }
    )

    if not result.get("safe", False):
        await update_config_status(config_version_id, "blocked")
        raise SafetyViolationError(list(result.get("violations", [])))

    await update_config_status(config_version_id, "pending_review")
    return result
