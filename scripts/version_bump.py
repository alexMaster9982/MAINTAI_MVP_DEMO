import json
import re
from datetime import date
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


TEXT_REPLACEMENTS = {
    "backend/core/config.py": [
        (r'VERSION = "[^"]+"', 'VERSION = "{version}"'),
        (r'BUILD_DATE = "[^"]+"', 'BUILD_DATE = "{date}"'),
    ],
    "frontend/app/lib/version.ts": [
        (r'export const VERSION = "[^"]+";', 'export const VERSION = "{version}";'),
        (r'export const BUILD_DATE = "[^"]+";', 'export const BUILD_DATE = "{date}";'),
    ],
    "AGENTS.md": [
        (
            r'Aggiornato alla versione \*\*[^*]+\*\* \([^)]+\)',
            "Aggiornato alla versione **{version}** ({date})",
        ),
    ],
    # CLAUDE.md porta la stessa intestazione di versione: senza questa voce il file
    # restava indietro rispetto al codice a ogni bump (drift 3.3.1 vs 3.3.2).
    "CLAUDE.md": [
        (
            r'Aggiornato alla versione \*\*[^*]+\*\* \([^)]+\)',
            "Aggiornato alla versione **{version}** ({date})",
        ),
    ],
}


JSON_VERSION_FILES = [
    "frontend/package.json",
    "frontend/package-lock.json",
    "frontend/src-tauri/tauri.conf.json",
    "frontend/app/lib/deploy-version.json",
]


def update_text_file(relative_path: str, version: str, build_date: str) -> None:
    path = REPO_ROOT / relative_path
    content = path.read_text(encoding="utf-8")

    for pattern, replacement in TEXT_REPLACEMENTS[relative_path]:
        content = re.sub(pattern, replacement.format(version=version, date=build_date), content)

    path.write_text(content, encoding="utf-8")


def update_json_version(relative_path: str, version: str, build_date: str) -> None:
    path = REPO_ROOT / relative_path
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version

    if relative_path == "frontend/package-lock.json":
        data["packages"][""]["version"] = version

    if relative_path == "frontend/app/lib/deploy-version.json":
        data["buildDate"] = f"{build_date}T00:00:00.000Z"
        data["source"] = "base"

    path.write_text(f"{json.dumps(data, indent=2)}\n", encoding="utf-8")


def bump_version(new_version: str) -> None:
    build_date = date.today().isoformat()

    for relative_path in TEXT_REPLACEMENTS:
        update_text_file(relative_path, new_version, build_date)

    for relative_path in JSON_VERSION_FILES:
        update_json_version(relative_path, new_version, build_date)

    print(f"Versione base MaintAI allineata a {new_version} ({build_date})")


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        raise SystemExit("Uso: python scripts/version_bump.py <versione>")

    bump_version(sys.argv[1])
